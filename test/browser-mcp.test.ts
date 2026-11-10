import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import test from "node:test";

const script = path.resolve("apps/runner/src/browser-mcp.ts");

function start(): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [script], {
    env: {
      ...process.env,
      ENGINEROOM_RUNNER_SOCK: path.join("/tmp", "er-browser-mcp-missing.sock"),
      ENGINEROOM_BROWSER_CHAT: "chat",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function lineReader(child: ChildProcessWithoutNullStreams): () => Promise<string> {
  let buf = "";
  const queued: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let index = buf.indexOf("\n");
    while (index >= 0) {
      const line = buf.slice(0, index);
      buf = buf.slice(index + 1);
      index = buf.indexOf("\n");
      const waiter = waiting.shift();
      if (waiter) waiter(line);
      else queued.push(line);
    }
  });
  return () =>
    new Promise((resolve, reject) => {
      const line = queued.shift();
      if (line != null) {
        resolve(line);
        return;
      }
      const timer = setTimeout(() => reject(new Error("browser mcp did not answer")), 5000);
      waiting.push((next) => {
        clearTimeout(timer);
        resolve(next);
      });
    });
}

test("browser mcp speaks newline-delimited JSON like an agent expects", async () => {
  const child = start();
  const nextLine = lineReader(child);
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    const initialized = JSON.parse(await nextLine()) as {
      id?: number;
      result?: { serverInfo?: { name?: string } };
    };
    assert.equal(initialized.id, 1);
    assert.equal(initialized.result?.serverInfo?.name, "engineroom-browser");

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    const listed = JSON.parse(await nextLine()) as { id?: number; result?: { tools?: { name?: string }[] } };
    assert.equal(listed.id, 2);
    assert.equal(listed.result?.tools?.some((tool) => tool.name === "browser_navigate"), true);
  } finally {
    child.kill("SIGKILL");
  }
});
