import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import WebSocket from "ws";
import type { LinuxUser } from "../apps/hub/src/auth.ts";
import { createHub } from "../apps/hub/src/server.ts";
import { AcpManager } from "../apps/runner/src/acp/manager.ts";
import type { AgentDriver } from "../apps/runner/src/drivers.ts";
import { startRunner } from "../apps/runner/src/server.ts";
import { socketPathForUser } from "@engineroom/protocol";
import "./peercred-helper.ts";

test("the administrator sets agents and accounts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "er-admin-"));
  const home = path.join(root, "home");
  const carolHome = path.join(root, "carol");
  const socketDir = path.join(root, "socks");
  const agentsFile = path.join(root, "agents.json");
  await mkdir(home);
  await mkdir(carolHome);
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
  const calls: Array<{ action: string; username: string; password?: string }> = [];
  const drivers: Record<AgentDriver["id"], AgentDriver> = {
    cursor: { id: "cursor", async run() { throw new Error("not used"); } },
    claude: { id: "claude", async run() { throw new Error("not used"); } },
    pi: { id: "pi", async run() { throw new Error("not used"); } },
  };
  const runner = await startRunner({
    home,
    socketPath: socketPathForUser(socketDir, "alice"),
    drivers,
  });
  const carolRunner = await startRunner({
    home: carolHome,
    socketPath: socketPathForUser(socketDir, "carol"),
    drivers,
  });
  const hub = createHub({
    link: { socketDir },
    sessionSecret: Buffer.from("admin-test-secret-value"),
    pamHelper: "/bin/false",
    cookieSecure: false,
    adminUser: "alice",
    agentsFile,
    lookup: (username) => {
      if (username === "alice") return user;
      if (username === "carol") return { ...user, username: "carol", home: carolHome };
      return null;
    },
    authenticate: async () => true,
    listAccounts: () => [
      { username: "alice", home, uid },
      { username: "carol", home: "/home/carol", uid: uid + 1 },
    ],
    runAdmin: async (action, username, password) => {
      calls.push({ action, username, password });
    },
  });
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
  try {
    const loggedIn = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "secret" }),
    });
    const cookie = (loggedIn.headers.getSetCookie?.() ?? [])[0]?.split(";")[0];
    assert.ok(cookie);
    const headers = { Cookie: cookie!, "Content-Type": "application/json" };
    const me = (await (await fetch(`${base}/api/me`, { headers })).json()) as {
      admin: boolean;
      agents: string[];
      cliImport: boolean;
      appName: string;
    };
    assert.equal(me.admin, true);
    assert.deepEqual(me.agents, ["cursor"]);
    assert.equal(me.cliImport, false);
    assert.equal(me.appName, "AgentWrapper");

    const blockedImport = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/api/ws`, {
        headers: { Cookie: cookie!, Origin: base },
      });
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("cli import was not rejected"));
      }, 3000);
      socket.on("message", (data) => {
        const text = data.toString();
        if (!text.includes("CLI import is not enabled")) return;
        clearTimeout(timer);
        socket.close();
        resolve(text);
      });
      socket.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.once("open", () => {
        socket.send(JSON.stringify({ type: "list_sessions", agent: "cursor" }));
      });
    });
    assert.match(blockedImport, /CLI import is not enabled/);

    const blocked = await fetch(`${base}/api/chats`, {
      method: "POST",
      headers,
      body: JSON.stringify({ agent: "pi", workspace: home }),
    });
    assert.equal(blocked.status, 400);

    const badDefault = await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ defaultAgent: "pi" }),
    });
    assert.equal(badDefault.status, 400);

    const users = await fetch(`${base}/api/admin/users`, { headers });
    assert.equal(users.status, 200);
    assert.equal(((await users.json()) as Array<{ username: string }>).length, 2);

    const added = await fetch(`${base}/api/admin/users`, {
      method: "POST",
      headers,
      body: JSON.stringify({ username: "carol", password: "new-secret" }),
    });
    assert.equal(added.status, 201);
    assert.deepEqual(calls.at(-1), { action: "add", username: "carol", password: "new-secret" });

    const self = await fetch(`${base}/api/admin/users`, {
      method: "POST",
      headers,
      body: JSON.stringify({ username: "alice", password: "nope" }),
    });
    assert.equal(self.status, 400);
    assert.equal(calls.length, 1);

    const removed = await fetch(`${base}/api/admin/users/carol/remove`, { method: "POST", headers });
    assert.equal(removed.status, 200);
    assert.equal(calls.at(-1)?.action, "remove");

    const removeSelf = await fetch(`${base}/api/admin/users/alice/remove`, { method: "POST", headers });
    assert.equal(removeSelf.status, 400);
    assert.equal(calls.length, 2);

    const none = await fetch(`${base}/api/admin/agents`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ cursor: false, claude: false, pi: false }),
    });
    assert.equal(none.status, 400);

    const enabled = await fetch(`${base}/api/admin/agents`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ cursor: false, claude: true, pi: false }),
    });
    assert.equal(enabled.status, 200);
    const enabledBody = (await enabled.json()) as { agents: string[]; cliImport: boolean };
    assert.deepEqual(enabledBody.agents, ["claude"]);
    assert.equal(enabledBody.cliImport, false);
    const stored = JSON.parse(await readFile(agentsFile, "utf8")) as { claude: boolean; cliImport: boolean; appName: string };
    assert.equal(stored.claude, true);
    assert.equal(stored.cliImport, false);
    assert.equal(stored.appName, "AgentWrapper");

    const imports = await fetch(`${base}/api/admin/agents`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ cursor: false, claude: true, pi: false, cliImport: true }),
    });
    assert.equal(imports.status, 200);
    assert.equal(((await imports.json()) as { cliImport: boolean }).cliImport, true);

    const blankName = await fetch(`${base}/api/admin/branding`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ appName: "   " }),
    });
    assert.equal(blankName.status, 400);
    const longName = await fetch(`${base}/api/admin/branding`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ appName: "a".repeat(65) }),
    });
    assert.equal(longName.status, 400);

    const named = await fetch(`${base}/api/admin/branding`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ appName: "  Shop Floor  " }),
    });
    assert.equal(named.status, 200);
    assert.equal(((await named.json()) as { appName: string }).appName, "Shop Floor");
    const namedMe = (await (await fetch(`${base}/api/me`, { headers })).json()) as { appName: string };
    assert.equal(namedMe.appName, "Shop Floor");

    const kept = await fetch(`${base}/api/admin/agents`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ cursor: false, claude: true, pi: false, cliImport: true }),
    });
    assert.equal(kept.status, 200);
    const keptFile = JSON.parse(await readFile(agentsFile, "utf8")) as { appName: string; cliImport: boolean };
    assert.equal(keptFile.appName, "Shop Floor");
    assert.equal(keptFile.cliImport, true);

    const carol = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "carol", password: "secret" }),
    });
    const carolCookie = (carol.headers.getSetCookie?.() ?? [])[0]?.split(";")[0];
    const denied = await fetch(`${base}/api/admin/users`, { headers: { Cookie: carolCookie! } });
    assert.equal(denied.status, 403);
    const deniedName = await fetch(`${base}/api/admin/branding`, {
      method: "PUT",
      headers: { Cookie: carolCookie!, "Content-Type": "application/json" },
      body: JSON.stringify({ appName: "Nope" }),
    });
    assert.equal(deniedName.status, 403);
    const carolMe = (await (await fetch(`${base}/api/me`, { headers: { Cookie: carolCookie! } })).json()) as {
      admin: boolean;
      agents: string[];
      cliImport: boolean;
      appName: string;
    };
    assert.equal(carolMe.admin, false);
    assert.deepEqual(carolMe.agents, ["claude"]);
    assert.equal(carolMe.cliImport, true);
    assert.equal(carolMe.appName, "Shop Floor");
  } finally {
    hub.close();
    await runner.close();
    await carolRunner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the administrator enables repositories for one user", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "er-repos-admin-"));
  const aliceHome = path.join(root, "alice");
  const carolHome = path.join(root, "carol");
  const socketDir = path.join(root, "socks");
  const catalogFile = path.join(root, "catalog.json");
  const carolOther = path.join(carolHome, "Sites", "other");
  await mkdir(path.join(carolOther, ".git"), { recursive: true });
  await mkdir(aliceHome);
  await mkdir(socketDir);
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const alice: LinuxUser = {
    username: "alice",
    uid,
    gid,
    home: aliceHome,
    shell: "/bin/bash",
    groups: ["engineroom-users"],
  };
  const carol: LinuxUser = { ...alice, username: "carol", home: carolHome };
  const drivers: Record<AgentDriver["id"], AgentDriver> = {
    cursor: { id: "cursor", async run() { throw new Error("not used"); } },
    claude: { id: "claude", async run() { throw new Error("not used"); } },
    pi: { id: "pi", async run() { throw new Error("not used"); } },
  };
  const clone = async (_url: string, dest: string) => {
    await mkdir(path.join(dest, ".git"), { recursive: true });
  };
  const aliceRunner = await startRunner({
    home: aliceHome,
    socketPath: socketPathForUser(socketDir, "alice"),
    drivers,
    clone,
  });
  const carolRunner = await startRunner({
    home: carolHome,
    socketPath: socketPathForUser(socketDir, "carol"),
    drivers,
    clone,
  });
  const hub = createHub({
    link: { socketDir },
    sessionSecret: Buffer.from("repo-admin-secret-value"),
    pamHelper: "/bin/false",
    cookieSecure: false,
    adminUser: "alice",
    catalogFile,
    lookup: (username) => (username === "alice" ? alice : username === "carol" ? carol : null),
    authenticate: async () => true,
  });
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
  try {
    const aliceLogin = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "secret" }),
    });
    const aliceCookie = (aliceLogin.headers.getSetCookie?.() ?? [])[0]?.split(";")[0];
    const carolLogin = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "carol", password: "secret" }),
    });
    const carolCookie = (carolLogin.headers.getSetCookie?.() ?? [])[0]?.split(";")[0];
    assert.ok(aliceCookie);
    assert.ok(carolCookie);
    const aliceHeaders = { Cookie: aliceCookie!, "Content-Type": "application/json" };
    const carolHeaders = { Cookie: carolCookie!, "Content-Type": "application/json" };

    const denied = await fetch(`${base}/api/admin/users/carol/repositories`, {
      method: "PUT",
      headers: carolHeaders,
      body: JSON.stringify({ ids: [] }),
    });
    assert.equal(denied.status, 403);

    const added = await fetch(`${base}/api/admin/catalog`, {
      method: "POST",
      headers: aliceHeaders,
      body: JSON.stringify({ name: "widget", url: "https://example.com/widget.git" }),
    });
    assert.equal(added.status, 201);
    const entry = (await added.json()) as { id: string };
    const saved = await fetch(`${base}/api/admin/users/carol/repositories`, {
      method: "PUT",
      headers: aliceHeaders,
      body: JSON.stringify({ ids: [entry.id] }),
    });
    assert.equal(saved.status, 200);

    const visible = (await (await fetch(`${base}/api/repositories`, { headers: carolHeaders })).json()) as Array<{ name: string; path: string }>;
    assert.deepEqual(visible.map((item) => item.name), ["other", "widget"]);
    const widget = visible.find((item) => item.name === "widget");
    assert.ok(widget);

    const created = await fetch(`${base}/api/chats`, {
      method: "POST",
      headers: carolHeaders,
      body: JSON.stringify({ workspace: widget.path, title: "widget chat" }),
    });
    assert.equal(created.status, 201);
    const custom = await fetch(`${base}/api/chats`, {
      method: "POST",
      headers: carolHeaders,
      body: JSON.stringify({ workspace: carolOther, title: "custom" }),
    });
    assert.equal(custom.status, 201);
    const loose = await fetch(`${base}/api/chats`, {
      method: "POST",
      headers: carolHeaders,
      body: JSON.stringify({ workspace: carolHome, title: "no repo" }),
    });
    assert.equal(loose.status, 201);

    const cleared = await fetch(`${base}/api/admin/users/carol/repositories`, {
      method: "PUT",
      headers: aliceHeaders,
      body: JSON.stringify({ ids: [] }),
    });
    assert.equal(cleared.status, 200);
    const after = (await (await fetch(`${base}/api/repositories`, { headers: carolHeaders })).json()) as Array<{ name: string }>;
    assert.deepEqual(after.map((item) => item.name), ["other", "widget"]);
    const stillOpen = await fetch(`${base}/api/chats`, {
      method: "POST",
      headers: carolHeaders,
      body: JSON.stringify({ workspace: widget.path }),
    });
    assert.equal(stillOpen.status, 201);
  } finally {
    hub.close();
    await aliceRunner.close();
    await carolRunner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the administrator sets one person's access, environment, and password", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "er-person-admin-"));
  const home = path.join(root, "alice");
  const carolHome = path.join(root, "carol");
  const socketDir = path.join(root, "socks");
  const agentsFile = path.join(root, "agents.json");
  await mkdir(home);
  await mkdir(carolHome);
  await mkdir(socketDir);
  await writeFile(agentsFile, JSON.stringify({ cursor: true, claude: true, pi: true }));
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const alice: LinuxUser = {
    username: "alice",
    uid,
    gid,
    home,
    shell: "/bin/bash",
    groups: ["engineroom-users"],
  };
  const carol: LinuxUser = { ...alice, username: "carol", home: carolHome };
  const calls: Array<{ action: string; username: string; password?: string }> = [];
  const drivers: Record<AgentDriver["id"], AgentDriver> = {
    cursor: { id: "cursor", async run() { throw new Error("not used"); } },
    claude: { id: "claude", async run() { throw new Error("not used"); } },
    pi: { id: "pi", async run() { throw new Error("not used"); } },
  };
  const aliceRunner = await startRunner({ home, socketPath: socketPathForUser(socketDir, "alice"), drivers });
  const carolRunner = await startRunner({ home: carolHome, socketPath: socketPathForUser(socketDir, "carol"), drivers });
  const carolSock = socketPathForUser(socketDir, "carol");
  const hub = createHub({
    link: { socketDir },
    sessionSecret: Buffer.from("person-admin-secret"),
    pamHelper: "/bin/false",
    cookieSecure: false,
    adminUser: "alice",
    agentsFile,
    lookup: (username) => (username === "alice" ? alice : username === "carol" ? carol : null),
    authenticate: async () => true,
    runAdmin: async (action, username, password) => {
      calls.push({ action, username, password });
    },
  });
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
  try {
    const loggedIn = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "secret" }),
    });
    const cookie = (loggedIn.headers.getSetCookie?.() ?? [])[0]?.split(";")[0];
    const headers = { Cookie: cookie!, "Content-Type": "application/json" };
    const carolLogin = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "carol", password: "secret" }),
    });
    const carolCookie = (carolLogin.headers.getSetCookie?.() ?? [])[0]?.split(";")[0];
    const carolHeaders = { Cookie: carolCookie!, "Content-Type": "application/json" };

    const policy = await fetch(`${base}/api/admin/users/carol/policy`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ agents: ["cursor"], binaries: { cursor: "/opt/admin/agent" }, rawTerminal: false }),
    });
    assert.equal(policy.status, 200);

    const me = (await (await fetch(`${base}/api/me`, { headers: carolHeaders })).json()) as { agents: string[]; rawTerminal: boolean };
    assert.deepEqual(me.agents, ["cursor"]);
    assert.equal(me.rawTerminal, false);

    const blocked = await fetch(`${base}/api/chats`, {
      method: "POST",
      headers: carolHeaders,
      body: JSON.stringify({ agent: "pi", workspace: carolHome }),
    });
    assert.equal(blocked.status, 400);

    await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: carolHeaders,
      body: JSON.stringify({ binaries: { cursor: "/usr/bin/true" } }),
    });
    const settings = (await (await fetch(`${base}/api/settings`, { headers: carolHeaders })).json()) as {
      binaries: { cursor?: string };
      lockedBinaries?: string[];
    };
    assert.equal(settings.binaries.cursor, "/opt/admin/agent");
    assert.deepEqual(settings.lockedBinaries, ["cursor"]);
    const stored = JSON.parse(await readFile(path.join(carolHome, ".engineroom", "settings.json"), "utf8")) as { binaries?: { cursor?: string } };
    assert.equal(stored.binaries?.cursor, undefined);

    const env = await fetch(`${base}/api/admin/users/carol/env`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ entries: [{ key: "ANTHROPIC_API_KEY", value: "secret" }] }),
    });
    assert.equal(env.status, 200);
    const file = await readFile(path.join(carolHome, ".env"), "utf8");
    assert.match(file, /ANTHROPIC_API_KEY=secret/);

    const password = await fetch(`${base}/api/admin/users/carol/password`, {
      method: "POST",
      headers,
      body: JSON.stringify({ password: "changed" }),
    });
    assert.equal(password.status, 200);
    assert.deepEqual(calls.at(-1), { action: "passwd", username: "carol", password: "changed" });
    const ownPassword = await fetch(`${base}/api/admin/users/alice/password`, {
      method: "POST",
      headers,
      body: JSON.stringify({ password: "nope" }),
    });
    assert.equal(ownPassword.status, 400);

    const live = await subscribe(carolSock);
    try {
      live.send({ id: "c", type: "create_chat", agent: "cursor", workspace: carolHome });
      const created = await live.next((message) => message.id === "c");
      const chatId = (created.result as { id: string }).id;
      live.send({ id: "o", type: "pty_open", chatId, cols: 80, rows: 24 });
      const opened = await live.next((message) => message.id === "o");
      assert.equal(opened.type, "error");
      assert.match(opened.error || "", /terminal is not enabled/);
    } finally {
      live.close();
    }
  } finally {
    hub.close();
    await aliceRunner.close();
    await carolRunner.close();
    await rm(root, { recursive: true, force: true });
  }
});

function subscribe(socketPath: string): Promise<{
  send: (request: Record<string, unknown>) => void;
  next: (match: (message: { id?: string; type?: string; error?: string; result?: unknown }) => boolean) => Promise<{ id?: string; type?: string; error?: string; result?: unknown }>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buf = "";
    const pending: Array<{ id?: string; type?: string; error?: string; result?: unknown }> = [];
    const waiters: Array<{ match: (message: { id?: string }) => boolean; resolve: (message: { id?: string; type?: string; error?: string; result?: unknown }) => void }> = [];
    let opened = false;
    const api = {
      send: (request: Record<string, unknown>) => socket.write(`${JSON.stringify(request)}\n`),
      next: (match: (message: { id?: string; type?: string; error?: string; result?: unknown }) => boolean) =>
        new Promise<{ id?: string; type?: string; error?: string; result?: unknown }>((done) => {
          const existing = pending.findIndex(match);
          if (existing >= 0) done(pending.splice(existing, 1)[0]!);
          else waiters.push({ match, resolve: done });
        }),
      close: () => socket.end(),
    };
    const push = (message: { id?: string; type?: string; error?: string; result?: unknown }) => {
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
        if (line.trim()) push(JSON.parse(line) as { id?: string; type?: string; error?: string; result?: unknown });
      }
    });
    socket.on("error", reject);
    socket.write(`${JSON.stringify({ id: "sub", type: "subscribe" })}\n`);
  });
}

test("engineroom-admin refuses reserved accounts before it changes anything", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "er-admin-script-"));
  const envFile = path.join(root, "hub.env");
  await writeFile(envFile, "ENGINEROOM_ADMIN=serveradmin\n");
  const script = path.join(import.meta.dirname, "../deploy/bin/engineroom-admin");
  try {
    const reserved = spawnSync("bash", [script, "revoke", "serveradmin"], {
      encoding: "utf8",
      env: { ...process.env, ENGINEROOM_HUB_ENV: envFile },
    });
    assert.notEqual(reserved.status, 0);
    assert.match(reserved.stderr, /must not change this account/);

    const removed = spawnSync("bash", [script, "remove", "serveradmin"], {
      encoding: "utf8",
      env: { ...process.env, ENGINEROOM_HUB_ENV: envFile },
    });
    assert.notEqual(removed.status, 0);
    assert.match(removed.stderr, /must not change this account/);

    const passwd = spawnSync("bash", [script, "passwd", "root"], { encoding: "utf8" });
    assert.match(passwd.stderr, /must not change this account/);

    const system = spawnSync("bash", [script, "add", "root"], { encoding: "utf8" });
    assert.match(system.stderr, /must not change this account/);

    const invalid = spawnSync("bash", [script, "add", "../root"], { encoding: "utf8" });
    assert.match(invalid.stderr, /invalid username/);

    const unprivileged = spawnSync("bash", [script, "add", "newperson"], { encoding: "utf8" });
    assert.match(unprivileged.stderr, /must run as root/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the administrator sees disk space and which commands are installed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "er-overview-"));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const checksFile = path.join(root, "checks.json");
  const socketDir = path.join(root, "socks");
  await mkdir(home);
  await mkdir(bin);
  await mkdir(socketDir);
  await writeFile(path.join(bin, "present"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(
    checksFile,
    JSON.stringify({ commands: ["present", "absent", "../secret", "bin/present", "present"] }),
  );
  const uid = process.getuid?.() ?? 1000;
  const user: LinuxUser = {
    username: "alice",
    uid,
    gid: process.getgid?.() ?? 1000,
    home,
    shell: "/bin/bash",
    groups: ["engineroom-users"],
  };
  const hub = createHub({
    link: { socketDir },
    sessionSecret: Buffer.from("overview-test-secret-value"),
    pamHelper: "/bin/false",
    cookieSecure: false,
    adminUser: "alice",
    checksFile,
    commandDirs: [bin],
    lookup: (username) => {
      if (username === "alice") return user;
      if (username === "carol") return { ...user, username: "carol", uid: uid + 1 };
      return null;
    },
    authenticate: async () => true,
  });
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
  try {
    const aliceLogin = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "secret" }),
    });
    const aliceCookie = (aliceLogin.headers.getSetCookie?.() ?? [])[0]?.split(";")[0];
    assert.ok(aliceCookie);
    const overview = await fetch(`${base}/api/admin/overview`, { headers: { Cookie: aliceCookie! } });
    assert.equal(overview.status, 200);
    const body = (await overview.json()) as {
      configFile: string;
      host: { node: string; memoryTotal: number; memoryFree: number; uptimeSeconds: number };
      disks: { path: string; total: number; free: number }[];
      commands: { name: string; available: boolean; path: string | null }[];
    };
    assert.equal(body.configFile, checksFile);
    assert.match(body.host.node, /^v/);
    assert.ok(body.host.memoryTotal > 0);
    assert.ok(body.host.memoryFree >= 0);
    assert.ok(body.host.uptimeSeconds >= 0);
    assert.ok(body.disks.length >= 1);
    for (const disk of body.disks) {
      assert.ok(disk.total > 0);
      assert.ok(disk.free >= 0);
      assert.ok(disk.free <= disk.total);
    }
    assert.deepEqual(
      body.commands.map((command) => command.name),
      ["present", "absent"],
    );
    assert.equal(body.commands[0]?.available, true);
    assert.equal(body.commands[0]?.path, path.join(bin, "present"));
    assert.equal(body.commands[1]?.available, false);
    assert.equal(body.commands[1]?.path, null);

    const carolLogin = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "carol", password: "secret" }),
    });
    const carolCookie = (carolLogin.headers.getSetCookie?.() ?? [])[0]?.split(";")[0];
    assert.ok(carolCookie);
    const denied = await fetch(`${base}/api/admin/overview`, { headers: { Cookie: carolCookie! } });
    assert.equal(denied.status, 403);
  } finally {
    hub.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("offered modes and models are probed, then narrowed per person", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "er-options-"));
  const aliceHome = path.join(root, "alice");
  const carolHome = path.join(root, "carol");
  const socketDir = path.join(root, "socks");
  const agentsFile = path.join(root, "agents.json");
  await mkdir(aliceHome);
  await mkdir(carolHome);
  await mkdir(socketDir);
  await writeFile(agentsFile, JSON.stringify({ cursor: true, claude: false, pi: true }));
  const uid = process.getuid?.() ?? 1000;
  const alice: LinuxUser = {
    username: "alice",
    uid,
    gid: process.getgid?.() ?? 1000,
    home: aliceHome,
    shell: "/bin/bash",
    groups: ["engineroom-users"],
  };
  const carol: LinuxUser = { ...alice, username: "carol", home: carolHome };
  const fake = path.resolve("test/fake-acp.mjs");
  const acp = new AcpManager({
    launch: async () => ({ binary: process.execPath, args: [fake] }),
  });
  const drivers: Record<AgentDriver["id"], AgentDriver> = {
    cursor: { id: "cursor", async run() { return { agentSessionId: null }; } },
    claude: { id: "claude", async run() { throw new Error("not used"); } },
    pi: { id: "pi", async run() { throw new Error("not used"); } },
  };
  const aliceRunner = await startRunner({
    home: aliceHome,
    socketPath: socketPathForUser(socketDir, "alice"),
    acp,
    drivers,
  });
  const carolRunner = await startRunner({
    home: carolHome,
    socketPath: socketPathForUser(socketDir, "carol"),
    drivers,
  });
  const hub = createHub({
    link: { socketDir },
    sessionSecret: Buffer.from("options-test-secret-value"),
    pamHelper: "/bin/false",
    cookieSecure: false,
    adminUser: "alice",
    agentsFile,
    lookup: (username) => (username === "alice" ? alice : username === "carol" ? carol : null),
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

    const hidden = (await (await fetch(`${base}/api/me`, { headers })).json()) as {
      options: { cursor?: { models: unknown[] } };
    };
    assert.deepEqual(hidden.options.cursor?.models ?? [], []);
    const early = await fetch(`${base}/api/chats`, {
      method: "POST",
      headers,
      body: JSON.stringify({ agent: "cursor", model: "fake", workspace: aliceHome }),
    });
    assert.equal(early.status, 400);

    const probed = await fetch(`${base}/api/admin/agent-options/cursor/probe`, { method: "POST", headers });
    assert.equal(probed.status, 200);
    const catalog = (await probed.json()) as { discovered: { modes: { id: string }[]; models: { id: string }[] }; offered: { modes: string[]; models: string[] } };
    assert.deepEqual(catalog.discovered.modes.map((mode) => mode.id), ["agent", "plan"]);
    assert.deepEqual(catalog.discovered.models.map((model) => model.id), ["fake"]);
    assert.deepEqual(catalog.offered, { modes: [], models: [] });

    const unknown = await fetch(`${base}/api/admin/agent-options`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ cursor: { modes: ["missing"], models: [] } }),
    });
    assert.equal(unknown.status, 400);
    const saved = await fetch(`${base}/api/admin/agent-options`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ cursor: { modes: ["agent", "plan"], models: ["fake"] } }),
    });
    assert.equal(saved.status, 200);
    const again = await fetch(`${base}/api/admin/agent-options/cursor/probe`, { method: "POST", headers });
    const kept = (await again.json()) as { offered: { models: string[] } };
    assert.deepEqual(kept.offered.models, ["fake"]);

    const me = (await (await fetch(`${base}/api/me`, { headers })).json()) as {
      options: { cursor: { modes: { id: string }[]; models: { id: string }[] } };
    };
    assert.deepEqual(me.options.cursor.models.map((model) => model.id), ["fake"]);
    const blank = await fetch(`${base}/api/chats`, {
      method: "POST",
      headers,
      body: JSON.stringify({ agent: "cursor", workspace: aliceHome }),
    });
    assert.equal(blank.status, 400);
    const wrong = await fetch(`${base}/api/chats`, {
      method: "POST",
      headers,
      body: JSON.stringify({ agent: "cursor", model: "other", workspace: aliceHome }),
    });
    assert.equal(wrong.status, 400);
    const created = await fetch(`${base}/api/chats`, {
      method: "POST",
      headers,
      body: JSON.stringify({ agent: "cursor", model: "fake", workspace: aliceHome }),
    });
    assert.equal(created.status, 201);
    const chat = (await created.json()) as { id: string };
    const badModel = await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ defaultModel: "other" }),
    });
    assert.equal(badModel.status, 400);
    const goodModel = await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ defaultModel: "fake" }),
    });
    assert.equal(goodModel.status, 200);

    const pi = await fetch(`${base}/api/admin/agent-options/pi/probe`, { method: "POST", headers });
    assert.equal(pi.status, 400);
    const piBody = (await pi.json()) as { error: string };
    assert.match(piBody.error, /does not report/);

    const policy = await fetch(`${base}/api/admin/users/carol/policy`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        agents: ["cursor"],
        rawTerminal: false,
        options: { cursor: { modes: ["plan", "secret"], models: [] } },
      }),
    });
    assert.equal(policy.status, 200);
    const storedPolicy = (await policy.json()) as { options: { cursor: { modes: string[]; models: string[] } } };
    assert.deepEqual(storedPolicy.options.cursor, { modes: ["plan"], models: [] });

    const carolLogin = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "carol", password: "secret" }),
    });
    const carolCookie = (carolLogin.headers.getSetCookie?.() ?? [])[0]?.split(";")[0];
    const carolHeaders = { Cookie: carolCookie!, "Content-Type": "application/json" };
    const carolMe = (await (await fetch(`${base}/api/me`, { headers: carolHeaders })).json()) as {
      options: { cursor: { modes: { id: string }[]; models: { id: string }[] } };
    };
    assert.deepEqual(carolMe.options.cursor.modes.map((mode) => mode.id), ["plan"]);
    assert.deepEqual(carolMe.options.cursor.models, []);
    const carolModel = await fetch(`${base}/api/chats`, {
      method: "POST",
      headers: carolHeaders,
      body: JSON.stringify({ agent: "cursor", model: "fake", workspace: carolHome }),
    });
    assert.equal(carolModel.status, 400);
    const carolChat = await fetch(`${base}/api/chats`, {
      method: "POST",
      headers: carolHeaders,
      body: JSON.stringify({ agent: "cursor", workspace: carolHome }),
    });
    assert.equal(carolChat.status, 201);
    const carolId = ((await carolChat.json()) as { id: string }).id;

    const messages: string[] = [];
    ws = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/api/ws`, {
      headers: { Cookie: cookie!, Origin: base },
    });
    ws.on("message", (data) => messages.push(data.toString()));
    await new Promise<void>((resolve, reject) => {
      ws?.once("open", () => resolve());
      ws?.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "set_mode", chatId: chat.id, modeId: "plan" }));
    const ready = Date.now() + 3000;
    let mode = "";
    while (mode !== "plan") {
      if (Date.now() > ready) throw new Error("mode was not saved");
      const detail = (await (await fetch(`${base}/api/chats/${chat.id}`, { headers })).json()) as { chat: { mode?: string } };
      mode = detail.chat.mode || "";
      if (mode !== "plan") await new Promise((resolve) => setTimeout(resolve, 20));
    }
    ws.send(JSON.stringify({ type: "set_mode", chatId: chat.id, modeId: "secret" }));
    const deniedAt = Date.now() + 3000;
    while (!messages.some((line) => line.includes("invalid mode"))) {
      if (Date.now() > deniedAt) throw new Error(`missing mode error: ${messages.join("\n")}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const carolWs = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/api/ws`, {
      headers: { Cookie: carolCookie!, Origin: base },
    });
    const carolMessages: string[] = [];
    carolWs.on("message", (data) => carolMessages.push(data.toString()));
    await new Promise<void>((resolve, reject) => {
      carolWs.once("open", () => resolve());
      carolWs.once("error", reject);
    });
    carolWs.send(JSON.stringify({ type: "set_mode", chatId: carolId, modeId: "agent" }));
    const carolDenied = Date.now() + 3000;
    while (!carolMessages.some((line) => line.includes("invalid mode"))) {
      if (Date.now() > carolDenied) throw new Error(`carol mode was allowed: ${carolMessages.join("\n")}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    carolWs.close();
  } finally {
    ws?.close();
    hub.close();
    await aliceRunner.close();
    await carolRunner.close();
    await rm(root, { recursive: true, force: true });
  }
});
