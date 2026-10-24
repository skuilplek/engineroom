import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { promisify } from "node:util";
import { peerCredentials } from "@engineroom/peercred";
import {
  socketPathForUser,
  type RunnerRequest,
  type RunnerResponse,
  type StreamEvent,
} from "@engineroom/protocol";

const execFileAsync = promisify(execFile);

export interface RunnerLink {
  socketDir: string;
  ctlPath?: string;
}

export async function callRunner(
  link: RunnerLink,
  username: string,
  uid: number,
  request: RunnerRequest,
  onEvent?: (event: StreamEvent) => void,
): Promise<unknown> {
  const socket = await openRunnerSocket(link, username, uid);
  const timeoutMs = request.type === "send"
    ? 30 * 60 * 1000
    : request.type === "sync_repositories"
      ? 150_000
      : request.type === "download_repo_file" || request.type === "upload_repo_file"
        ? 120_000
        : 30_000;
  return new Promise((resolve, reject) => {
    let buf = "";
    let settled = false;
    const timer = setTimeout(() => fail(new Error("runner timed out")), timeoutMs);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const succeed = (result: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.end();
      resolve(result);
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buf += chunk;
      let index = buf.indexOf("\n");
      while (index >= 0) {
        const line = buf.slice(0, index);
        buf = buf.slice(index + 1);
        index = buf.indexOf("\n");
        if (!line.trim()) continue;
        let message: RunnerResponse;
        try {
          message = JSON.parse(line) as RunnerResponse;
        } catch {
          fail(new Error("runner sent invalid JSON"));
          return;
        }
        if (message.id !== request.id) continue;
        if (message.type === "event") onEvent?.(message.event);
        else if (message.type === "ok") succeed(message.result);
        else fail(new Error(message.error || "runner error"));
      }
    });
    socket.on("error", (error) => fail(error));
    socket.on("end", () => fail(new Error("runner closed the connection")));
    socket.write(`${JSON.stringify(request)}\n`);
  });
}

export async function openRunnerSocket(link: RunnerLink, username: string, uid: number): Promise<Socket> {
  const sock = socketPathForUser(link.socketDir, username);
  await ensureSocket(link, sock, username);
  const info = await stat(sock);
  const socket = await new Promise<Socket>((resolve, reject) => {
    const client = connect(sock, () => {
      client.setNoDelay(true);
      resolve(client);
    });
    client.once("error", reject);
  });
  try {
    const peer = peerCredentials(socket);
    if (!socketIdentityOk(info.uid, peer.uid, uid)) {
      throw new Error("runner socket does not belong to the signed-in user");
    }
  } catch (error) {
    socket.destroy();
    throw error;
  }
  return socket;
}

export function socketIdentityOk(ownerUid: number, peerUid: number, expectedUid: number): boolean {
  if (ownerUid !== expectedUid) return false;
  // uid 0 is systemd while it still owns a socket-activated listener.
  return peerUid === expectedUid || peerUid === 0;
}

async function ensureSocket(link: RunnerLink, sock: string, username: string) {
  if (await exists(sock)) return;
  if (!link.ctlPath) throw new Error("runner is not running");
  await execFileAsync("sudo", ["-n", link.ctlPath, "start", username], { timeout: 20_000 });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await exists(sock)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("runner socket did not appear");
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
