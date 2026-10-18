import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentId } from "@engineroom/protocol";
import type { AcpManager } from "../apps/runner/src/acp/manager.ts";
import { PtyManager, type PtyProcess } from "../apps/runner/src/pty.ts";
import { startRunner } from "../apps/runner/src/server.ts";
import { getChat, saveSettings } from "../apps/runner/src/store.ts";

test("raw mode is refused while a turn is running, then hands the session back for a resync", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "er-pty-"));
  const sock = path.join(home, "runner.sock");
  let release: () => void = () => undefined;
  let holding = false;
  let stopped = 0;
  let resynced = 0;
  const acp = {
    supports: (agent: AgentId) => agent === "cursor",
    info: () => null,
    async prompt(_chatId: string, _ctx: unknown, text: string) {
      if (text === "hold") {
        holding = true;
        await new Promise<void>((resolve) => { release = resolve; });
      }
      return { agentSessionId: "sess-1" };
    },
    async resync() { resynced += 1; },
    respond: () => false,
    async setMode() { /* unused */ },
    async setModel() { /* unused */ },
    cancel() { release(); },
    async stop() { stopped += 1; },
    async list() { return []; },
  } as unknown as AcpManager;
  let spawned = 0;
  const pty = new PtyManager(() => {
    spawned += 1;
    const proc: PtyProcess = {
      write() { /* unused */ },
      resize() { /* unused */ },
      kill() { /* unused */ },
      onData() { /* unused */ },
      onExit() { /* unused */ },
    };
    return proc;
  });
  const runner = await startRunner({ home, socketPath: sock, acp, pty, peerCheck: () => undefined });
  const live = await subscribe(sock);
  try {
    await saveSettings(home, { binaries: { cursor: process.execPath } });
    const created = await once(sock, { id: "c", type: "create_chat", agent: "cursor", workspace: home });
    const chatId = (created.result as { id: string }).id;
    live.send({ id: "p", type: "prompt", chatId, prompt: "hold" });
    await live.next((message) => message.id === "p");
    for (let attempt = 0; attempt < 40 && !holding; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(holding, true);
    live.send({ id: "o", type: "pty_open", chatId, cols: 80, rows: 24 });
    const denied = await live.next((message) => message.id === "o");
    assert.match(denied.error || "", /running/);
    release();
    let settled = false;
    for (let attempt = 0; attempt < 40 && !settled; attempt += 1) {
      const current = await once(sock, { id: `g${attempt}`, type: "get_chat", chatId });
      const chat = (current.result as { chat: { running?: boolean; agentSessionId?: string } }).chat;
      settled = chat.running !== true && chat.agentSessionId === "sess-1";
      if (!settled) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(settled, true);
    live.send({ id: "o2", type: "pty_open", chatId, cols: 80, rows: 24 });
    const opened = await live.next((message) => message.id === "o2");
    assert.equal((opened.result as { attached?: boolean }).attached, true);
    assert.equal(stopped, 1);
    assert.equal(spawned, 1);
    live.send({ id: "x", type: "pty_close", chatId });
    const closed = await live.next((message) => message.id === "x");
    assert.equal(closed.type, "ok");
    assert.equal(resynced, 1);
    const after = await getChat(home, chatId, false);
    assert.equal(after.chat.needsResync, false);
    assert.equal(after.chat.agentSessionId, "sess-1");
  } finally {
    release();
    live.close();
    await runner.close();
    await rm(home, { recursive: true, force: true });
  }
});

interface Line {
  id?: string;
  type?: string;
  result?: unknown;
  error?: string;
  event?: { type?: string };
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
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
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
