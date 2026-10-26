import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentId } from "@engineroom/protocol";
import { AcpManager, acpCommand } from "../apps/runner/src/acp/manager.ts";
import { agentContentBlocks } from "../apps/runner/src/prompt-content.ts";
import type { AgentDriver } from "../apps/runner/src/drivers.ts";
import { startRunner } from "../apps/runner/src/server.ts";
import { getChat } from "../apps/runner/src/store.ts";

const fake = path.resolve("test/fake-acp.mjs");

test("prompt blocks link every file and include images only when the agent accepts them", () => {
  const shot = {
    name: "shot.png",
    path: ".engineroom/uploads/id-shot.png",
    mimeType: "image/png",
    size: 4,
    uri: "file:///tmp/shot.png",
    data: "AAAA",
  };
  const note = {
    name: "notes.txt",
    path: ".engineroom/uploads/id-notes.txt",
    mimeType: "text/plain",
    size: 5,
    uri: "file:///tmp/notes.txt",
  };
  const vision = agentContentBlocks("look", [shot, note], true);
  assert.equal(vision[0]?.type, "text");
  assert.match(vision[0]?.type === "text" ? vision[0].text : "", /\.engineroom\/uploads\/id-shot\.png \(image\/png\)/);
  assert.deepEqual(vision.map((block) => block.type), ["text", "resource_link", "image", "resource_link"]);
  const plain = agentContentBlocks("look", [shot], false);
  assert.deepEqual(plain.map((block) => block.type), ["text", "resource_link"]);
});

test("a custom agent launches its command with acp", () => {
  const commands = new Map([["codex", "codex"]]);
  assert.deepEqual(acpCommand("codex", commands), { names: ["codex"], args: ["acp"] });
  assert.deepEqual(acpCommand("cursor", new Map()), { names: ["agent"], args: ["acp"] });
  assert.deepEqual(acpCommand("claude", new Map()), { names: ["claude-agent-acp"], args: [] });
  assert.throws(() => acpCommand("pi", new Map()));
  const acp = new AcpManager();
  assert.equal(acp.supports("codex"), false);
  acp.setCatalog([{ id: "codex", binary: "codex" }]);
  assert.equal(acp.supports("codex"), true);
  assert.equal(acp.supports("cursor"), true);
  assert.equal(acp.supports("pi"), false);
});

