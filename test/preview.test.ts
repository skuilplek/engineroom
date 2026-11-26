import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { LinuxUser } from "../apps/hub/src/auth.ts";
import { loadSitePreviews } from "../apps/hub/src/agents.ts";
import { createPreviewServer } from "../apps/hub/src/preview.ts";
import { createHub } from "../apps/hub/src/server.ts";
import type { AgentDriver } from "../apps/runner/src/drivers.ts";
import { startRunner } from "../apps/runner/src/server.ts";
import { socketPathForUser } from "@engineroom/protocol";
import "./peercred-helper.ts";

const drivers: Record<AgentDriver["id"], AgentDriver> = {
  cursor: { id: "cursor", async run() { throw new Error("not used"); } },
  pi: { id: "pi", async run() { throw new Error("not used"); } },
};

async function fixture(options: { enabled?: () => boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "er-preview-"));
  const home = path.join(root, "home");
  const socketDir = path.join(root, "socks");
  const project = path.join(home, "Sites", "demo");
  await mkdir(project, { recursive: true });
  await mkdir(socketDir);
  await mkdir(path.join(home, "Sites", ".secret"));
  await writeFile(path.join(home, "Sites", ".secret", "token.txt"), "do-not-publish");
  await writeFile(path.join(home, "Sites", ".env"), "PASSWORD=hunter2");
  await writeFile(path.join(project, "index.html"), "<!doctype html><title>demo</title><h1>hello</h1>");
  await writeFile(path.join(project, "style.css"), "body{color:red}");
  await writeFile(path.join(project, ".env"), "SECRET=1");
  await writeFile(path.join(project, "run.php"), "<?php echo 1;");
  await symlink("/etc/passwd", path.join(project, "escape.txt"));

  const uid = process.getuid?.() ?? 1000;
  const user: LinuxUser = {
    username: "alice",
    uid,
    gid: process.getgid?.() ?? 1000,
    home,
    shell: "/bin/bash",
    groups: ["engineroom-users"],
  };
  const runner = await startRunner({ home, socketPath: socketPathForUser(socketDir, "alice"), drivers });
  const preview = createPreviewServer({
    link: { socketDir },
    mayPreview: (name) => name === "alice",
    lookup: (name) => (name === "alice" ? user : null),
    // Port 9 is the discard port: nothing answers there, so a request that is
    // meant to be sent back to the app cannot accidentally reach a real hub.
    appPort: 9,
    ...(options.enabled ? { enabled: options.enabled } : {}),
  });
  await new Promise<void>((resolve) => preview.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(preview.address() as AddressInfo).port}`;
  return {
    base,
    project,
    async close() {
      preview.close();
      await runner.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("a file in an account's sites folder is served as a page", async () => {
  const f = await fixture();
  try {
    const page = await fetch(`${f.base}/alice/demo/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") || "", /text\/html/);
    assert.match(await page.text(), /hello/);

    const css = await fetch(`${f.base}/alice/demo/style.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") || "", /text\/css/);
    assert.equal(await css.text(), "body{color:red}");

    // A page must not be able to read the app session or make the answer
    // cacheable across users.
    assert.equal(page.headers.get("set-cookie"), null);
    assert.match(page.headers.get("cache-control") || "", /no-cache/);
  } finally {
    await f.close();
  }
});

test("a HEAD request reports the size without sending the body", async () => {
  const f = await fixture();
  try {
    const head = await fetch(`${f.base}/alice/demo/style.css`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "15");
    assert.equal(await head.text(), "");
  } finally {
    await f.close();
  }
});

test("dot files and their folders are not published", async () => {
  const f = await fixture();
  try {
    for (const url of [
      "/alice/demo/.env",
      "/alice/Sites/.env",
      "/alice/.secret/token.txt",
      "/alice/demo/.git/config",
      "/alice/Sites/.secret/token.txt",
    ]) {
      const response = await fetch(`${f.base}${url}`);
      assert.equal(response.status, 404, url);
      assert.doesNotMatch(await response.text(), /hunter2|do-not-publish/);
    }
  } finally {
    await f.close();
  }
});

test("a path that climbs out of the folder is refused", async () => {
  const f = await fixture();
  try {
    for (const url of [
      "/alice/..%2f..%2fetc/passwd",
      "/alice/demo/%2e%2e/%2e%2e/etc/passwd",
      "/alice/demo/..%2f..%2f..%2fetc%2fpasswd",
      "/alice/demo/../../../etc/passwd",
    ]) {
      // The URL parser collapses some of these before the request is sent. What
      // matters is that none of them ends in a file read: the answer is either a
      // refusal or a redirect somewhere that is not this preview.
      const response = await fetch(`${f.base}${url}`, { redirect: "manual" });
      const body = await response.text();
      assert.doesNotMatch(body, /root:x:/, url);
      assert.ok(
        [400, 404, 301, 302].includes(response.status),
        `${url} -> ${response.status}`,
      );
    }
  } finally {
    await f.close();
  }
});

test("a symlink pointing outside the folder is refused", async () => {
  const f = await fixture();
  try {
    const response = await fetch(`${f.base}/alice/demo/escape.txt`);
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /root:x:/);
  } finally {
    await f.close();
  }
});

test("a server-side script is not handed out as if it would run", async () => {
  const f = await fixture();
  try {
    const response = await fetch(`${f.base}/alice/demo/run.php`);
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /<\?php/);
  } finally {
    await f.close();
  }
});

test("the account index lists projects and links into them", async () => {
  const f = await fixture();
  try {
    const index = await fetch(`${f.base}/alice/`, { redirect: "manual" });
    assert.equal(index.status, 200);
    const body = await index.text();
    assert.match(body, /href="\/alice\/demo\/"/);
    assert.doesNotMatch(body, /\.secret/);
    // The folder link needs its trailing slash so relative URLs keep working.
    const bare = await fetch(`${f.base}/alice`, { redirect: "manual" });
    assert.equal(bare.status, 301);
    assert.equal(bare.headers.get("location"), "/alice/");
    const folder = await fetch(`${f.base}/alice/demo`, { redirect: "manual" });
    assert.equal(folder.status, 301);
    assert.equal(folder.headers.get("location"), "/alice/demo/");
  } finally {
    await f.close();
  }
});

test("anything that is not a preview is sent back to the app", async () => {
  const f = await fixture();
  try {
    for (const url of ["/", "/settings", "/nobody/demo/", "/api/me"]) {
      const response = await fetch(`${f.base}${url}`, { redirect: "manual" });
      assert.equal(response.status, 302, url);
      assert.match(response.headers.get("location") || "", /^http:\/\/127\.0\.0\.1:9\//);
    }
  } finally {
    await f.close();
  }
});

test("previews only answer reads", async () => {
  const f = await fixture();
  try {
    const response = await fetch(`${f.base}/alice/demo/`, { method: "POST" });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, HEAD");
  } finally {
    await f.close();
  }
});

test("a raw request with a dot segment never reads a file outside the folder", async () => {
  const f = await fixture();
  try {
    // fetch and the URL parser collapse "..", so this goes out on a socket to
    // make sure the server itself rejects the literal path.
    const raw = await rawGet(f.base, "/alice/demo/../../../../etc/passwd");
    assert.equal(raw.status, 404);
    assert.doesNotMatch(raw.body, /root:x:/);
  } finally {
    await f.close();
  }
});

function rawGet(base: string, target: string): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname, () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n\r\n`);
    });
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      data += chunk;
    });
    socket.on("error", reject);
    socket.on("end", () => {
      const status = Number(data.split(" ")[1] || 0);
      resolve({ status, body: data });
    });
  });
}

