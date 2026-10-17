import { spawnSync } from "node:child_process";
import type { Socket } from "node:net";

export interface PeerCredentials {
  pid: number;
  uid: number;
  gid: number;
}

export function peerCredentials(
  socket: Socket,
  helper = process.env.ENGINEROOM_PEERCRED || "/usr/local/bin/engineroom-peercred",
): PeerCredentials {
  const fd = socketFd(socket);
  const result = spawnSync(helper, [], {
    stdio: ["ignore", "pipe", "pipe", fd],
    encoding: "utf8",
    timeout: 2000,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.error?.message || "unknown error").trim();
    throw new Error(`peercred failed: ${detail}`);
  }
  const [pid, uid, gid] = result.stdout.trim().split(/\s+/).map(Number);
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || !Number.isInteger(pid)) {
    throw new Error("peercred returned an unreadable result");
  }
  return { pid, uid, gid };
}

function socketFd(socket: Socket): number {
  const handle = (socket as Socket & { _handle?: { fd?: number } })._handle;
  const fd = handle?.fd;
  if (typeof fd !== "number" || fd < 0) throw new Error("socket is not connected");
  return fd;
}
