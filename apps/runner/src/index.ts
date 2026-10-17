#!/usr/bin/env node
import { homedir, userInfo } from "node:os";
import { startRunner } from "./server.ts";

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return entry.endsWith("/index.ts") || entry.endsWith("/index.js") || entry.endsWith("/engineroom-runner");
}

export async function main() {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    console.error("engineroom-runner refuses to run as root");
    process.exit(1);
  }
  const home = process.env.HOME || homedir() || userInfo().homedir;
  const args = process.argv.slice(2);
  const socketFlag = args.indexOf("--socket");
  const socketPath = socketFlag >= 0 ? args[socketFlag + 1] : undefined;
  const listenPid = Number(process.env.LISTEN_PID || 0);
  const listenFds = Number(process.env.LISTEN_FDS || 0);
  const fd = listenFds > 0 && listenPid === process.pid ? 3 : undefined;
  if (!socketPath && fd == null) {
    console.error("usage: engineroom-runner --socket PATH");
    process.exit(1);
  }
  await startRunner({ home, socketPath, fd });
  console.error(`engineroom-runner listening for ${userInfo().username}`);
}

if (invokedDirectly()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