test("a preview URL on the app port is redirected to the preview port", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "er-redirect-"));
  const web = path.join(root, "web");
  await mkdir(web);
  await writeFile(path.join(web, "index.html"), "<!doctype html><title>app</title>");
  const hub = createHub({
    link: { socketDir: path.join(root, "socks") },
    sessionSecret: Buffer.from("redir-test-secret-value"),
    pamHelper: "/bin/false",
    webDist: web,
    cookieSecure: false,
    listAccounts: () => [{ username: "alice", home: "/home/alice", uid: 1000, shell: "/bin/bash" }],
    previewPort: 8081,
    sitePreviews: () => true,
  });
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
  try {
    const preview = await fetch(`${base}/alice/demo/index.html`, { redirect: "manual" });
    assert.equal(preview.status, 302);
    assert.equal(preview.headers.get("location"), "http://127.0.0.1:8081/alice/demo/index.html");

    const withQuery = await fetch(`${base}/alice/demo/?page=2`, { redirect: "manual" });
    assert.equal(withQuery.headers.get("location"), "http://127.0.0.1:8081/alice/demo/?page=2");

    // Everything else still reaches the app.
    const app = await fetch(`${base}/`, { redirect: "manual" });
    assert.equal(app.status, 200);
    assert.match(await app.text(), new RegExp("<title>app</title>"));
    const unknown = await fetch(`${base}/nobody/x.html`, { redirect: "manual" });
    assert.equal(unknown.status, 200);
  } finally {
    hub.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a page the browser already has is answered with 304", async () => {
  const f = await fixture();
  try {
    const first = await fetch(`${f.base}/alice/demo/style.css`);
    const etag = first.headers.get("etag");
    assert.ok(etag);
    await first.text();

    const again = await fetch(`${f.base}/alice/demo/style.css`, { headers: { "If-None-Match": etag! } });
    assert.equal(again.status, 304);

    const since = await fetch(`${f.base}/alice/demo/style.css`, {
      headers: { "If-Modified-Since": first.headers.get("last-modified") || "" },
    });
    assert.equal(since.status, 304);

    const stale = await fetch(`${f.base}/alice/demo/style.css`, { headers: { "If-None-Match": '"nope"' } });
    assert.equal(stale.status, 200);
    assert.equal(await stale.text(), "body{color:red}");
  } finally {
    await f.close();
  }
});

