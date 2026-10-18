import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentId } from "@engineroom/protocol";
import { AcpManager } from "../apps/runner/src/acp/manager.ts";
import type { AgentDriver } from "../apps/runner/src/drivers.ts";
import { startRunner } from "../apps/runner/src/server.ts";
import { getChat } from "../apps/runner/src/store.ts";

const fake = path.resolve("test/fake-acp.mjs");

test("an ACP session streams chunks and can import a CLI session", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "er-acp-"));
  const sock = path.join(home, "runner.sock");
  const acp = new AcpManager({
    launch: async () => ({ binary: process.execPath, args: [fake] }),
  });
  const runner = await startRunner({ home, socketPath: sock, acp, peerCheck: () => undefined });
  const live = await subscribe(sock);
  try {
    const created = await once(sock, { id: "c", type: "create_chat", agent: "cursor", workspace: home });
    const chatId = (created.result as { id: string }).id;
    live.send({ id: "w", type: "watch", chatId, lastSeq: 0 });
    await live.next((message) => message.id === "w");
    live.send({ id: "p", type: "prompt", chatId, prompt: "permit this" });
    const permission = await live.next((message) => message.event?.type === "permission_request");
    const requestId = permission.event?.type === "permission_request" ? permission.event.requestId : "";
    assert.ok(requestId);
    live.send({ id: "a", type: "permission_response", chatId, requestId, optionId: "allow-once" });
    await live.next((message) => message.event?.type === "done");
    const finished = await getChat(home, chatId, false);
    assert.equal(finished.chat.agentSessionId, "fake-session");
    assert.equal(finished.transcript.some((entry) => entry.kind === "text" && entry.text?.includes("hello")), true);
    assert.equal(finished.transcript.some((entry) => entry.kind === "tool" && entry.id === "t1"), true);

    const listed = await once(sock, { id: "ls", type: "list_sessions", agent: "cursor" });
    assert.equal((listed.result as { sessions: { sessionId: string }[] }).sessions[0]?.sessionId, "ext-1");
    const imported = await once(sock, {
      id: "im",
      type: "import_session",
      agent: "cursor",
      agentSessionId: "ext-1",
      workspace: home,
    });
    assert.equal((imported.result as { needsResync?: boolean }).needsResync, true);
  } finally {
    live.close();
    await runner.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("a follow-up prompt waits until the running turn finishes", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "er-queue-"));
  const sock = path.join(home, "runner.sock");
  let release: () => void = () => undefined;
  const drivers: Record<AgentId, AgentDriver> = {
    cursor: {
      id: "cursor",
      async run(ctx) {
        ctx.onEvent({ type: "text_delta", text: ctx.prompt });
        if (ctx.prompt === "first") {
          await new Promise<void>((resolve) => {
            release = resolve;
            ctx.onEvent({ type: "status", text: "holding" });
          });
        }
        ctx.onEvent({ type: "done", agentSessionId: "s" });
        return { agentSessionId: "s" };
      },
    },
    claude: { id: "claude", async run() { throw new Error("not used"); } },
    pi: { id: "pi", async run() { throw new Error("not used"); } },
  };
  const runner = await startRunner({ home, socketPath: sock, drivers, peerCheck: () => undefined });
  try {
    const created = await once(sock, { id: "c", type: "create_chat", agent: "cursor", workspace: home });
    const chatId = (created.result as { id: string }).id;
    await once(sock, { id: "s1", type: "send", chatId, prompt: "first" });
    let holding = false;
    for (let attempt = 0; attempt < 50 && !holding; attempt += 1) {
      const live = await once(sock, { id: `p${attempt}`, type: "get_chat", chatId });
      const entries = (live.result as { transcript: Array<{ text?: string }> }).transcript;
      holding = entries.some((entry) => entry.text === "holding");
      if (!holding) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(holding, true);
    const queued = await once(sock, { id: "s2", type: "send", chatId, prompt: "second" });
    assert.equal((queued.result as { queued?: boolean }).queued, true);
    release();
    let sawSecond = false;
    for (let attempt = 0; attempt < 50 && !sawSecond; attempt += 1) {
      const live = await once(sock, { id: `d${attempt}`, type: "get_chat", chatId });
      const entries = (live.result as { transcript: Array<{ text?: string }> }).transcript;
      sawSecond = entries.some((entry) => entry.text === "second");
      if (!sawSecond) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(sawSecond, true);
  } finally {
    release();
    await runner.close();
    await rm(home, { recursive: true, force: true });
  }
});

interface Line {
  id?: string;
  type?: string;
  result?: unknown;
  error?: string;
  event?: { type?: string; text?: string; requestId?: string };
}

function once(socketPath: string, request: Record<string, unknown>): Promise<Line> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buf += chunk;
      const index = buf.indexOf("\n");
      if (index < 0) return;
      const message = JSON.parse(buf.slice(0, index)) as Line;
      socket.end();
      if (message.type === "error") reject(new Error(message.error || "runner error"));
      else resolve(message);
    });
    socket.on("error", reject);
    socket.write(`${JSON.stringify(request)}\n`);
  });
}

function subscribe(socketPath: string): Promise<{
  send: (request: Record<string, unknown>) => void;
  next: (match: (message: Line) => boolean) => Promise<Line>;
  close: () => void;
}> {
  const socket = connect(socketPath);
  return openChannel(socket);
}

function openChannel(socket: Socket): Promise<{
  send: (request: Record<string, unknown>) => void;
  next: (match: (message: Line) => boolean) => Promise<Line>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const pending: Line[] = [];
    const waiters: { match: (message: Line) => boolean; resolve: (message: Line) => void }[] = [];
    let opened = false;
    const api = {
      send: (request: Record<string, unknown>) => socket.write(`${JSON.stringify(request)}\n`),
      next: (match: (message: Line) => boolean) =>
        new Promise<Line>((done) => {
          const existing = pending.findIndex(match);
          if (existing >= 0) done(pending.splice(existing, 1)[0]!);
          else waiters.push({ match, resolve: done });
        }),
      close: () => socket.end(),
    };
    const push = (message: Line) => {
      if (!opened && message.id === "sub") {
        opened = true;
        resolve(api);
        return;
      }
      const index = waiters.findIndex((waiter) => waiter.match(message));
      if (index >= 0) waiters.splice(index, 1)[0]?.resolve(message);
      else pending.push(message);
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buf += chunk;
      let index = buf.indexOf("\n");
      while (index >= 0) {
        const line = buf.slice(0, index);
        buf = buf.slice(index + 1);
        index = buf.indexOf("\n");
        if (line.trim()) push(JSON.parse(line) as Line);
      }
    });
    socket.on("error", reject);
    socket.write(`${JSON.stringify({ id: "sub", type: "subscribe" })}\n`);
  });
}
