import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import type { LinuxUser } from "../apps/hub/src/auth.ts";
import { createHub } from "../apps/hub/src/server.ts";
import { AcpManager } from "../apps/runner/src/acp/manager.ts";
import type { AgentDriver } from "../apps/runner/src/drivers.ts";
import { startRunner } from "../apps/runner/src/server.ts";
import { socketPathForUser } from "@engineroom/protocol";
import "./peercred-helper.ts";

test("the hub only opens the signed-in user's runner", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "er-hub-"));
  const home = path.join(root, "home");
  const socketDir = path.join(root, "socks");
  const web = path.join(root, "web");
  await mkdir(home);
  await mkdir(socketDir);
  await mkdir(web);
  await writeFile(path.join(web, "index.html"), "<!doctype html><title>Engineroom</title><h1>Sign in</h1>");
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const user: LinuxUser = {
    username: "alice",
    uid,
    gid,
    home,
    shell: "/bin/bash",
    groups: ["engineroom-users"],
  };
  let pamCalls = 0;
  const drivers: Record<AgentDriver["id"], AgentDriver> = {
    cursor: {
      id: "cursor",
      async run(ctx) {
        ctx.onEvent({ type: "text_delta", text: "from-alice" });
        ctx.onEvent({ type: "done", agentSessionId: "sess" });
        return { agentSessionId: "sess" };
      },
    },
    claude: { id: "claude", async run() { throw new Error("not used"); } },
    pi: { id: "pi", async run() { throw new Error("not used"); } },
  };
  let bobHits = 0;
  const bob = createServer((socket) => {
    bobHits += 1;
    socket.end();
  });
  const runner = await startRunner({
    home,
    socketPath: socketPathForUser(socketDir, "alice"),
    drivers,
  });
  await new Promise<void>((resolve) => bob.listen(socketPathForUser(socketDir, "bob"), resolve));
  const hub = createHub({
    link: { socketDir },
    sessionSecret: Buffer.from("hub-test-secret-value"),
    pamHelper: "/bin/false",
    webDist: web,
    cookieSecure: false,
    lookup: (username) => (username === "alice" ? user : username === "bob" ? { ...user, username: "bob", groups: [] } : null),
    authenticate: async () => {
      pamCalls += 1;
      return true;
    },
  });
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", () => resolve()));
  const port = (hub.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const page = await fetch(`${base}/`);
    assert.match(await page.text(), /Sign in/);
    const denied = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "bob", password: "nope" }),
    });
    assert.equal(denied.status, 401);
    assert.equal(pamCalls, 0);

    const loggedIn = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "secret" }),
    });
    assert.equal(loggedIn.status, 200);
    const cookie = (loggedIn.headers.getSetCookie?.() ?? [])[0]?.split(";")[0];
    assert.ok(cookie);
    const headers = { Cookie: cookie!, "Content-Type": "application/json" };
    const me = (await (await fetch(`${base}/api/me`, { headers })).json()) as { admin: boolean; agents: string[] };
    assert.equal(me.admin, false);
    assert.deepEqual(me.agents, ["cursor", "claude", "pi"]);

    const forged = await fetch(`${base}/api/chats`, { headers: { Cookie: "engineroom_session=alice.forged" } });
    assert.equal(forged.status, 401);

    const created = await fetch(`${base}/api/chats`, {
      method: "POST",
      headers,
      body: JSON.stringify({ agent: "cursor", workspace: home }),
    });
    assert.equal(created.status, 201);
    const chat = (await created.json()) as { id: string; agent: string };
    assert.equal(chat.agent, "cursor");

    const escaped = await fetch(`${base}/api/chats`, {
      method: "POST",
      headers,
      body: JSON.stringify({ workspace: "/etc" }),
    });
    assert.equal(escaped.status >= 400, true);

    const sent = await fetch(`${base}/api/chats/${chat.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "hello" }),
    });
    assert.equal(sent.status, 202);
    assert.equal(((await sent.json()) as { accepted?: boolean }).accepted, true);
    let body: { chat: { agentSessionId: string }; transcript: Array<{ kind: string; text?: string }> } | undefined;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const detail = await fetch(`${base}/api/chats/${chat.id}`, { headers });
      body = (await detail.json()) as typeof body;
      if (body?.transcript.some((entry) => entry.text === "from-alice")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(body?.chat.agentSessionId, "sess");
    assert.equal(body?.transcript.some((entry) => entry.kind === "user"), true);
    assert.equal(body?.transcript.some((entry) => entry.text === "from-alice"), true);
    assert.equal(bobHits, 0);

    const saved = await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ defaultAgent: "pi" }),
    });
    assert.equal(saved.status, 200);
    const settings = (await (await fetch(`${base}/api/settings`, { headers })).json()) as { defaultAgent: string };
    assert.equal(settings.defaultAgent, "pi");

    const repos = await fetch(`${base}/api/repositories`, { headers });
    assert.equal(repos.status, 200);
    assert.deepEqual(await repos.json(), []);
    await mkdir(path.join(home, "plain"));
    const plain = await fetch(`${base}/api/chats`, {
      method: "POST",
      headers,
      body: JSON.stringify({ workspace: path.join(home, "plain") }),
    });
    assert.equal(plain.status, 403);
  } finally {
    hub.close();
    bob.close();
    await runner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a websocket emits a line before the agent finishes and rejects a foreign origin", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "er-live-"));
  const home = path.join(root, "home");
  const socketDir = path.join(root, "socks");
  await mkdir(home);
  await mkdir(socketDir);
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const user: LinuxUser = {
    username: "alice",
    uid,
    gid,
    home,
    shell: "/bin/bash",
    groups: ["engineroom-users"],
  };
  let release: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const drivers: Record<AgentDriver["id"], AgentDriver> = {
    cursor: {
      id: "cursor",
      async run(ctx) {
        ctx.onEvent({ type: "status", text: "partial-line" });
        await hold;
        ctx.onEvent({ type: "done", agentSessionId: "sess" });
        return { agentSessionId: "sess" };
      },
    },
    claude: { id: "claude", async run() { throw new Error("not used"); } },
    pi: { id: "pi", async run() { throw new Error("not used"); } },
  };
  const runner = await startRunner({
    home,
    socketPath: socketPathForUser(socketDir, "alice"),
    drivers,
  });
  const hub = createHub({
    link: { socketDir },
    sessionSecret: Buffer.from("hub-test-secret-value"),
    pamHelper: "/bin/false",
    cookieSecure: false,
    lookup: (username) => (username === "alice" ? user : null),
    authenticate: async () => true,
  });
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
  let ws: WebSocket | undefined;
  try {
    const loggedIn = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "secret" }),
    });
    const cookie = (loggedIn.headers.getSetCookie?.() ?? [])[0]?.split(";")[0];
    assert.ok(cookie);
    const headers = { Cookie: cookie!, "Content-Type": "application/json" };
    const created = await fetch(`${base}/api/chats`, {
      method: "POST",
      headers,
      body: JSON.stringify({ agent: "cursor", workspace: home }),
    });
    const chat = (await created.json()) as { id: string };
    const blocked = await new Promise<number>((resolve) => {
      const bad = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/api/ws`, {
        headers: { Cookie: cookie!, Origin: "https://evil.example" },
      });
      bad.on("unexpected-response", (_req, res) => resolve(res.statusCode || 0));
      bad.on("error", () => resolve(0));
    });
    assert.equal(blocked, 403);
    ws = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/api/ws`, {
      headers: { Cookie: cookie!, Origin: base },
    });
    const messages: string[] = [];
    ws.on("message", (data) => messages.push(data.toString()));
    await new Promise<void>((resolve, reject) => {
      ws?.once("open", () => resolve());
      ws?.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "watch", chatId: chat.id, lastSeq: 0 }));
    const ready = Date.now() + 3000;
    while (!messages.some((line) => line.includes('"snapshot"'))) {
      if (Date.now() > ready) throw new Error(`watch never settled: ${messages.join("\n").slice(0, 300)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const sent = await fetch(`${base}/api/chats/${chat.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "hello" }),
    });
    assert.equal(sent.status, 202);
    const deadline = Date.now() + 3000;
    while (!messages.some((line) => line.includes("partial-line"))) {
      if (Date.now() > deadline) throw new Error(`socket stayed quiet: ${messages.join("\n").slice(0, 300)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    release();
    ws?.close();
    hub.close();
    await runner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a fresh watch shows saved modes and models before ACP starts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "er-hub-options-"));
  const home = path.join(root, "home");
  const socketDir = path.join(root, "socks");
  const agentsFile = path.join(root, "agents.json");
  await mkdir(home);
  await mkdir(socketDir);
  await writeFile(agentsFile, JSON.stringify({ cursor: true, claude: false, pi: false }));
  const uid = process.getuid?.() ?? 1000;
  const user: LinuxUser = {
    username: "alice",
    uid,
    gid: process.getgid?.() ?? 1000,
    home,
    shell: "/bin/bash",
    groups: ["engineroom-users"],
  };
  const fake = path.resolve("test/fake-acp.mjs");
  const acp = new AcpManager({
    launch: async () => ({ binary: process.execPath, args: [fake] }),
  });
  const drivers: Record<AgentDriver["id"], AgentDriver> = {
    cursor: { id: "cursor", async run() { return { agentSessionId: null }; } },
    claude: { id: "claude", async run() { throw new Error("not used"); } },
    pi: { id: "pi", async run() { throw new Error("not used"); } },
  };
  const runner = await startRunner({
    home,
    socketPath: socketPathForUser(socketDir, "alice"),
    acp,
    drivers,
  });
  const hub = createHub({
    link: { socketDir },
    sessionSecret: Buffer.from("hub-options-secret-value"),
    pamHelper: "/bin/false",
    cookieSecure: false,
    adminUser: "alice",
    agentsFile,
    lookup: (username) => (username === "alice" ? user : null),
    authenticate: async () => true,
  });
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
  let ws: WebSocket | undefined;
  try {
    const loggedIn = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "secret" }),
    });
    const cookie = (loggedIn.headers.getSetCookie?.() ?? [])[0]?.split(";")[0];
    assert.ok(cookie);
    const headers = { Cookie: cookie!, "Content-Type": "application/json" };
    const probed = await fetch(`${base}/api/admin/agent-options/cursor/probe`, { method: "POST", headers });
    assert.equal(probed.status, 200);
    const saved = await fetch(`${base}/api/admin/agent-options`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ cursor: { modes: ["agent", "plan"], models: ["fake"] } }),
    });
    assert.equal(saved.status, 200);
    const created = await fetch(`${base}/api/chats`, {
      method: "POST",
      headers,
      body: JSON.stringify({ agent: "cursor", model: "fake", workspace: home }),
    });
    assert.equal(created.status, 201);
    const chat = (await created.json()) as { id: string };
    ws = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/api/ws`, {
      headers: { Cookie: cookie!, Origin: base },
    });
    const messages: string[] = [];
    ws.on("message", (data) => messages.push(data.toString()));
    await new Promise<void>((resolve, reject) => {
      ws?.once("open", () => resolve());
      ws?.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "watch", chatId: chat.id, lastSeq: 0 }));
    const ready = Date.now() + 3000;
    let snapshot = "";
    while (!snapshot) {
      snapshot = messages.find((line) => line.includes('"snapshot"')) || "";
      if (snapshot) break;
      if (Date.now() > ready) throw new Error(`watch never settled: ${messages.join("\n").slice(0, 400)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const body = JSON.parse(snapshot) as {
      modes: { availableModes: Array<{ id: string }> } | null;
      models: { availableModels: Array<{ modelId: string }> } | null;
    };
    assert.deepEqual(body.modes?.availableModes.map((mode) => mode.id), ["agent", "plan"]);
    assert.deepEqual(body.models?.availableModels.map((model) => model.modelId), ["fake"]);
  } finally {
    ws?.close();
    hub.close();
    await runner.close();
    await rm(root, { recursive: true, force: true });
  }
});
