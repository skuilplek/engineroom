import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { socketPathForUser, MAX_EXTENSION_DOC_BYTES } from "@engineroom/protocol";
import type { LinuxUser } from "../apps/hub/src/auth.ts";
import { createHub } from "../apps/hub/src/server.ts";
import type { AgentDriver } from "../apps/runner/src/drivers.ts";
import { startRunner } from "../apps/runner/src/server.ts";
import { addSiteDoc, listSiteDocs, readSiteDoc, removeSiteDoc, updateSiteDoc } from "../apps/hub/src/site-docs.ts";
import "./peercred-helper.ts";

test("site documents are stored beside the agents file and can be replaced", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "er-site-docs-"));
  try {
    const added = addSiteDoc(root, "On call", Buffer.from("# On call\n\nPage the harbor.\n"));
    assert.deepEqual(added, { id: "on-call", title: "On call" });
    assert.equal(await readFile(path.join(root, "site-docs", "on-call.md"), "utf8"), "# On call\n\nPage the harbor.\n");
    assert.deepEqual(listSiteDocs(root), [{ id: "on-call", title: "On call" }]);

    const renamed = updateSiteDoc(root, "on-call", "Night watch", "Still the same document.\n");
    assert.deepEqual(renamed, { id: "on-call", title: "Night watch" });
    assert.equal((await readSiteDoc(root, "on-call")).markdown, "Still the same document.\n");
    assert.equal(await readFile(path.join(root, "site-docs", "on-call.md"), "utf8"), "Still the same document.\n");

    assert.throws(() => addSiteDoc(root, "On call", Buffer.from("again\n")), /document id is taken/);
    assert.throws(() => addSiteDoc(root, "123", Buffer.from("nope\n")), /invalid document title/);
    assert.throws(() => addSiteDoc(root, "Notes", Buffer.from("ok\0no")), /invalid document/);
    assert.throws(() => addSiteDoc(root, "Notes", Buffer.from([0xff])), /invalid document/);
    assert.throws(() => addSiteDoc(root, "Notes", Buffer.alloc(MAX_EXTENSION_DOC_BYTES + 1, 0x61)), /document is too large/);
    assert.throws(() => listSiteDocs(""), /not configured/);

    removeSiteDoc(root, "on-call");
    assert.deepEqual(listSiteDocs(root), []);
    assert.throws(() => readSiteDoc(root, "on-call"), /document not found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an administrator uploads site documents and other accounts can read them", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "er-site-docs-http-"));
  const agentsFile = path.join(root, "agents.json");
  const socketDir = path.join(root, "socks");
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const alice: LinuxUser = {
    username: "alice",
    uid,
    gid,
    home: path.join(root, "alice"),
    shell: "/bin/bash",
    groups: ["engineroom-users"],
  };
  const carol: LinuxUser = { ...alice, username: "carol", home: path.join(root, "carol") };
  await mkdir(alice.home, { recursive: true });
  await mkdir(carol.home, { recursive: true });
  await mkdir(socketDir);
  const drivers: Record<AgentDriver["id"], AgentDriver> = {
    cursor: { id: "cursor", async run() { throw new Error("not used"); } },
    pi: { id: "pi", async run() { throw new Error("not used"); } },
  };
  const aliceRunner = await startRunner({
    home: alice.home,
    socketPath: socketPathForUser(socketDir, "alice"),
    drivers,
  });
  const carolRunner = await startRunner({
    home: carol.home,
    socketPath: socketPathForUser(socketDir, "carol"),
    drivers,
  });
  const hub = createHub({
    link: { socketDir },
    sessionSecret: Buffer.from("site-docs-secret-value"),
    pamHelper: "/bin/false",
    cookieSecure: false,
    adminUser: "alice",
    agentsFile,
    lookup: (username) => (username === "alice" ? alice : username === "carol" ? carol : null),
    authenticate: async () => true,
  });
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
  try {
    const aliceCookie = await login(base, "alice");
    const carolCookie = await login(base, "carol");
    const anon = await fetch(`${base}/api/site-docs`);
    assert.equal(anon.status, 401);

    const denied = await fetch(`${base}/api/admin/site-docs`, {
      method: "POST",
      headers: { Cookie: carolCookie },
      body: markdownForm("On call", "Page the harbor.\n", "notes.md"),
    });
    assert.equal(denied.status, 403);

    const added = await fetch(`${base}/api/admin/site-docs`, {
      method: "POST",
      headers: { Cookie: aliceCookie },
      body: markdownForm("On call", "# On call\n\nPage the harbor.\n", "notes.md"),
    });
    assert.equal(added.status, 201);
    assert.deepEqual(await added.json(), { id: "on-call", title: "On call" });

    const badName = await fetch(`${base}/api/admin/site-docs`, {
      method: "POST",
      headers: { Cookie: aliceCookie },
      body: markdownForm("Notes", "nope\n", "notes.txt"),
    });
    assert.equal(badName.status, 400);

    const badTitle = await fetch(`${base}/api/admin/site-docs`, {
      method: "POST",
      headers: { Cookie: aliceCookie },
      body: markdownForm("123", "nope\n", "notes.md"),
    });
    assert.equal(badTitle.status, 400);

    const duplicate = await fetch(`${base}/api/admin/site-docs`, {
      method: "POST",
      headers: { Cookie: aliceCookie },
      body: markdownForm("On-call", "again\n", "again.md"),
    });
    assert.equal(duplicate.status, 400);

    const listed = await fetch(`${base}/api/site-docs`, { headers: { Cookie: carolCookie } });
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), { docs: [{ id: "on-call", title: "On call" }] });

    const page = await fetch(`${base}/api/site-docs/on-call`, { headers: { Cookie: carolCookie } });
    assert.equal(page.status, 200);
    assert.deepEqual(await page.json(), { title: "On call", markdown: "# On call\n\nPage the harbor.\n" });

    const edited = await fetch(`${base}/api/admin/site-docs/on-call`, {
      method: "POST",
      headers: { Cookie: aliceCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Night watch", markdown: "Updated from the box.\n" }),
    });
    assert.equal(edited.status, 200);
    assert.deepEqual(await edited.json(), { id: "on-call", title: "Night watch" });

    const replaced = await fetch(`${base}/api/admin/site-docs/on-call`, {
      method: "POST",
      headers: { Cookie: aliceCookie },
      body: markdownForm("Night watch", "Replaced from a file.\n", "fresh.md"),
    });
    assert.equal(replaced.status, 200);
    const after = await fetch(`${base}/api/site-docs/on-call`, { headers: { Cookie: aliceCookie } });
    assert.deepEqual(await after.json(), { title: "Night watch", markdown: "Replaced from a file.\n" });

    const huge = await fetch(`${base}/api/admin/site-docs/on-call`, {
      method: "POST",
      headers: { Cookie: aliceCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Night watch", markdown: "a".repeat(MAX_EXTENSION_DOC_BYTES + 1) }),
    });
    assert.equal(huge.status, 400);

    const removed = await fetch(`${base}/api/admin/site-docs/on-call`, {
      method: "DELETE",
      headers: { Cookie: aliceCookie },
    });
    assert.equal(removed.status, 200);
    const gone = await fetch(`${base}/api/site-docs/on-call`, { headers: { Cookie: carolCookie } });
    assert.equal(gone.status, 404);
  } finally {
    hub.close();
    await aliceRunner.close();
    await carolRunner.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function login(base: string, username: string): Promise<string> {
  const response = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "secret" }),
  });
  assert.equal(response.status, 200);
  const cookie = (response.headers.getSetCookie?.() ?? [])[0]?.split(";")[0];
  assert.ok(cookie);
  return cookie;
}

function markdownForm(title: string, markdown: string, filename: string): FormData {
  const body = new FormData();
  body.set("title", title);
  body.set("file", new Blob([markdown], { type: "text/markdown" }), filename);
  return body;
}
