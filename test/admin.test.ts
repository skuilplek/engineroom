import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
import { archivePath } from "../apps/runner/src/archive.ts";
import { startRunner } from "../apps/runner/src/server.ts";
import { socketPathForUser } from "@engineroom/protocol";
import "./peercred-helper.ts";
import { installCommand } from "./command-stub.ts";

test("the administrator sets agents and accounts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "er-admin-"));
  const home = path.join(root, "home");
  const carolHome = path.join(root, "carol");
  const socketDir = path.join(root, "socks");
  const agentsFile = path.join(root, "agents.json");
  await mkdir(home);
  await mkdir(carolHome);
  await mkdir(socketDir);
  await installCommand(carolHome, "claude");
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
    const addedBody = (await added.json()) as { accounts?: Array<{ username: string }> };
    assert.deepEqual(addedBody.accounts?.map((account) => account.username), ["alice", "carol"]);
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

test("project creation can be turned off for the site or for one person", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "er-create-admin-"));
  const aliceHome = path.join(root, "alice");
  const carolHome = path.join(root, "carol");
  const socketDir = path.join(root, "socks");
  const reposFile = path.join(root, "repos.json");
  await mkdir(aliceHome, { recursive: true });
  await mkdir(carolHome, { recursive: true });
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
  let clones = 0;
  const clone = async (_url: string, dest: string) => {
    clones += 1;
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
    sessionSecret: Buffer.from("create-project-secret"),
    pamHelper: "/bin/false",
    cookieSecure: false,
    adminUser: "alice",
    reposFile,
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
    const carolLogin = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "carol", password: "secret" }),
    });
    const aliceCookie = (aliceLogin.headers.getSetCookie?.() ?? [])[0]?.split(";")[0];
    const carolCookie = (carolLogin.headers.getSetCookie?.() ?? [])[0]?.split(";")[0];
    assert.ok(aliceCookie);
    assert.ok(carolCookie);
    const aliceHeaders = { Cookie: aliceCookie!, "Content-Type": "application/json" };
    const carolHeaders = { Cookie: carolCookie!, "Content-Type": "application/json" };

    const blocked = await fetch(`${base}/api/repositories`, {
      method: "POST",
      headers: carolHeaders,
      body: JSON.stringify({ name: "widget", url: "https://example.com/widget.git" }),
    });
    assert.equal(blocked.status, 403);
    assert.equal(clones, 0);
    const before = (await (await fetch(`${base}/api/me`, { headers: carolHeaders })).json()) as { projectCreate: boolean };
    assert.equal(before.projectCreate, false);

    const enabled = await fetch(`${base}/api/admin/repository-folder`, {
      method: "PUT",
      headers: aliceHeaders,
      body: JSON.stringify({ directory: "Sites", projectCreate: true }),
    });
    assert.equal(enabled.status, 200);
    assert.equal(((await enabled.json()) as { projectCreate: boolean }).projectCreate, true);
    const offered = (await (await fetch(`${base}/api/me`, { headers: carolHeaders })).json()) as { projectCreate: boolean };
    assert.equal(offered.projectCreate, true);

    const deniedPerson = await fetch(`${base}/api/admin/users/carol/policy`, {
      method: "PUT",
      headers: aliceHeaders,
      body: JSON.stringify({ agents: ["cursor"], rawTerminal: true, projectCreate: false }),
    });
    assert.equal(deniedPerson.status, 200);
    const hidden = await fetch(`${base}/api/repositories`, {
      method: "POST",
      headers: carolHeaders,
      body: JSON.stringify({ name: "widget", url: "https://example.com/widget.git" }),
    });
    assert.equal(hidden.status, 403);
    assert.equal(clones, 0);
    const personal = (await (await fetch(`${base}/api/me`, { headers: carolHeaders })).json()) as { projectCreate: boolean };
    assert.equal(personal.projectCreate, false);

    const allowedPerson = await fetch(`${base}/api/admin/users/carol/policy`, {
      method: "PUT",
      headers: aliceHeaders,
      body: JSON.stringify({ agents: ["cursor"], rawTerminal: true, projectCreate: true }),
    });
    assert.equal(allowedPerson.status, 200);

    const created = await fetch(`${base}/api/repositories`, {
      method: "POST",
      headers: carolHeaders,
      body: JSON.stringify({ name: "widget", url: "https://example.com/widget.git" }),
    });
    assert.equal(created.status, 201);
    assert.equal(clones, 1);
    const widget = (await created.json()) as { name: string; path: string; enabled: boolean };
    assert.equal(widget.name, "widget");
    assert.equal(widget.enabled, true);

    const listed = (await (await fetch(`${base}/api/repositories`, { headers: carolHeaders })).json()) as Array<{ name: string }>;
    assert.equal(listed.some((entry) => entry.name === "widget"), true);

    const duplicate = await fetch(`${base}/api/repositories`, {
      method: "POST",
      headers: carolHeaders,
      body: JSON.stringify({ name: "widget", url: "https://example.com/widget.git" }),
    });
    assert.equal(duplicate.status, 400);

    const fresh = await fetch(`${base}/api/repositories`, {
      method: "POST",
      headers: carolHeaders,
      body: JSON.stringify({ name: "fresh" }),
    });
    assert.equal(fresh.status, 201);
    assert.equal(clones, 1);
    const empty = (await fresh.json()) as { path: string };
    assert.match(await readFile(path.join(empty.path, ".git", "HEAD"), "utf8"), /ref: refs\/heads\/main/);
    const after = (await (await fetch(`${base}/api/repositories`, { headers: carolHeaders })).json()) as Array<{ name: string }>;
    assert.deepEqual(after.map((entry) => entry.name).sort(), ["fresh", "widget"]);

    const escaped = await fetch(`${base}/api/repositories`, {
      method: "POST",
      headers: carolHeaders,
      body: JSON.stringify({ name: "../nope" }),
    });
    assert.equal(escaped.status, 400);
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

    const created = await fetch(`${base}/api/admin/agents/custom`, {
      method: "POST",
      headers,
      body: JSON.stringify({ label: "Harness", binary: "erharness" }),
    });
    assert.equal(created.status, 201);

    const agentSave = await fetch(`${base}/api/admin/agents`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        cursor: true,
        claude: true,
        pi: true,
        harness: true,
        binaries: { harness: "/bin/true" },
      }),
    });
    assert.equal(agentSave.status, 200);
    const savedAgents = JSON.parse(await readFile(agentsFile, "utf8")) as { agentBinaries?: unknown; piInstall?: string };
    assert.equal(savedAgents.agentBinaries, undefined);
    assert.equal(savedAgents.piInstall, undefined);

    const policy = await fetch(`${base}/api/admin/users/carol/policy`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ agents: ["cursor", "harness"], binaries: {}, rawTerminal: false }),
    });
    assert.equal(policy.status, 200);

    const missing = (await (await fetch(`${base}/api/me`, { headers: carolHeaders })).json()) as { agents: string[]; rawTerminal: boolean };
    assert.equal(missing.agents.includes("harness"), false);
    assert.equal(missing.rawTerminal, false);

    await installCommand(carolHome, "erharness");
    const installed = (await (await fetch(`${base}/api/me`, { headers: carolHeaders })).json()) as { agents: string[] };
    assert.equal(installed.agents.includes("harness"), true);

    const offerOff = await fetch(`${base}/api/admin/agents`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ cursor: true, claude: true, pi: true, harness: false }),
    });
    assert.equal(offerOff.status, 200);
    const hidden = (await (await fetch(`${base}/api/me`, { headers: carolHeaders })).json()) as { agents: string[] };
    assert.equal(hidden.agents.includes("harness"), false);

    const offerOn = await fetch(`${base}/api/admin/agents`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ cursor: true, claude: true, pi: true, harness: true }),
    });
    assert.equal(offerOn.status, 200);
    const notAllowed = await fetch(`${base}/api/admin/users/carol/policy`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ agents: ["cursor"], binaries: {}, rawTerminal: false }),
    });
    assert.equal(notAllowed.status, 200);
    const deniedHarness = (await (await fetch(`${base}/api/me`, { headers: carolHeaders })).json()) as { agents: string[] };
    assert.equal(deniedHarness.agents.includes("harness"), false);

    const blocked = await fetch(`${base}/api/chats`, {
      method: "POST",
      headers: carolHeaders,
      body: JSON.stringify({ agent: "pi", workspace: carolHome }),
    });
    assert.equal(blocked.status, 400);

    const settings = (await (await fetch(`${base}/api/settings`, { headers: carolHeaders })).json()) as {
      lockedBinaries?: string[];
      binaryOverride?: string[];
    };
    assert.equal(settings.lockedBinaries?.includes("cursor"), false);
    assert.equal(settings.binaryOverride?.includes("cursor"), false);

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

