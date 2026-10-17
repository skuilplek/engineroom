import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { LinuxUser } from "../apps/hub/src/auth.ts";
import { createHub } from "../apps/hub/src/server.ts";
import type { AgentDriver } from "../apps/runner/src/drivers.ts";
import { startRunner } from "../apps/runner/src/server.ts";
import { socketPathForUser } from "@engineroom/protocol";

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
    assert.match(await sent.text(), /from-alice/);
    const detail = await fetch(`${base}/api/chats/${chat.id}`, { headers });
    const body = (await detail.json()) as { chat: { agentSessionId: string }; transcript: Array<{ kind: string }> };
    assert.equal(body.chat.agentSessionId, "sess");
    assert.equal(body.transcript.some((entry) => entry.kind === "user"), true);
    assert.equal(bobHits, 0);

    const saved = await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ defaultAgent: "pi", defaultModel: "small" }),
    });
    assert.equal(saved.status, 200);
    const settings = (await (await fetch(`${base}/api/settings`, { headers })).json()) as { defaultAgent: string };
    assert.equal(settings.defaultAgent, "pi");
  } finally {
    hub.close();
    bob.close();
    await runner.close();
    await rm(root, { recursive: true, force: true });
  }
});
