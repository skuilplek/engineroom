import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import type { LinuxUser } from "../apps/hub/src/auth.ts";
import { createHub } from "../apps/hub/src/server.ts";
import type { AgentDriver } from "../apps/runner/src/drivers.ts";
import { startRunner } from "../apps/runner/src/server.ts";
import { socketPathForUser } from "@engineroom/protocol";

test("the administrator sets agents and accounts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "er-admin-"));
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
  const hub = createHub({
    link: { socketDir },
    sessionSecret: Buffer.from("admin-test-secret-value"),
    pamHelper: "/bin/false",
    cookieSecure: false,
    adminUser: "alice",
    agentsFile,
    lookup: (username) => {
      if (username === "alice") return user;
      if (username === "carol") return { ...user, username: "carol", home: "/home/carol", uid: uid + 1 };
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
    const me = (await (await fetch(`${base}/api/me`, { headers })).json()) as { admin: boolean; agents: string[] };
    assert.equal(me.admin, true);
    assert.deepEqual(me.agents, ["cursor"]);

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

    const revoked = await fetch(`${base}/api/admin/users/carol/revoke`, { method: "POST", headers });
    assert.equal(revoked.status, 200);
    assert.equal(calls.at(-1)?.action, "revoke");

    const revokeSelf = await fetch(`${base}/api/admin/users/alice/revoke`, { method: "POST", headers });
    assert.equal(revokeSelf.status, 400);
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
    const enabledBody = (await enabled.json()) as { agents: string[] };
    assert.deepEqual(enabledBody.agents, ["claude"]);
    const stored = JSON.parse(await readFile(agentsFile, "utf8")) as { claude: boolean };
    assert.equal(stored.claude, true);

    const carol = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "carol", password: "secret" }),
    });
    const carolCookie = (carol.headers.getSetCookie?.() ?? [])[0]?.split(";")[0];
    const denied = await fetch(`${base}/api/admin/users`, { headers: { Cookie: carolCookie! } });
    assert.equal(denied.status, 403);
    const carolMe = (await (await fetch(`${base}/api/me`, { headers: { Cookie: carolCookie! } })).json()) as {
      admin: boolean;
      agents: string[];
    };
    assert.equal(carolMe.admin, false);
    assert.deepEqual(carolMe.agents, ["claude"]);
  } finally {
    hub.close();
    await runner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the administrator enables repositories for one user", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "er-repos-admin-"));
  const aliceHome = path.join(root, "alice");
  const carolHome = path.join(root, "carol");
  const socketDir = path.join(root, "socks");
  const carolRepo = path.join(carolHome, "Sites", "widget");
  const carolOther = path.join(carolHome, "Sites", "other");
  await mkdir(path.join(carolRepo, ".git"), { recursive: true });
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
    sessionSecret: Buffer.from("repo-admin-secret-value"),
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

    const denied = await fetch(`${base}/api/admin/users/carol/repositories`, {
      method: "PUT",
      headers: carolHeaders,
      body: JSON.stringify({ enabled: [carolRepo] }),
    });
    assert.equal(denied.status, 403);

    const discovered = (await (await fetch(`${base}/api/admin/users/carol/repositories`, { headers: aliceHeaders })).json()) as Array<{
      name: string;
      path: string;
      enabled: boolean;
    }>;
    assert.deepEqual(discovered.map((entry) => entry.name).sort(), ["other", "widget"]);
    assert.equal(discovered.every((entry) => entry.enabled === false), true);

    const widget = discovered.find((entry) => entry.name === "widget");
    assert.ok(widget);
    const saved = await fetch(`${base}/api/admin/users/carol/repositories`, {
      method: "PUT",
      headers: aliceHeaders,
      body: JSON.stringify({ enabled: [widget.path] }),
    });
    assert.equal(saved.status, 200);

    const visible = (await (await fetch(`${base}/api/repositories`, { headers: carolHeaders })).json()) as Array<{ name: string }>;
    assert.deepEqual(visible.map((entry) => entry.name), ["widget"]);

    const created = await fetch(`${base}/api/chats`, {
      method: "POST",
      headers: carolHeaders,
      body: JSON.stringify({ workspace: widget.path, title: "widget chat" }),
    });
    assert.equal(created.status, 201);
    const hidden = await fetch(`${base}/api/chats`, {
      method: "POST",
      headers: carolHeaders,
      body: JSON.stringify({ workspace: carolOther }),
    });
    assert.equal(hidden.status, 403);
    const loose = await fetch(`${base}/api/chats`, {
      method: "POST",
      headers: carolHeaders,
      body: JSON.stringify({ workspace: carolHome, title: "no repo" }),
    });
    assert.equal(loose.status, 201);
  } finally {
    hub.close();
    await aliceRunner.close();
    await carolRunner.close();
    await rm(root, { recursive: true, force: true });
  }
});

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