test("only installed agent commands are listed, and a custom agent can be added", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "er-agent-tabs-"));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const agentsFile = path.join(root, "agents.json");
  const socketDir = path.join(root, "socks");
  await mkdir(home);
  await mkdir(bin);
  await mkdir(socketDir);
  await writeFile(path.join(bin, "agent"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(path.join(bin, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(agentsFile, JSON.stringify({ cursor: true, claude: true, pi: false }));
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
    sessionSecret: Buffer.from("agent-tab-test-secret-value"),
    pamHelper: "/bin/false",
    cookieSecure: false,
    adminUser: "alice",
    agentsFile,
    commandDirs: [bin],
    lookup: (username) => (username === "alice" ? user : null),
    authenticate: async () => true,
  });
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
  try {
    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "secret" }),
    });
    const cookie = (login.headers.getSetCookie?.() ?? [])[0]?.split(";")[0];
    assert.ok(cookie);
    const listed = await fetch(`${base}/api/admin/agents`, { headers: { Cookie: cookie! } });
    assert.equal(listed.status, 200);
    const body = (await listed.json()) as {
      agents: { id: string; label: string; binary: string; available: boolean; path: string | null; builtin: boolean }[];
    };
    const cursor = body.agents.find((agent) => agent.id === "cursor");
    const claude = body.agents.find((agent) => agent.id === "claude");
    const pi = body.agents.find((agent) => agent.id === "pi");
    assert.equal(cursor?.label, "Cursor");
    assert.equal(cursor?.binary, "agent");
    assert.equal(cursor?.available, true);
    assert.equal(cursor?.path, path.join(bin, "agent"));
    assert.equal(claude?.label, "Claude");
    assert.equal(claude?.available, false);
    assert.equal(pi?.label, "Pi");
    assert.equal(pi?.available, false);

    const created = await fetch(`${base}/api/admin/agents/custom`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie! },
      body: JSON.stringify({ label: "Codex", binary: "codex" }),
    });
    assert.equal(created.status, 201);
    const added = (await created.json()) as { agents: { id: string; label: string; available: boolean; builtin: boolean; enabled: boolean }[] };
    const codex = added.agents.find((agent) => agent.id === "codex");
    assert.equal(codex?.label, "Codex");
    assert.equal(codex?.builtin, false);
    assert.equal(codex?.available, true);
    assert.equal(codex?.enabled, false);

    const missing = await fetch(`${base}/api/admin/agents/custom`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie! },
      body: JSON.stringify({ label: "Ghost", binary: "ghost" }),
    });
    assert.equal(missing.status, 201);
    const withGhost = (await missing.json()) as { agents: { id: string; available: boolean }[] };
    assert.equal(withGhost.agents.find((agent) => agent.id === "ghost")?.available, false);

    const removed = await fetch(`${base}/api/admin/agents/custom/ghost`, {
      method: "DELETE",
      headers: { Cookie: cookie! },
    });
    assert.equal(removed.status, 200);
    const after = (await removed.json()) as { agents: { id: string }[] };
    assert.equal(after.agents.some((agent) => agent.id === "ghost"), false);
    assert.equal(after.agents.some((agent) => agent.id === "codex"), true);
    const stored = JSON.parse(await readFile(agentsFile, "utf8")) as { customAgents: { id: string }[] };
    assert.deepEqual(stored.customAgents.map((agent) => agent.id), ["codex"]);

    const clash = await fetch(`${base}/api/admin/agents/custom`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie! },
      body: JSON.stringify({ label: "Cursor", binary: "agent" }),
    });
    assert.equal(clash.status, 400);
    const clashBody = (await clash.json()) as { error: string };
    assert.match(clashBody.error, /built-in agent/);

    const byPath = await fetch(`${base}/api/admin/agents/custom`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie! },
      body: JSON.stringify({ label: "Shop Agent", binary: path.join(bin, "codex") }),
    });
    assert.equal(byPath.status, 201);
    const pathed = (await byPath.json()) as { agents: { id: string; binary: string; available: boolean }[] };
    const shop = pathed.agents.find((agent) => agent.id === "shop-agent");
    assert.equal(shop?.binary, path.join(bin, "codex"));
    assert.equal(shop?.available, true);
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
      options: { cursor?: { modes?: unknown[]; models: unknown[] } };
    };
    assert.deepEqual(hidden.options.cursor?.models ?? [], []);
    assert.deepEqual(hidden.options.cursor?.modes ?? [], []);
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
    const beforeOffer = (await (await fetch(`${base}/api/me`, { headers })).json()) as {
      options: { cursor?: { modes?: unknown[]; models?: unknown[] } };
    };
    assert.deepEqual(beforeOffer.options.cursor?.modes ?? [], []);
    assert.deepEqual(beforeOffer.options.cursor?.models ?? [], []);

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

    const piBin = path.join(aliceHome, ".local", "bin");
    await mkdir(piBin, { recursive: true });
    const piRows = [
      { provider: "anthropic", model: "claude-sonnet-4", context: "200K", maxOut: "16K", thinking: "yes", images: "yes" },
      { provider: "openrouter", model: "recursive/flint-v1.0:free", context: "128K", maxOut: "8K", thinking: "no", images: "no" },
    ];
    const piHeaders = { provider: "provider", model: "model", context: "context", maxOut: "max-out", thinking: "thinking", images: "images" };
    const piWidth = (key: keyof typeof piHeaders) => Math.max(piHeaders[key].length, ...piRows.map((row) => row[key].length));
    const piLine = (row: typeof piHeaders) =>
      [row.provider.padEnd(piWidth("provider")), row.model.padEnd(piWidth("model")), row.context.padEnd(piWidth("context")), row.maxOut.padEnd(piWidth("maxOut")), row.thinking.padEnd(piWidth("thinking")), row.images.padEnd(piWidth("images"))].join(" ");
    const piTable = [piLine(piHeaders), ...piRows.map(piLine)].join("\n");
    await writeFile(path.join(piBin, "pi"), `#!/bin/sh\ncat <<'EOF'\n${piTable}\nEOF\n`);
    await chmod(path.join(piBin, "pi"), 0o755);
    const pi = await fetch(`${base}/api/admin/agent-options/pi/probe`, { method: "POST", headers });
    assert.equal(pi.status, 200);
    const piBody = (await pi.json()) as { discovered: { modes: unknown[]; models: { id: string; name: string }[] }; offered: { models: string[] } };
    assert.deepEqual(piBody.discovered.modes, []);
    assert.deepEqual(piBody.discovered.models, [
      { id: "anthropic/claude-sonnet-4", name: "anthropic/claude-sonnet-4" },
      { id: "openrouter/recursive/flint-v1.0:free", name: "recursive/flint-v1.0:free" },
    ]);
    assert.deepEqual(piBody.offered.models, []);
    const piUnknown = await fetch(`${base}/api/admin/agent-options`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ pi: { modes: [], models: ["missing/model"] } }),
    });
    assert.equal(piUnknown.status, 400);

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

