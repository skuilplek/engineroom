import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { defaultPolicy } from "@engineroom/protocol";
import { BrowserHost, browserGloballyOffered, obscuraInstalled, type CdpClient, type CdpEvent } from "../apps/runner/src/browser.ts";
import { savePolicy } from "../apps/runner/src/policy.ts";
import { startRunner } from "../apps/runner/src/server.ts";

const CHAT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHAT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

class FakeCdp implements CdpClient {
  closed = false;
  url = "about:blank";
  readonly calls: { method: string; params?: Record<string, unknown>; sessionId?: string }[] = [];

  async call(method: string, params: Record<string, unknown> | undefined, sessionId?: string): Promise<unknown> {
    this.calls.push({ method, params, sessionId });
    if (method === "Target.createTarget") {
      const count = this.calls.filter((call) => call.method === "Target.createTarget").length;
      return { targetId: `target-${count}` };
    }
    if (method === "Target.attachToTarget") return { sessionId: `session-${String(params?.targetId)}` };
    if (method === "Page.navigate") {
      this.url = String(params?.url ?? this.url);
      return {};
    }
    if (method === "Runtime.evaluate") {
      const expression = String(params?.expression ?? "");
      if (expression === "location.href") return { result: { value: this.url } };
      if (expression === "document.title") return { result: { value: "Example" } };
      if (expression.includes("querySelector")) return { result: { value: { x: 12, y: 34 } } };
      if (expression.includes("innerText")) {
        return { result: { value: { url: this.url, title: "Example", text: "Hello" } } };
      }
      return { result: { value: null } };
    }
    if (method === "Page.captureScreenshot") return { data: "aGVsbG8=" };
    return {};
  }

  listen(_handler: (event: CdpEvent) => void) { /* frames are not required here */ }

  close() {
    this.closed = true;
  }
}

function hostWith(fake: FakeCdp, home: string, idleMs = 60_000) {
  const activity: string[] = [];
  const frames: string[] = [];
  const host = new BrowserHost({
    home,
    idleMs,
    launch: async () => fake,
    onFrame: (_chatId, data) => frames.push(data),
    onStatus: () => undefined,
    onActivity: (chatId) => activity.push(chatId),
  });
  return { host, activity, frames };
}

test("one browser keeps a history and a page for each chat", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "er-browser-host-"));
  const fake = new FakeCdp();
  const { host, activity, frames } = hostWith(fake, home);
  try {
    const first = await host.navigate(CHAT_A, "https://example.com/a");
    const second = await host.navigate(CHAT_A, "https://example.com/b");
    assert.equal(second.canBack, true);
    assert.equal(second.url, "https://example.com/b");
    const back = await host.back(CHAT_A);
    assert.equal(back.url, "https://example.com/a");
    assert.equal(back.canForward, true);
    assert.equal(first.url, "https://example.com/a");
    await host.navigate(CHAT_B, "https://example.com/other");
    assert.equal(fake.calls.filter((call) => call.method === "Target.createTarget").length, 2);
    const clicked = await host.tool(CHAT_A, "browser_click", { selector: "#go" });
    assert.match(clicked, /12, 34/);
    const pressed = fake.calls.filter((call) => call.method === "Input.dispatchMouseEvent" && call.params?.type === "mousePressed");
    assert.equal(pressed.at(-1)?.params?.x, 12);
    const snap = await host.tool(CHAT_A, "browser_snapshot", {});
    assert.match(snap, /Hello/);
    assert.deepEqual(activity, [CHAT_A, CHAT_A, CHAT_B, CHAT_A, CHAT_A]);
    await host.watch(CHAT_A, 800, 600);
    assert.deepEqual(frames, ["aGVsbG8="]);
  } finally {
    host.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("a quiet browser shuts down, and an open pane keeps it alive", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "er-browser-idle-"));
  const idle = new FakeCdp();
  const quiet = hostWith(idle, home, 40);
  try {
    await quiet.host.navigate(CHAT_A, "https://example.com/");
    await delay(200);
    assert.equal(idle.closed, true);
  } finally {
    quiet.host.close();
  }
  const watched = new FakeCdp();
  const live = hostWith(watched, home, 40);
  try {
    await live.host.watch(CHAT_A, 640, 480);
    await delay(200);
    assert.equal(watched.closed, false);
    await live.host.unwatch(CHAT_A);
    await delay(200);
    assert.equal(watched.closed, true);
  } finally {
    live.host.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("the global browser offer can turn navigation off", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "er-browser-offer-"));
  const agents = path.join(home, "agents.json");
  await writeFile(agents, JSON.stringify({ browser: false }));
  const previous = process.env.ENGINEROOM_AGENTS_FILE;
  process.env.ENGINEROOM_AGENTS_FILE = agents;
  const sock = path.join(home, "runner.sock");
  const runner = await startRunner({ home, socketPath: sock, drivers: {}, peerCheck: () => undefined });
  try {
    assert.equal(await browserGloballyOffered(), false);
    const created = await once(sock, { id: "c", type: "create_chat", agent: "cursor", workspace: home });
    const chatId = (created.result as { id: string }).id;
    await assert.rejects(
      once(sock, { id: "n", type: "browser_navigate", chatId, url: "https://example.com/" }),
      /browser is not enabled/,
    );
  } finally {
    if (previous === undefined) delete process.env.ENGINEROOM_AGENTS_FILE;
    else process.env.ENGINEROOM_AGENTS_FILE = previous;
    await runner.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("a person's browser policy rejects navigation before Obscura starts", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "er-browser-policy-"));
  const sock = path.join(home, "runner.sock");
  await savePolicy(home, { ...defaultPolicy(), browser: false });
  const runner = await startRunner({ home, socketPath: sock, drivers: {}, peerCheck: () => undefined });
  try {
    const created = await once(sock, { id: "c", type: "create_chat", agent: "cursor", workspace: home });
    const chatId = (created.result as { id: string }).id;
    await assert.rejects(
      once(sock, { id: "n", type: "browser_navigate", chatId, url: "https://example.com/" }),
      /browser is not enabled/,
    );
    const available = await once(sock, { id: "a", type: "browser_available" });
    assert.equal(typeof (available.result as { available: boolean }).available, "boolean");
  } finally {
    await runner.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("obscura loads a local page into the shared browser", { timeout: 30_000 }, async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "er-browser-obscura-"));
  if (!(await obscuraInstalled(home, process.env))) {
    await rm(home, { recursive: true, force: true });
    t.skip("obscura is not installed");
    return;
  }
  const site = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<title>Hi</title><p>Hello from obscura</p>");
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", () => resolve()));
  const port = (site.address() as AddressInfo).port;
  const frames: string[] = [];
  const host = new BrowserHost({
    home,
    onFrame: (_chatId, data) => frames.push(data),
    onStatus: () => undefined,
    onActivity: () => undefined,
  });
  try {
    const opened = await host.tool(CHAT_A, "browser_navigate", { url: `http://127.0.0.1:${port}/` });
    assert.match(opened, /Opened http:\/\/127\.0\.0\.1:/);
    const snap = await host.tool(CHAT_A, "browser_snapshot", {});
    assert.match(snap, /Hello from obscura/);
    await host.watch(CHAT_A, 800, 600);
    assert.ok(frames.length > 0);
    assert.ok(frames[0] && frames[0].length > 100);
  } finally {
    host.close();
    await new Promise<void>((resolve) => site.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Line {
  id?: string;
  type?: string;
  result?: unknown;
  error?: string;
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
