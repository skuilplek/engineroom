import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openRunnerSocket } from "../apps/hub/src/runner-client.ts";
import "./peercred-helper.ts";

test("an open runner socket is used as it is", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "er-sock-"));
  const uid = process.getuid?.() ?? 1000;
  let started = 0;
  const server = createServer();
  try {
    await listen(server, path.join(root, "alice.sock"));
    const socket = await openRunnerSocket({
      socketDir: root,
      startUser: async () => {
        started += 1;
      },
    }, "alice", uid);
    assert.equal(started, 0);
    socket.end();
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a refused runner socket is started again", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "er-sock-"));
  const sock = path.join(root, "alice.sock");
  const uid = process.getuid?.() ?? 1000;
  await leaveStaleSocket(sock);
  let started = 0;
  let server: Server | undefined;
  try {
    const socket = await openRunnerSocket({
      socketDir: root,
      startUser: async () => {
        started += 1;
        await unlink(sock);
        server = createServer();
        await listen(server, sock);
      },
    }, "alice", uid);
    assert.equal(started, 1);
    socket.end();
  } finally {
    server?.close();
    await rm(root, { recursive: true, force: true });
  }
});

function listen(server: Server, sock: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(sock, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function leaveStaleSocket(sock: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { createServer } from "node:net";
      const server = createServer();
      server.listen(process.env.SOCK, () => { process.stdout.write("up\\n"); });
    `], {
      env: { ...process.env, SOCK: sock },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let buf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      if (buf.includes("up")) child.kill("SIGKILL");
    });
    child.on("exit", (code, signal) => {
      if (signal === "SIGKILL") resolve();
      else reject(new Error(`stale socket helper exited ${code ?? "none"} ${signal ?? ""}`));
    });
    child.on("error", reject);
  });
}