test("the administrator controls repository file visibility for the file manager", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "er-files-admin-"));
  const home = path.join(root, "alice");
  const socketDir = path.join(root, "socks");
  const reposFile = path.join(root, "repos.json");
  const agentsFile = path.join(root, "agents.json");
  const repo = path.join(home, "Sites", "app");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(socketDir);
  await writeFile(agentsFile, JSON.stringify({ cursor: true, claude: true, pi: true }));

  spawnSync("git", ["init", "-b", "main"], { cwd: repo });
  await writeFile(path.join(repo, ".gitignore"), "secret.log\n");
  await writeFile(path.join(repo, ".env"), "TOKEN=abc\n");
  await writeFile(path.join(repo, "secret.log"), "ignored log\n");
  await writeFile(path.join(repo, "src", "main.ts"), "console.log('hi');\n");

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
  const hub = createHub({
    link: { socketDir },
    sessionSecret: Buffer.from("files-admin-secret"),
    pamHelper: "/bin/false",
    cookieSecure: false,
    adminUser: "alice",
    agentsFile,
    reposFile,
    lookup: (username) => (username === "alice" ? alice : null),
    authenticate: async () => true,
  });
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;

  try {
    const loginRes = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "secret" }),
    });
    const cookie = (loginRes.headers.getSetCookie?.() ?? [])[0]?.split(";")[0];
    assert.ok(cookie);
    const headers = { Cookie: cookie!, "Content-Type": "application/json" };

    const blockedFiles = await fetch(`${base}/api/repositories/files?workspace=${encodeURIComponent(repo)}`, { headers });
    assert.equal(blockedFiles.status, 403);
    const blockedFile = await fetch(
      `${base}/api/repositories/file?workspace=${encodeURIComponent(repo)}&path=${encodeURIComponent("src/main.ts")}`,
      { headers },
    );
    assert.equal(blockedFile.status, 403);

    const enabledAgents = await fetch(`${base}/api/admin/agents`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ cursor: true, claude: true, pi: true, fileManager: true }),
    });
    assert.equal(enabledAgents.status, 200);
    assert.equal(((await enabledAgents.json()) as { fileManager: boolean }).fileManager, true);

    const offered = (await (await fetch(`${base}/api/me`, { headers })).json()) as { fileManager: boolean; fileManagerOffered: boolean };
    assert.equal(offered.fileManagerOffered, true);
    assert.equal(offered.fileManager, true);
    const opened = await fetch(`${base}/api/repositories/files?workspace=${encodeURIComponent(repo)}`, { headers });
    assert.equal(opened.status, 200);

    const hiddenForPerson = await fetch(`${base}/api/admin/users/alice/policy`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ agents: ["cursor"], rawTerminal: true, fileManager: false }),
    });
    assert.equal(hiddenForPerson.status, 200);
    const stillBlocked = await fetch(`${base}/api/repositories/files?workspace=${encodeURIComponent(repo)}`, { headers });
    assert.equal(stillBlocked.status, 403);

    const policy = await fetch(`${base}/api/admin/users/alice/policy`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ agents: ["cursor"], rawTerminal: true, fileManager: true }),
    });
    assert.equal(policy.status, 200);
    const allowed = (await (await fetch(`${base}/api/me`, { headers })).json()) as { fileManager: boolean };
    assert.equal(allowed.fileManager, true);

    // Default visibility hides .env, secret.log, and .git
    const initialList = (await (
      await fetch(`${base}/api/repositories/files?workspace=${encodeURIComponent(repo)}`, { headers })
    ).json()) as { files: Array<{ path: string }> };
    assert.deepEqual(
      initialList.files.map((f) => f.path),
      ["src", "src/main.ts"],
    );

    const blockedHidden = await fetch(
      `${base}/api/repositories/file?workspace=${encodeURIComponent(repo)}&path=${encodeURIComponent(".env")}`,
      { headers },
    );
    assert.equal(blockedHidden.status, 403);

    // Admin enables showHidden and showGitignored
    const savedConfig = await fetch(`${base}/api/admin/repository-folder`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        directory: "Sites",
        visibility: { showHidden: true, showGitignored: true, showGitDir: false },
      }),
    });
    assert.equal(savedConfig.status, 200);

    const updatedList = (await (
      await fetch(`${base}/api/repositories/files?workspace=${encodeURIComponent(repo)}`, { headers })
    ).json()) as { files: Array<{ path: string }> };
    const updatedPaths = updatedList.files.map((f) => f.path);
    assert.equal(updatedPaths.includes(".env"), true);
    assert.equal(updatedPaths.includes("secret.log"), true);
    assert.equal(updatedPaths.includes(".git"), false);

    const allowedHidden = await fetch(
      `${base}/api/repositories/file?workspace=${encodeURIComponent(repo)}&path=${encodeURIComponent(".env")}`,
      { headers },
    );
    assert.equal(allowedHidden.status, 200);
    const envContent = (await allowedHidden.json()) as { content: string };
    assert.equal(envContent.content, "TOKEN=abc\n");

    // File CRUD via hub routes works when fileEditor is enabled and filesReadOnly is false
    const createRes = await fetch(`${base}/api/repositories/file`, {
      method: "POST",
      headers,
      body: JSON.stringify({ workspace: repo, path: "src/helper.ts", kind: "file", content: "export const h = 1;\n" }),
    });
    assert.equal(createRes.status, 201);

    const writeRes = await fetch(`${base}/api/repositories/file`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ workspace: repo, path: "src/helper.ts", content: "export const h = 2;\n" }),
    });
    assert.equal(writeRes.status, 200);
    assert.equal(((await writeRes.json()) as { content: string }).content, "export const h = 2;\n");

    const renameRes = await fetch(`${base}/api/repositories/file`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ workspace: repo, path: "src/helper.ts", newPath: "src/util.ts" }),
    });
    assert.equal(renameRes.status, 200);

    // User enables filesReadOnly in their settings -> mutations return 403
    const setReadOnly = await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ filesReadOnly: true }),
    });
    assert.equal(setReadOnly.status, 200);

    const blockedByUserSetting = await fetch(`${base}/api/repositories/file`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ workspace: repo, path: "src/util.ts", content: "nope" }),
    });
    assert.equal(blockedByUserSetting.status, 403);

    // Turn user filesReadOnly back off, then disable global fileEditor via admin -> 403
    await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ filesReadOnly: false }),
    });
    await fetch(`${base}/api/admin/agents`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ cursor: true, claude: true, pi: true, fileManager: true, fileEditor: false }),
    });
    const blockedByAdmin = await fetch(
      `${base}/api/repositories/file?workspace=${encodeURIComponent(repo)}&path=${encodeURIComponent("src/util.ts")}`,
      { method: "DELETE", headers },
    );
    assert.equal(blockedByAdmin.status, 403);

    // Re-enable global fileEditor and delete the file
    await fetch(`${base}/api/admin/agents`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ cursor: true, claude: true, pi: true, fileManager: true, fileEditor: true }),
    });
    const deleteRes = await fetch(
      `${base}/api/repositories/file?workspace=${encodeURIComponent(repo)}&path=${encodeURIComponent("src/util.ts")}`,
      { method: "DELETE", headers },
    );
    assert.equal(deleteRes.status, 200);
  } finally {
    hub.close();
    await runner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the administrator controls file download and upload separately from editing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "er-transfer-admin-"));
  const home = path.join(root, "alice");
  const socketDir = path.join(root, "socks");
  const reposFile = path.join(root, "repos.json");
  const agentsFile = path.join(root, "agents.json");
  const repo = path.join(home, "Sites", "app");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(socketDir);
  await writeFile(agentsFile, JSON.stringify({ cursor: true, claude: true, pi: true }));
  spawnSync("git", ["init", "-b", "main"], { cwd: repo });
  await writeFile(path.join(repo, ".env"), "TOKEN=abc\n");
  await writeFile(path.join(repo, "src", "main.ts"), "console.log('hi');\n");

  const uid = process.getuid?.() ?? 1000;
  const alice: LinuxUser = {
    username: "alice",
    uid,
    gid: process.getgid?.() ?? 1000,
    home,
    shell: "/bin/bash",
    groups: ["engineroom-users"],
  };
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
  const hub = createHub({
    link: { socketDir },
    sessionSecret: Buffer.from("transfer-admin-secret"),
    pamHelper: "/bin/false",
    cookieSecure: false,
    adminUser: "alice",
    agentsFile,
    reposFile,
    lookup: (username) => (username === "alice" ? alice : null),
    authenticate: async () => true,
  });
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
  const downloadUrl = `${base}/api/repositories/file/download?workspace=${encodeURIComponent(repo)}&path=${encodeURIComponent("src/main.ts")}`;

  async function upload(cookie: string, name: string, bytes: Buffer, overwrite: boolean) {
    const form = new FormData();
    form.set("workspace", repo);
    form.set("directory", "src");
    form.set("overwrite", overwrite ? "true" : "false");
    form.append("file", new Blob([bytes]), name);
    return fetch(`${base}/api/repositories/file/upload`, { method: "POST", headers: { Cookie: cookie }, body: form });
  }

  try {
    const loginRes = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "secret" }),
    });
    const cookie = (loginRes.headers.getSetCookie?.() ?? [])[0]?.split(";")[0];
    assert.ok(cookie);
    const headers = { Cookie: cookie!, "Content-Type": "application/json" };

    assert.equal((await fetch(downloadUrl, { headers })).status, 403);
    const agents = { cursor: true, claude: true, pi: true };
    const enabledManager = await fetch(`${base}/api/admin/agents`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ ...agents, fileManager: true }),
    });
    assert.equal(enabledManager.status, 200);
    assert.equal((await fetch(`${base}/api/repositories/files?workspace=${encodeURIComponent(repo)}`, { headers })).status, 200);
    assert.equal((await fetch(downloadUrl, { headers })).status, 403);
    assert.equal((await upload(cookie!, "blob.bin", Buffer.from([1, 2, 3]), false)).status, 403);
    const before = (await (await fetch(`${base}/api/me`, { headers })).json()) as {
      fileDownload: boolean;
      fileUpload: boolean;
      fileDownloadOffered: boolean;
      fileUploadOffered: boolean;
    };
    assert.equal(before.fileDownload, false);
    assert.equal(before.fileUpload, false);
    assert.equal(before.fileDownloadOffered, false);
    assert.equal(before.fileUploadOffered, false);

    const enabledDownload = await fetch(`${base}/api/admin/agents`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ ...agents, fileManager: true, fileDownload: true }),
    });
    assert.equal(enabledDownload.status, 200);
    assert.equal(((await enabledDownload.json()) as { fileDownload: boolean }).fileDownload, true);
    const offered = (await (await fetch(`${base}/api/me`, { headers })).json()) as { fileDownload: boolean; fileDownloadOffered: boolean; fileUpload: boolean };
    assert.equal(offered.fileDownloadOffered, true);
    assert.equal(offered.fileDownload, true);
    assert.equal(offered.fileUpload, false);
    const downloaded = await fetch(downloadUrl, { headers });
    assert.equal(downloaded.status, 200);
    assert.match(downloaded.headers.get("content-disposition") || "", /attachment;/);
    assert.match(downloaded.headers.get("content-disposition") || "", /main\.ts/);
    assert.equal(Buffer.from(await downloaded.arrayBuffer()).toString("utf8"), "console.log('hi');\n");
    assert.equal((await upload(cookie!, "blob.bin", Buffer.from([1, 2, 3]), false)).status, 403);

    const hideDownload = await fetch(`${base}/api/admin/users/alice/policy`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ agents: ["cursor"], rawTerminal: true, fileManager: true, fileDownload: false }),
    });
    assert.equal(hideDownload.status, 200);
    assert.equal((await fetch(downloadUrl, { headers })).status, 403);

    await fetch(`${base}/api/admin/users/alice/policy`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ agents: ["cursor"], rawTerminal: true, fileManager: true, fileDownload: true, fileUpload: true }),
    });
    await fetch(`${base}/api/admin/agents`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ ...agents, fileManager: true, fileEditor: false, fileDownload: true, fileUpload: true }),
    });
    const payload = Buffer.from([0, 1, 255, 10]);
    const created = await upload(cookie!, "blob.bin", payload, false);
    assert.equal(created.status, 201);
    assert.equal(((await created.json()) as { files: Array<{ path: string }> }).files[0]?.path, "src/blob.bin");
    const binary = await fetch(
      `${base}/api/repositories/file/download?workspace=${encodeURIComponent(repo)}&path=${encodeURIComponent("src/blob.bin")}`,
      { headers },
    );
    assert.equal(binary.status, 200);
    assert.deepEqual(Buffer.from(await binary.arrayBuffer()), payload);

    await fetch(`${base}/api/admin/users/alice/policy`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ agents: ["cursor"], rawTerminal: true, fileManager: true, fileDownload: true, fileUpload: false }),
    });
    assert.equal((await upload(cookie!, "other.bin", Buffer.from("no"), false)).status, 403);
    assert.equal((await fetch(downloadUrl, { headers })).status, 200);

    await fetch(`${base}/api/admin/users/alice/policy`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ agents: ["cursor"], rawTerminal: true, fileManager: true, fileDownload: true, fileUpload: true }),
    });
    assert.equal((await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ filesReadOnly: true }),
    })).status, 200);
    assert.equal((await upload(cookie!, "other.bin", Buffer.from("no"), false)).status, 403);
    assert.equal((await fetch(downloadUrl, { headers })).status, 200);
    assert.equal((await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ filesReadOnly: false }),
    })).status, 200);

    assert.equal((await upload(cookie!, "blob.bin", Buffer.from("next"), false)).status, 409);
    const replaced = await upload(cookie!, "blob.bin", Buffer.from("next"), true);
    assert.equal(replaced.status, 201);
    assert.equal(await readFile(path.join(repo, "src", "blob.bin"), "utf8"), "next");

    const hidden = await fetch(
      `${base}/api/repositories/file/download?workspace=${encodeURIComponent(repo)}&path=${encodeURIComponent(".env")}`,
      { headers },
    );
    assert.equal(hidden.status, 403);
    const directory = await fetch(
      `${base}/api/repositories/file/download?workspace=${encodeURIComponent(repo)}&path=${encodeURIComponent("src")}`,
      { headers },
    );
    assert.equal(directory.status, 400);
  } finally {
    hub.close();
    await runner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the administrator can read another user's chats and transcripts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "er-user-chats-"));
  const aliceHome = path.join(root, "alice");
  const carolHome = path.join(root, "carol");
  const socketDir = path.join(root, "socks");
  await mkdir(aliceHome);
  await mkdir(carolHome);
  await mkdir(socketDir);
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
  const drivers: Record<AgentDriver["id"], AgentDriver> = {
    cursor: { id: "cursor", async run() { throw new Error("not used"); } },
    claude: { id: "claude", async run() { throw new Error("not used"); } },
    pi: { id: "pi", async run() { throw new Error("not used"); } },
  };
  const aliceRunner = await startRunner({
    home: aliceHome,
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
    sessionSecret: Buffer.from("user-chats-secret-value"),
    pamHelper: "/bin/false",
    cookieSecure: false,
    adminUser: "alice",
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

    const created = await fetch(`${base}/api/chats`, {
      method: "POST",
      headers: carolHeaders,
      body: JSON.stringify({ agent: "cursor", workspace: carolHome, title: "Login bug" }),
    });
    assert.equal(created.status, 201);
    const chat = (await created.json()) as { id: string; title: string };
    const transcript = [
      JSON.stringify({ kind: "user", text: "Why does login fail?", at: "2026-10-18T12:00:00.000Z", seq: 1 }),
      JSON.stringify({ kind: "text", text: "The session cookie was not set.", at: "2026-10-18T12:00:01.000Z", seq: 2 }),
    ].join("\n") + "\n";
    await writeFile(path.join(carolHome, ".engineroom", "chats", chat.id, "transcript.jsonl"), transcript);

    const denied = await fetch(`${base}/api/admin/users/carol/chats`, { headers: carolHeaders });
    assert.equal(denied.status, 403);
    const deniedDetail = await fetch(`${base}/api/admin/users/carol/chats/${chat.id}`, { headers: carolHeaders });
    assert.equal(deniedDetail.status, 403);

    const listed = await fetch(`${base}/api/admin/users/carol/chats`, { headers: aliceHeaders });
    assert.equal(listed.status, 200);
    const chats = (await listed.json()) as Array<{ id: string; title: string; agent: string }>;
    assert.deepEqual(chats.map((item) => item.id), [chat.id]);
    assert.equal(chats[0]?.title, "Login bug");
    assert.equal(chats[0]?.agent, "cursor");

    const detail = await fetch(`${base}/api/admin/users/carol/chats/${chat.id}`, { headers: aliceHeaders });
    assert.equal(detail.status, 200);
    const body = (await detail.json()) as {
      chat: { id: string; title: string };
      transcript: Array<{ kind: string; text: string }>;
    };
    assert.equal(body.chat.id, chat.id);
    assert.equal(body.chat.title, "Login bug");
    assert.deepEqual(
      body.transcript.map((entry) => ({ kind: entry.kind, text: entry.text })),
      [
        { kind: "user", text: "Why does login fail?" },
        { kind: "text", text: "The session cookie was not set." },
      ],
    );

    const missing = await fetch(`${base}/api/admin/users/carol/chats/not-a-chat`, { headers: aliceHeaders });
    assert.equal(missing.status, 400);
  } finally {
    hub.close();
    await aliceRunner.close();
    await carolRunner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an agent command in the person's home stays theirs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "er-home-agent-"));
  const home = path.join(root, "home");
  const bin = path.join(home, ".local", "bin");
  const agentsFile = path.join(root, "agents.json");
  const socketDir = path.join(root, "socks");
  await mkdir(bin, { recursive: true });
  await mkdir(socketDir);
  await writeFile(path.join(bin, "agent"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
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
  const runner = await startRunner({ home, socketPath: socketPathForUser(socketDir, "alice"), peerCheck: () => undefined });
  const hub = createHub({
    link: { socketDir },
    sessionSecret: Buffer.from("home-agent-test-secret-value"),
    pamHelper: "/bin/false",
    cookieSecure: false,
    adminUser: "alice",
    agentsFile,
    commandDirs: [path.join(root, "empty")],
    lookup: (username) => (username === "alice" ? user : null),
    authenticate: async () => true,
  });
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
  try {
    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "secret" }),
    });
    const cookie = (login.headers.getSetCookie?.() ?? [])[0]?.split(";")[0];
    assert.ok(cookie);
    const listed = await fetch(`${base}/api/admin/agents`, { headers: { Cookie: cookie! } });
    assert.equal(listed.status, 200);
    const body = (await listed.json()) as { agents: { id: string; available: boolean; path: string | null }[] };
    const cursor = body.agents.find((agent) => agent.id === "cursor");
    assert.notEqual(cursor?.path, path.join(bin, "agent"));
    const mine = (await (await fetch(`${base}/api/me`, { headers: { Cookie: cookie! } })).json()) as { agents: string[] };
    assert.ok(mine.agents.includes("cursor"));
  } finally {
    hub.close();
    await runner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the administrator controls project downloads", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "er-project-download-"));
  const home = path.join(root, "alice");
  const socketDir = path.join(root, "socks");
  const reposFile = path.join(root, "repos.json");
  const agentsFile = path.join(root, "agents.json");
  const repo = path.join(home, "Sites", "app");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(socketDir);
  await writeFile(agentsFile, JSON.stringify({ cursor: true, claude: true, pi: true }));
  await writeFile(path.join(repo, "src", "note.txt"), "hello\n");
  spawnSync("git", ["init", "-b", "main"], { cwd: repo });
  const uid = process.getuid?.() ?? 1000;
  const alice: LinuxUser = {
    username: "alice",
    uid,
    gid: process.getgid?.() ?? 1000,
    home,
    shell: "/bin/bash",
    groups: ["engineroom-users"],
  };
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
  const hub = createHub({
    link: { socketDir },
    sessionSecret: Buffer.from("project-download-secret"),
    pamHelper: "/bin/false",
    cookieSecure: false,
    adminUser: "alice",
    agentsFile,
    reposFile,
    lookup: (username) => (username === "alice" ? alice : null),
    authenticate: async () => true,
  });
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
  let zipName = "";
  try {
    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "secret" }),
    });
    const cookie = (login.headers.getSetCookie?.() ?? [])[0]?.split(";")[0];
    assert.ok(cookie);
    const headers = { Cookie: cookie!, "Content-Type": "application/json" };
    const before = (await (await fetch(`${base}/api/me`, { headers })).json()) as { projectDownloads: boolean };
    assert.equal(before.projectDownloads, false);
    const listed = (await (await fetch(`${base}/api/repositories`, { headers })).json()) as Array<{ path: string; name: string }>;
    const project = listed.find((entry) => entry.name === "app");
    assert.ok(project);
    const blocked = await fetch(`${base}/api/repositories/archive`, {
      method: "POST",
      headers,
      body: JSON.stringify({ workspace: project!.path }),
    });
    assert.equal(blocked.status, 403);

    const saved = await fetch(`${base}/api/admin/repository-folder`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ directory: "Sites", projectDownloads: true }),
    });
    assert.equal(saved.status, 200);
    assert.equal(((await saved.json()) as { projectDownloads: boolean }).projectDownloads, true);
    const after = (await (await fetch(`${base}/api/me`, { headers })).json()) as { projectDownloads: boolean };
    assert.equal(after.projectDownloads, true);

    const started = await fetch(`${base}/api/repositories/archive`, {
      method: "POST",
      headers,
      body: JSON.stringify({ workspace: project!.path }),
    });
    assert.equal(started.status, 200);
    const job = (await started.json()) as { id: string; filename: string; status: string };
    assert.equal(job.status, "creating");
    assert.match(job.filename, /^app-\d{10}\.zip$/);
    zipName = job.filename;
    let finished: { status: string; error?: string; filename: string } | undefined;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const status = await fetch(`${base}/api/repositories/archive?id=${encodeURIComponent(job.id)}`, { headers });
      assert.equal(status.status, 200);
      finished = (await status.json()) as { status: string; error?: string; filename: string };
      if (finished.status !== "creating") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(finished?.status, "ready", finished?.error);
    const download = await fetch(`${base}/api/repositories/archive/download?id=${encodeURIComponent(job.id)}`, { headers });
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition") || "", /app-/);
    const bytes = Buffer.from(await download.arrayBuffer());
    assert.equal(bytes.subarray(0, 2).toString(), "PK");
    assert.equal(bytes.length > 22, true);
  } finally {
    hub.close();
    await runner.close();
    if (zipName) await rm(archivePath(zipName), { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("a person can archive and delete a project", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "er-project-life-"));
  const home = path.join(root, "alice");
  const socketDir = path.join(root, "socks");
  const reposFile = path.join(root, "repos.json");
  const agentsFile = path.join(root, "agents.json");
  const repo = path.join(home, "Sites", "app");
  await mkdir(path.join(repo, ".git"), { recursive: true });
  await mkdir(socketDir);
  await writeFile(agentsFile, JSON.stringify({ cursor: true, claude: true, pi: true }));
  const uid = process.getuid?.() ?? 1000;
  const alice: LinuxUser = {
    username: "alice",
    uid,
    gid: process.getgid?.() ?? 1000,
    home,
    shell: "/bin/bash",
    groups: ["engineroom-users"],
  };
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
  const hub = createHub({
    link: { socketDir },
    sessionSecret: Buffer.from("project-life-secret"),
    pamHelper: "/bin/false",
    cookieSecure: false,
    adminUser: "alice",
    agentsFile,
    reposFile,
    lookup: (username) => (username === "alice" ? alice : null),
    authenticate: async () => true,
  });
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
  try {
    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "secret" }),
    });
    const cookie = (login.headers.getSetCookie?.() ?? [])[0]?.split(";")[0];
    assert.ok(cookie);
    const headers = { Cookie: cookie!, "Content-Type": "application/json" };
    const listed = (await (await fetch(`${base}/api/repositories`, { headers })).json()) as Array<{ path: string; name: string; archived: boolean }>;
    const project = listed.find((entry) => entry.name === "app");
    assert.ok(project);
    assert.equal(project.archived, false);

    const archived = await fetch(`${base}/api/repositories/archived`, {
      method: "POST",
      headers,
      body: JSON.stringify({ workspace: project.path, archived: true }),
    });
    assert.equal(archived.status, 200);
    const archivedList = (await archived.json()) as Array<{ name: string; archived: boolean }>;
    assert.equal(archivedList.find((entry) => entry.name === "app")?.archived, true);
    await stat(repo);

    const visible = (await (await fetch(`${base}/api/repositories`, { headers })).json()) as Array<{ name: string; archived: boolean }>;
    assert.equal(visible.find((entry) => entry.name === "app")?.archived, true);

    const restored = await fetch(`${base}/api/repositories/archived`, {
      method: "POST",
      headers,
      body: JSON.stringify({ workspace: project.path, archived: false }),
    });
    assert.equal(restored.status, 200);
    const restoredList = (await restored.json()) as Array<{ name: string; archived: boolean }>;
    assert.equal(restoredList.find((entry) => entry.name === "app")?.archived, false);

    const mismatch = await fetch(`${base}/api/repositories`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ workspace: project.path, name: "nope" }),
    });
    assert.equal(mismatch.status, 400);
    await stat(repo);

    const removed = await fetch(`${base}/api/repositories`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ workspace: project.path, name: "app" }),
    });
    assert.equal(removed.status, 200);
    await assert.rejects(() => stat(repo));
    const after = (await (await fetch(`${base}/api/repositories`, { headers })).json()) as Array<{ name: string }>;
    assert.equal(after.some((entry) => entry.name === "app"), false);
  } finally {
    hub.close();
    await runner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("harness defaults apply only within each person's agents and models", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "er-defaults-"));
  const aliceHome = path.join(root, "alice");
  const bobHome = path.join(root, "bob");
  const socketDir = path.join(root, "socks");
  const agentsFile = path.join(root, "agents.json");
  await mkdir(aliceHome, { recursive: true });
  await mkdir(path.join(bobHome, ".cursor"), { recursive: true });
  await mkdir(path.join(aliceHome, ".pi", "agent"), { recursive: true });
  await mkdir(socketDir);
  await writeFile(path.join(aliceHome, ".pi", "agent", "settings.json"), `${JSON.stringify({ lastChangelogVersion: "1.4.0" })}\n`);
  await writeFile(path.join(bobHome, ".cursor", "cli-config.json"), `${JSON.stringify({
    authInfo: { email: "bob@example.com" },
    permissions: { allow: ["Shell(old)", "Write(/tmp/x)"], deny: ["Shell(rm)"] },
    model: { modelId: "other-model" },
    modelParameters: {
      "grok-4.7": [{ id: "fast", value: "true" }],
      "gemini-4-argon": [{ id: "reasoning_effort", value: "medium" }],
    },
    sandbox: { mode: "disabled" },
  })}\n`);
  await writeFile(agentsFile, JSON.stringify({
    cursor: true,
    claude: false,
    pi: true,
    piProvider: "openrouter",
    piModel: "recursive/flint-v1.0:free",
    cursorCommands: ["ls", "npm install"],
  }));
  await writeFile(path.join(root, "agent-options.json"), JSON.stringify({
    cursor: {
      discovered: {
        modes: [],
        models: [{ id: "grok-4.7", name: "Grok" }, { id: "other", name: "Other" }],
        probedAt: "2026-01-01T00:00:00.000Z",
      },
      offered: { modes: [], models: ["grok-4.7", "other"] },
    },
    pi: {
      discovered: {
        modes: [],
        models: [{ id: "openrouter/recursive/flint-v1.0:free", name: "recursive/flint-v1.0:free" }],
        probedAt: "2026-01-01T00:00:00.000Z",
      },
      offered: { modes: [], models: ["openrouter/recursive/flint-v1.0:free"] },
    },
  }));
  const uid = process.getuid?.() ?? 1000;
  const alice: LinuxUser = {
    username: "alice",
    uid,
    gid: process.getgid?.() ?? 1000,
    home: aliceHome,
    shell: "/bin/bash",
    groups: ["engineroom-users"],
  };
  const bob: LinuxUser = { ...alice, username: "bob", home: bobHome };
  const drivers: Record<AgentDriver["id"], AgentDriver> = {
    cursor: { id: "cursor", async run() { return { agentSessionId: null }; } },
    claude: { id: "claude", async run() { throw new Error("not used"); } },
    pi: { id: "pi", async run() { throw new Error("not used"); } },
  };
  const aliceRunner = await startRunner({ home: aliceHome, socketPath: socketPathForUser(socketDir, "alice"), drivers });
  const bobRunner = await startRunner({ home: bobHome, socketPath: socketPathForUser(socketDir, "bob"), drivers });
  const hub = createHub({
    link: { socketDir },
    sessionSecret: Buffer.from("defaults-test-secret-value"),
    pamHelper: "/bin/false",
    cookieSecure: false,
    adminUser: "alice",
    agentsFile,
    listAccounts: () => [
      { username: "alice", home: aliceHome, uid },
      { username: "bob", home: bobHome, uid },
    ],
    lookup: (username) => (username === "alice" ? alice : username === "bob" ? bob : null),
    authenticate: async () => true,
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
    const policy = await fetch(`${base}/api/admin/users/bob/policy`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        agents: ["cursor"],
        rawTerminal: false,
        options: { cursor: { modes: [], models: ["other"] } },
      }),
    });
    assert.equal(policy.status, 200);

    const cursor = await fetch(`${base}/api/admin/agent-defaults`, {
      method: "POST",
      headers,
      body: JSON.stringify({ agent: "cursor" }),
    });
    assert.equal(cursor.status, 200);
    const cursorBody = (await cursor.json()) as {
      applied: { username: string; model: boolean; commands: boolean }[];
      skipped: { username: string }[];
    };
    assert.equal(cursorBody.skipped.length, 0);
    assert.equal(cursorBody.applied.find((item) => item.username === "alice")?.model, true);
    assert.equal(cursorBody.applied.find((item) => item.username === "bob")?.model, false);
    assert.equal(cursorBody.applied.find((item) => item.username === "bob")?.commands, true);

    const aliceCursor = JSON.parse(await readFile(path.join(aliceHome, ".cursor", "cli-config.json"), "utf8")) as {
      version: number;
      model: { modelId: string; displayName: string };
      selectedModel: { parameters: { id: string; value: string }[] };
      permissions: { allow: string[] };
      authInfo?: unknown;
    };
    assert.equal(aliceCursor.version, 1);
    assert.equal(aliceCursor.model.modelId, "grok-4.7");
    assert.equal(aliceCursor.model.displayName, "Grok 4.7 256K High");
    assert.equal(aliceCursor.selectedModel.parameters.find((item) => item.id === "fast")?.value, "false");
    assert.deepEqual(aliceCursor.permissions.allow, ["Shell(ls)", "Shell(npm install)"]);
    assert.equal(aliceCursor.authInfo, undefined);

    const bobCursor = JSON.parse(await readFile(path.join(bobHome, ".cursor", "cli-config.json"), "utf8")) as {
      authInfo: { email: string };
      model: { modelId: string };
      modelParameters: { "grok-4.7": { id: string; value: string }[]; "gemini-4-argon": unknown };
      permissions: { allow: string[]; deny: string[] };
      sandbox: { mode: string };
    };
    assert.equal(bobCursor.authInfo.email, "bob@example.com");
    assert.equal(bobCursor.model.modelId, "other-model");
    assert.equal(bobCursor.modelParameters["grok-4.7"].find((item) => item.id === "fast")?.value, "true");
    assert.deepEqual(bobCursor.modelParameters["gemini-4-argon"], [{ id: "reasoning_effort", value: "medium" }]);
    assert.deepEqual(bobCursor.permissions.allow, ["Shell(ls)", "Shell(npm install)", "Write(/tmp/x)"]);
    assert.deepEqual(bobCursor.permissions.deny, ["Shell(rm)"]);
    assert.equal(bobCursor.sandbox.mode, "disabled");

    const edited = await fetch(`${base}/api/admin/users/bob/cursor-commands`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ commands: ["cat"] }),
    });
    assert.equal(edited.status, 200);
    const editedFile = JSON.parse(await readFile(path.join(bobHome, ".cursor", "cli-config.json"), "utf8")) as {
      model: { modelId: string };
      permissions: { allow: string[] };
    };
    assert.equal(editedFile.model.modelId, "other-model");
    assert.deepEqual(editedFile.permissions.allow, ["Shell(cat)", "Write(/tmp/x)"]);

    const own = await fetch(`${base}/api/cursor-commands`, { headers });
    assert.equal(own.status, 200);
    assert.deepEqual(((await own.json()) as { commands: string[] }).commands, ["ls", "npm install"]);
    const ownSaved = await fetch(`${base}/api/cursor-commands`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ commands: ["echo"] }),
    });
    assert.equal(ownSaved.status, 200);
    const aliceAfter = JSON.parse(await readFile(path.join(aliceHome, ".cursor", "cli-config.json"), "utf8")) as {
      model: { modelId: string };
      selectedModel: { parameters: { id: string; value: string }[] };
      permissions: { allow: string[] };
    };
    assert.equal(aliceAfter.model.modelId, "grok-4.7");
    assert.equal(aliceAfter.selectedModel.parameters.find((item) => item.id === "fast")?.value, "false");
    assert.deepEqual(aliceAfter.permissions.allow, ["Shell(echo)"]);

    const single = await fetch(`${base}/api/admin/agent-defaults`, {
      method: "POST",
      headers,
      body: JSON.stringify({ agent: "cursor", username: "bob" }),
    });
    assert.equal(single.status, 200);
    const singleBody = (await single.json()) as {
      applied: { username: string; model: boolean; commands: boolean }[];
      skipped: { username: string }[];
    };
    assert.deepEqual(singleBody.applied.map((item) => item.username), ["bob"]);
    assert.equal(singleBody.applied[0]?.model, false);
    assert.equal(singleBody.applied[0]?.commands, true);
    assert.equal(singleBody.skipped.length, 0);
    const aliceAfterSingle = JSON.parse(await readFile(path.join(aliceHome, ".cursor", "cli-config.json"), "utf8")) as {
      model: { modelId: string };
      permissions: { allow: string[] };
    };
    assert.equal(aliceAfterSingle.model.modelId, "grok-4.7");
    assert.deepEqual(aliceAfterSingle.permissions.allow, ["Shell(echo)"]);
    const bobAfterSingle = JSON.parse(await readFile(path.join(bobHome, ".cursor", "cli-config.json"), "utf8")) as {
      model: { modelId: string };
      permissions: { allow: string[] };
    };
    assert.equal(bobAfterSingle.model.modelId, "other-model");
    assert.deepEqual(bobAfterSingle.permissions.allow, ["Shell(ls)", "Shell(npm install)", "Write(/tmp/x)"]);

    const unknown = await fetch(`${base}/api/admin/agent-defaults`, {
      method: "POST",
      headers,
      body: JSON.stringify({ agent: "cursor", username: "nobody" }),
    });
    assert.equal(unknown.status, 404);

    const empty = await fetch(`${base}/api/admin/agent-defaults`, {
      method: "POST",
      headers,
      body: JSON.stringify({ agent: "cursor", username: "" }),
    });
    assert.equal(empty.status, 400);

    const pi = await fetch(`${base}/api/admin/agent-defaults`, {
      method: "POST",
      headers,
      body: JSON.stringify({ agent: "pi" }),
    });
    assert.equal(pi.status, 200);
    const piBody = (await pi.json()) as {
      applied: { username: string }[];
      skipped: { username: string; reason: string }[];
    };
    assert.deepEqual(piBody.applied.map((item) => item.username), ["alice"]);
    assert.equal(piBody.skipped[0]?.username, "bob");
    assert.match(piBody.skipped[0]?.reason ?? "", /Pi is off/);
    const piSettings = JSON.parse(await readFile(path.join(aliceHome, ".pi", "agent", "settings.json"), "utf8")) as {
      lastChangelogVersion: string;
      defaultProvider: string;
      defaultModel: string;
    };
    assert.equal(piSettings.lastChangelogVersion, "1.4.0");
    assert.equal(piSettings.defaultProvider, "openrouter");
    assert.equal(piSettings.defaultModel, "recursive/flint-v1.0:free");

    const cleared = await fetch(`${base}/api/admin/agents`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ cursor: true, claude: false, pi: true, piProvider: "", piModel: "" }),
    });
    assert.equal(cleared.status, 200);
    const missing = await fetch(`${base}/api/admin/agent-defaults`, {
      method: "POST",
      headers,
      body: JSON.stringify({ agent: "pi" }),
    });
    assert.equal(missing.status, 400);
  } finally {
    hub.close();
    await aliceRunner.close();
    await bobRunner.close();
    await rm(root, { recursive: true, force: true });
  }
});