test("the runner stores a custom agent catalog", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "er-catalog-"));
  const sock = path.join(home, "runner.sock");
  const acp = new AcpManager();
  const runner = await startRunner({ home, socketPath: sock, acp, peerCheck: () => undefined });
  try {
    const saved = await once(sock, {
      id: "cat",
      type: "put_agent_catalog",
      agents: [{ id: "codex", label: "Codex", binary: "codex" }],
    });
    assert.equal(saved.type, "ok");
    const stored = JSON.parse(await readFile(path.join(home, ".engineroom", "agent-catalog.json"), "utf8")) as { id: string; binary: string }[];
    assert.deepEqual(stored, [{ id: "codex", label: "Codex", binary: "codex" }]);
    assert.equal(acp.supports("codex"), true);
  } finally {
    await runner.close();
    await rm(home, { recursive: true, force: true });
  }
});

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

    live.send({ id: "p2", type: "prompt", chatId, prompt: "run-terminal" });
    await live.next((message) => message.event?.type === "done");
    const afterTerm = (await once(sock, { id: "g2", type: "get_chat", chatId })).result as {
      transcript: Array<{ kind: string; text?: string }>;
    };
    assert.equal(
      afterTerm.transcript.some((entry) => entry.kind === "text" && entry.text?.includes("out:term-out-✓:missing:1")),
      true,
    );
  } finally {
    live.close();
    await runner.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("resolve_commands finds a binary that only the login shell can see", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "er-login-path-"));
  const sock = path.join(home, "runner.sock");
  const bin = path.join(home, "tool-bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(path.join(home, ".bashrc"), `export PATH="$HOME/tool-bin:$PATH"\n`);
  const runner = await startRunner({ home, socketPath: sock, peerCheck: () => undefined });
  try {
    const found = await once(sock, { id: "w", type: "resolve_commands", names: ["pi"] });
    const commands = (found.result as { commands: { name: string; path: string | null }[] }).commands;
    assert.equal(commands.find((item) => item.name === "pi")?.path, path.join(bin, "pi"));
  } finally {
    await runner.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("resolve_commands finds a binary on the user path", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "er-which-"));
  const sock = path.join(home, "runner.sock");
  const bin = path.join(home, ".local", "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "agent"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const runner = await startRunner({ home, socketPath: sock, peerCheck: () => undefined });
  try {
    const found = await once(sock, { id: "w", type: "resolve_commands", names: ["agent", "missing-agent"] });
    const commands = (found.result as { commands: { name: string; path: string | null }[] }).commands;
    assert.equal(commands.find((item) => item.name === "agent")?.path, path.join(bin, "agent"));
    assert.equal(commands.find((item) => item.name === "missing-agent")?.path, null);
  } finally {
    await runner.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("a missing agent session starts a new one instead of failing the turn", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "er-acp-missing-"));
  const sock = path.join(home, "runner.sock");
  const acp = new AcpManager({
    launch: async () => ({ binary: process.execPath, args: [fake] }),
  });
  const runner = await startRunner({ home, socketPath: sock, acp, peerCheck: () => undefined });
  const live = await subscribe(sock);
  try {
    const created = await once(sock, { id: "c", type: "create_chat", agent: "cursor", workspace: home });
    const chatId = (created.result as { id: string }).id;
    await once(sock, { id: "im", type: "import_session", agent: "cursor", agentSessionId: "missing", workspace: home });
    live.send({ id: "w", type: "watch", chatId, lastSeq: 0 });
    await live.next((message) => message.id === "w");
    live.send({ id: "p", type: "prompt", chatId, prompt: "continue" });
    await live.next((message) => message.event?.type === "done");
    const finished = await getChat(home, chatId, false);
    assert.equal(finished.chat.agentSessionId, "fake-session");
    assert.equal(finished.transcript.some((entry) => entry.kind === "error"), false);
    assert.equal(finished.transcript.some((entry) => entry.kind === "text" && entry.text?.includes("hello")), true);
  } finally {
    live.close();
    await runner.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("a running turn does not wait on set_mode", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "er-acp-busy-"));
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
    live.send({ id: "p", type: "prompt", chatId, prompt: "hold" });
    await live.next((message) => message.event?.type === "text_delta" && message.event?.text === "held");
    const started = Date.now();
    const changed = await once(sock, { id: "mode", type: "set_mode", chatId, modeId: "plan" });
    assert.equal(changed.type, "ok");
    assert.ok(Date.now() - started < 1000, "set_mode waited on the running agent");
    const detail = await getChat(home, chatId, true);
    assert.equal(detail.chat.mode, "plan");
  } finally {
    live.close();
    await runner.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("probe reads the session catalog and a personal list rejects other models", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "er-probe-"));
  const sock = path.join(home, "runner.sock");
  const acp = new AcpManager({
    launch: async () => ({ binary: process.execPath, args: [fake] }),
  });
  const runner = await startRunner({ home, socketPath: sock, acp, peerCheck: () => undefined });
  try {
    const found = await acp.probe("cursor", home, process.env, home);
    assert.deepEqual(found.modes.map((mode) => mode.id), ["agent", "plan"]);
    assert.deepEqual(found.models, [{ id: "fake", name: "Fake" }]);
    await assert.rejects(() => acp.probe("pi", home, process.env, home), /does not report modes or models/);
    await once(sock, {
      id: "pol",
      type: "put_policy",
      policy: { agents: ["cursor"], rawTerminal: true, options: { cursor: { modes: ["agent"], models: ["fake"] } } },
    });
    const created = await once(sock, { id: "c", type: "create_chat", agent: "cursor", workspace: home });
    const chatId = (created.result as { id: string }).id;
    await assert.rejects(() => once(sock, { id: "bad", type: "set_model", chatId, modelId: "other" }), /invalid model/);
    await assert.rejects(() => once(sock, { id: "bad-mode", type: "set_mode", chatId, modeId: "plan" }), /invalid mode/);
    const allowed = await once(sock, { id: "ok", type: "set_model", chatId, modelId: "fake" });
    assert.equal(allowed.type, "ok");
    const chat = await getChat(home, chatId, false);
    assert.equal(chat.chat.model, "fake");
  } finally {
    await runner.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("an ACP prompt sends image bytes and a file link", async () => {
  const { savePromptAttachment } = await import("../apps/runner/src/files.ts");
  const home = await mkdtemp(path.join(tmpdir(), "er-attach-acp-"));
  const sock = path.join(home, "runner.sock");
  const acp = new AcpManager({
    launch: async () => ({ binary: process.execPath, args: [fake] }),
  });
  const runner = await startRunner({ home, socketPath: sock, acp, peerCheck: () => undefined });
  const live = await subscribe(sock);
  try {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const shot = await savePromptAttachment(home, home, "shot.png", "application/octet-stream", png.toString("base64"));
    const note = await savePromptAttachment(home, home, "notes.txt", "text/plain", Buffer.from("hello").toString("base64"));
    const created = await once(sock, { id: "c", type: "create_chat", agent: "cursor", workspace: home });
    const chatId = (created.result as { id: string }).id;
    live.send({ id: "w", type: "watch", chatId, lastSeq: 0 });
    await live.next((message) => message.id === "w");
    live.send({ id: "p1", type: "prompt", chatId, prompt: "look", attachments: [shot] });
    await live.next((message) => message.event?.type === "done");
    live.send({ id: "p2", type: "prompt", chatId, prompt: "", attachments: [note] });
    await live.next((message) => message.id === "p2" && message.type === "ok");
    await live.next((message) => message.event?.type === "done");
    let finished = await getChat(home, chatId, false);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const text = finished.transcript.some((entry) => entry.kind === "text" && entry.text?.includes("files:1:0"));
      if (text) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
      finished = await getChat(home, chatId, false);
    }
    assert.equal(finished.transcript.some((entry) => entry.kind === "text" && entry.text?.includes("files:1:1")), true);
    assert.equal(finished.transcript.some((entry) => entry.kind === "text" && entry.text?.includes("files:1:0")), true);
    const users = finished.transcript.flatMap((entry) => (entry.kind === "user" ? [entry] : []));
    assert.equal(users[0]?.attachments?.[0]?.path, shot.path);
    assert.equal(users[1]?.text, "Attached files.");
    assert.equal(users[1]?.attachments?.[0]?.name, "notes.txt");
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