test("the app refuses a change that a preview page tries to make", async () => {
  // Cookies are not scoped to a port, so a page on the preview port is
  // same-site with the app and its requests do carry the session cookie.
  // What stops it is the origin check: the Origin names the preview port, the
  // Host names the app port, and the two do not match.
  const root = await mkdtemp(path.join(tmpdir(), "er-origin-"));
  const web = path.join(root, "web");
  await mkdir(web);
  await writeFile(path.join(web, "index.html"), "<!doctype html><title>app</title>");
  const hub = createHub({
    link: { socketDir: path.join(root, "socks") },
    sessionSecret: Buffer.from("origin-test-secret-value"),
    pamHelper: "/bin/false",
    webDist: web,
    cookieSecure: false,
    listAccounts: () => [{ username: "alice", home: "/home/alice", uid: 1000, shell: "/bin/bash" }],
  });
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", () => resolve()));
  const address = hub.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const fromPreviewPort = await fetch(`${base}/api/customize`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:8081` },
      body: JSON.stringify({ theme: "dark" }),
    });
    assert.equal(fromPreviewPort.status, 403);

    // The same request from the app's own origin is not refused for this
    // reason; it fails only because there is no session.
    const fromApp = await fetch(`${base}/api/customize`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ theme: "dark" }),
    });
    assert.notEqual(fromApp.status, 403);
  } finally {
    hub.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a file name with spaces, unicode, or a percent sign is served", async () => {
  const f = await fixture();
  try {
    // These come from the project folder of a real user, not from anything
    // this server chose. Each one has to survive the trip through the URL.
    const cases = [
      ["a b.html", "spaced"],
      ["ünïcode.html", "unicode"],
      ["100%.html", "percent"],
      ["say\"hi'.html", "quoted"],
    ] as const;
    for (const [name, body] of cases) await writeFile(path.join(f.project, name), body);

    for (const [name, body] of cases) {
      const response = await fetch(`${f.base}/alice/demo/${encodeURIComponent(name)}`);
      assert.equal(response.status, 200, name);
      assert.equal(await response.text(), body, name);
    }

    // An unencoded space is what a browser sends when someone types the name.
    const typed = await fetch(`${f.base}/alice/demo/a b.html`);
    assert.equal(typed.status, 200);
  } finally {
    await f.close();
  }
});

test("an account named like a folder of the built UI does not take it over", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "er-shadow-"));
  const web = path.join(root, "web");
  await mkdir(path.join(web, "assets"), { recursive: true });
  await writeFile(path.join(web, "index.html"), "<!doctype html><title>app</title>");
  await writeFile(path.join(web, "assets", "app.css"), "body{margin:0}");
  const hub = createHub({
    link: { socketDir: path.join(root, "socks") },
    sessionSecret: Buffer.from("shadow-test-secret-value"),
    pamHelper: "/bin/false",
    webDist: web,
    cookieSecure: false,
    listAccounts: () => [{ username: "assets", home: "/home/assets", uid: 1000, shell: "/bin/bash" }],
    previewPort: 8081,
  });
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
  try {
    const css = await fetch(`${base}/assets/app.css`, { redirect: "manual" });
    assert.equal(css.status, 200);
    assert.equal(await css.text(), "body{margin:0}");
  } finally {
    hub.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("previews are off until an administrator turns them on", async () => {
  // The switch is read per request, so a server that started while previews
  // were off starts serving as soon as the setting changes.
  let on = false;
  const f = await fixture({ enabled: () => on });
  try {
    for (const url of ["/alice/demo/index.html", "/alice/demo/style.css", "/alice/"]) {
      const off = await fetch(`${f.base}${url}`);
      assert.equal(off.status, 404, url);
      const body = await off.text();
      assert.match(body, /previews are turned off/i);
      // Nothing about an account or a project leaks while the switch is off:
      // the answer is the same shape for every path.
      assert.doesNotMatch(body, /alice|demo|hello/);
    }

    on = true;
    const served = await fetch(`${f.base}/alice/demo/style.css`);
    assert.equal(served.status, 200);
    assert.equal(await served.text(), "body{color:red}");

    on = false;
    const closed = await fetch(`${f.base}/alice/demo/style.css`);
    assert.equal(closed.status, 404);
  } finally {
    await f.close();
  }
});

test("the app does not redirect to previews while they are off", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "er-gate-"));
  const web = path.join(root, "web");
  await mkdir(web);
  await writeFile(path.join(web, "index.html"), "<!doctype html><title>app</title>");
  let on = false;
  const hub = createHub({
    link: { socketDir: path.join(root, "socks") },
    sessionSecret: Buffer.from("gate-test-secret-value"),
    pamHelper: "/bin/false",
    webDist: web,
    cookieSecure: false,
    listAccounts: () => [{ username: "alice", home: "/home/alice", uid: 1000, shell: "/bin/bash" }],
    previewPort: 8081,
    sitePreviews: () => on,
  });
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
  try {
    // Off: the short form is not a preview URL at all, so it falls through to
    // the app rather than sending anyone to a port that answers 404.
    const off = await fetch(`${base}/alice/demo/index.html`, { redirect: "manual" });
    assert.equal(off.status, 200);

    on = true;
    const redirected = await fetch(`${base}/alice/demo/index.html`, { redirect: "manual" });
    assert.equal(redirected.status, 302);
    assert.equal(redirected.headers.get("location"), "http://127.0.0.1:8081/alice/demo/index.html");
  } finally {
    hub.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the site previews setting is off by default and round-trips through the admin API", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "er-toggle-"));
  const home = path.join(root, "home");
  const socketDir = path.join(root, "socks");
  const agentsFile = path.join(root, "agents.json");
  await mkdir(home);
  await mkdir(socketDir);
  // Only the key the route needs. Everything else it writes stays absent, which
  // is what proves the default really is off rather than merely unset in memory.
  await writeFile(agentsFile, JSON.stringify({ pi: true }));
  assert.equal(loadSitePreviews(agentsFile), false);

  const uid = process.getuid?.() ?? 1000;
  const user: LinuxUser = {
    username: "alice",
    uid,
    gid: process.getgid?.() ?? 1000,
    home,
    shell: "/bin/bash",
    groups: ["engineroom-users"],
  };
  // A sign-in reaches for the user's runner, so the admin routes need a real
  // one behind the hub.
  const runner = await startRunner({ home, socketPath: socketPathForUser(socketDir, "alice"), drivers });
  const hub = createHub({
    link: { socketDir },
    sessionSecret: Buffer.from("toggle-test-secret-value"),
    pamHelper: "/bin/false",
    cookieSecure: false,
    agentsFile,
    adminUser: "alice",
    lookup: (name) => (name === "alice" ? user : null),
    authenticate: async () => true,
    listAccounts: () => [{ username: "alice", home, uid, shell: "/bin/bash" }],
  });
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
  try {
    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ username: "alice", password: "secret" }),
    });
    assert.equal(login.status, 200);
    const cookie = (login.headers.getSetCookie?.() ?? [])[0]?.split(";")[0];
    assert.ok(cookie);

    const read = async () => {
      const response = await fetch(`${base}/api/admin/agents`, { headers: { Cookie: cookie! } });
      assert.equal(response.status, 200);
      return (await response.json()) as { sitePreviews?: boolean };
    };
    assert.equal((await read()).sitePreviews, false);

    const save = async (sitePreviews: boolean) => {
      const response = await fetch(`${base}/api/admin/agents`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: cookie!, Origin: base },
        // Every agent is named because the route refuses a body that does not
        // say what to do with each one.
        body: JSON.stringify({ cursor: true, pi: true, sitePreviews }),
      });
      assert.equal(response.status, 200);
      return (await response.json()) as { sitePreviews?: boolean };
    };

    assert.equal((await save(true)).sitePreviews, true);
    assert.equal(loadSitePreviews(agentsFile), true);
    assert.equal((await read()).sitePreviews, true);

    // Off again, and the key has to be written rather than dropped, or the
    // setting would quietly come back on at the next start.
    assert.equal((await save(false)).sitePreviews, false);
    assert.equal(loadSitePreviews(agentsFile), false);
    const stored = JSON.parse(await readFile(agentsFile, "utf8")) as { sitePreviews?: boolean };
    assert.equal(stored.sitePreviews, false);
  } finally {
    hub.close();
    await runner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a folder whose entry point is a server-side script says so instead of not found", async () => {
  const f = await fixture();
  try {
    // The shape of a real project on this machine: a PHP app with no index.html.
    await mkdir(path.join(f.project, "..", "phpsite"));
    const phpSite = path.join(f.project, "..", "phpsite");
    await writeFile(path.join(phpSite, "index.php"), "<?php echo 'hi';");
    await writeFile(path.join(phpSite, "style.css"), "body{color:blue}");

    const folder = await fetch(`${f.base}/alice/phpsite/`);
    assert.equal(folder.status, 404);
    const body = await folder.text();
    // It has to name what is there, so the reader knows the folder is fine and
    // the preview is what cannot handle it.
    assert.match(body, /needs a server/i);
    assert.match(body, /index\.php/);
    assert.doesNotMatch(body, /echo 'hi'/);

    // Pointing straight at the script is still a plain refusal.
    const script = await fetch(`${f.base}/alice/phpsite/index.php`);
    assert.equal(script.status, 404);
    assert.match(await script.text(), /server-side scripts are not run/i);

    // A static file beside it still works, so only the entry point is refused.
    const css = await fetch(`${f.base}/alice/phpsite/style.css`);
    assert.equal(css.status, 200);
  } finally {
    await f.close();
  }
});

test("a folder with index.htm is served, not reported as needing a server", async () => {
  const f = await fixture();
  try {
    const htm = path.join(f.project, "..", "htm-only");
    await mkdir(htm);
    await writeFile(path.join(htm, "index.htm"), "<!doctype html><title>htm</title>");
    await writeFile(path.join(htm, "index.php"), "<?php echo 'hi';");

    const response = await fetch(`${f.base}/alice/htm-only/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), new RegExp("<title>htm</title>"));
  } finally {
    await f.close();
  }
});
