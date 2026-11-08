import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { parseBrowserUrl, type BrowserStatus, type BrowserToolArgs, type BrowserToolName } from "@engineroom/protocol";
import { WebSocket } from "ws";
import { childEnv, resolveBinary } from "./cli.ts";

const IDLE_MS = 10 * 60 * 1000;

export interface CdpEvent {
  method: string;
  sessionId?: string;
  params: Record<string, unknown>;
}

export interface CdpClient {
  closed: boolean;
  call(method: string, params: Record<string, unknown> | undefined, sessionId?: string): Promise<unknown>;
  listen(handler: (event: CdpEvent) => void): void;
  close(): void;
}

interface Tab {
  chatId: string;
  targetId: string;
  sessionId: string;
  history: string[];
  index: number;
  width: number;
  height: number;
  watching: boolean;
  casting: boolean;
}

export interface BrowserHostOptions {
  home: string;
  onFrame: (chatId: string, jpegBase64: string) => void;
  onStatus: (chatId: string, status: BrowserStatus) => void;
  onActivity: (chatId: string) => void;
  launch?: () => Promise<CdpClient>;
  idleMs?: number;
}

export async function browserGloballyOffered(): Promise<boolean> {
  const file = process.env.ENGINEROOM_AGENTS_FILE;
  if (!file) return true;
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { browser?: unknown };
    if (typeof parsed.browser === "boolean") return parsed.browser;
  } catch {
    /* unreadable means the offer stays on */
  }
  return true;
}

export async function obscuraInstalled(home: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await resolveBinary(undefined, ["obscura"], childEnv(env, home));
    return true;
  } catch {
    return false;
  }
}

export class BrowserHost {
  private live: CdpClient | null = null;
  private tabs = new Map<string, Tab>();
  private last = new Map<string, BrowserStatus>();
  private chain: Promise<unknown> = Promise.resolve();
  private busy = 0;
  private used = 0;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private child: ChildProcess | null = null;

  private readonly home: string;
  private readonly idleMs: number;
  private readonly hooks: BrowserHostOptions;

  constructor(options: BrowserHostOptions) {
    this.hooks = options;
    this.home = options.home;
    this.idleMs = options.idleMs ?? IDLE_MS;
  }

  watch(chatId: string, width: number, height: number): Promise<BrowserStatus> {
    return this.run(chatId, () => this.open(chatId, width, height));
  }

  resize(chatId: string, width: number, height: number): Promise<BrowserStatus> {
    return this.watch(chatId, width, height);
  }

  unwatch(chatId: string): Promise<{ ok: true }> {
    return this.run(chatId, async () => {
      const tab = this.tabs.get(chatId);
      if (tab?.casting) {
        tab.watching = false;
        tab.casting = false;
        await this.live?.call("Page.stopScreencast", {}, tab.sessionId).catch(() => undefined);
      } else if (tab) {
        tab.watching = false;
      }
      this.armIdle();
      return { ok: true as const };
    });
  }

  navigate(chatId: string, url: string): Promise<BrowserStatus> {
    return this.run(chatId, async () => {
      this.hooks.onActivity(chatId);
      const tab = await this.ensure(chatId);
      await this.visit(tab, parseBrowserUrl(url), true);
      return this.publish(tab);
    });
  }

  back(chatId: string): Promise<BrowserStatus> {
    return this.run(chatId, async () => {
      const tab = await this.ensure(chatId);
      if (tab.index > 0) {
        tab.index -= 1;
        await this.visit(tab, tab.history[tab.index] ?? "", false);
      }
      return this.publish(tab);
    });
  }

  forward(chatId: string): Promise<BrowserStatus> {
    return this.run(chatId, async () => {
      const tab = await this.ensure(chatId);
      if (tab.index >= 0 && tab.index < tab.history.length - 1) {
        tab.index += 1;
        await this.visit(tab, tab.history[tab.index] ?? "", false);
      }
      return this.publish(tab);
    });
  }

  reload(chatId: string): Promise<BrowserStatus> {
    return this.run(chatId, async () => {
      const tab = await this.ensure(chatId);
      const url = tab.history[tab.index];
      if (url) await this.visit(tab, url, false);
      return this.publish(tab);
    });
  }

  click(chatId: string, x: number, y: number): Promise<BrowserStatus> {
    return this.run(chatId, async () => {
      const tab = await this.ensure(chatId);
      await this.clickAt(tab, x, y);
      await this.refresh(tab);
      return this.publish(tab);
    });
  }

  type(chatId: string, text: string): Promise<BrowserStatus> {
    return this.run(chatId, async () => {
      const tab = await this.ensure(chatId);
      await this.cdp("Input.insertText", { text }, tab.sessionId);
      await this.refresh(tab);
      return this.publish(tab);
    });
  }

  key(chatId: string, key: string): Promise<BrowserStatus> {
    return this.run(chatId, async () => {
      const tab = await this.ensure(chatId);
      await this.press(tab, key);
      await this.refresh(tab);
      return this.publish(tab);
    });
  }

  scroll(chatId: string, x: number, y: number, deltaX: number, deltaY: number): Promise<BrowserStatus> {
    return this.run(chatId, async () => {
      const tab = await this.ensure(chatId);
      await this.cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY }, tab.sessionId);
      await this.refresh(tab);
      return this.publish(tab);
    });
  }

  tool(chatId: string, name: BrowserToolName, args: BrowserToolArgs): Promise<string> {
    return this.run(chatId, async () => {
      this.hooks.onActivity(chatId);
      const tab = await this.ensure(chatId);
      const text = await this.perform(tab, name, args);
      this.publish(tab);
      return text;
    });
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.shutdown();
  }

  private async open(chatId: string, width: number, height: number): Promise<BrowserStatus> {
    this.touch();
    const tab = await this.ensure(chatId, width, height);
    tab.watching = true;
    await this.applySize(tab, width, height);
    await this.screencast(tab);
    await this.screenshot(tab);
    return this.publish(tab);
  }

  private async perform(tab: Tab, name: BrowserToolName, args: BrowserToolArgs): Promise<string> {
    if (name === "browser_navigate") {
      const url = parseBrowserUrl(args.url);
      await this.visit(tab, url, true);
      return `Opened ${tab.history[tab.index] || url}`;
    }
    if (name === "browser_snapshot") return this.snapshot(tab);
    if (name === "browser_click") {
      const point = await this.point(tab, args);
      await this.clickAt(tab, point.x, point.y);
      await this.refresh(tab);
      return `Clicked ${Math.round(point.x)}, ${Math.round(point.y)}`;
    }
    if (name === "browser_type") {
      if (typeof args.text !== "string" || !args.text) throw new Error("invalid browser input");
      if (typeof args.selector === "string" && args.selector) {
        const point = await this.point(tab, { selector: args.selector });
        await this.clickAt(tab, point.x, point.y);
      }
      await this.cdp("Input.insertText", { text: args.text }, tab.sessionId);
      await this.refresh(tab);
      return "Typed into the page";
    }
    if (name === "browser_press") {
      if (typeof args.key !== "string" || !args.key) throw new Error("invalid browser key");
      await this.press(tab, args.key);
      await this.refresh(tab);
      return `Pressed ${args.key}`;
    }
    const deltaY = typeof args.deltaY === "number" ? args.deltaY : 400;
    const deltaX = typeof args.deltaX === "number" ? args.deltaX : 0;
    const x = typeof args.x === "number" ? args.x : tab.width / 2;
    const y = typeof args.y === "number" ? args.y : tab.height / 2;
    await this.cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY }, tab.sessionId);
    await this.refresh(tab);
    return "Scrolled the page";
  }

  private async point(tab: Tab, args: BrowserToolArgs): Promise<{ x: number; y: number }> {
    if (typeof args.selector === "string" && args.selector) {
      const rect = await this.eval(tab, `(() => {
        const el = document.querySelector(${JSON.stringify(args.selector)});
        if (!el) return null;
        el.scrollIntoView({ block: "center", inline: "center" });
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      if (!rect || typeof rect !== "object") throw new Error("element not found");
      const box = rect as { x?: unknown; y?: unknown };
      if (typeof box.x !== "number" || typeof box.y !== "number") throw new Error("element not found");
      return { x: box.x, y: box.y };
    }
    if (typeof args.x === "number" && typeof args.y === "number") return { x: args.x, y: args.y };
    throw new Error("invalid browser input");
  }

  private async ensure(chatId: string, width = 1100, height = 700): Promise<Tab> {
    if (this.closed) throw new Error("browser is closed");
    const existing = this.tabs.get(chatId);
    if (existing) return existing;
    const client = await this.ensureClient();
    const created = await client.call("Target.createTarget", { url: "about:blank" }) as { targetId?: string };
    if (!created?.targetId) throw new Error("obscura did not open a page");
    const attached = await client.call("Target.attachToTarget", { targetId: created.targetId, flatten: true }) as { sessionId?: string };
    if (!attached?.sessionId) throw new Error("obscura did not open a page");
    const tab: Tab = {
      chatId,
      targetId: created.targetId,
      sessionId: attached.sessionId,
      history: [],
      index: -1,
      width,
      height,
      watching: false,
      casting: false,
    };
    this.tabs.set(chatId, tab);
    await client.call("Page.enable", {}, tab.sessionId).catch(() => undefined);
    await client.call("Runtime.enable", {}, tab.sessionId).catch(() => undefined);
    await this.applySize(tab, width, height);
    return tab;
  }

  private async visit(tab: Tab, url: string, record: boolean) {
    if (!url) return;
    await this.cdp("Page.navigate", { url }, tab.sessionId);
    if (record) this.remember(tab, url);
    const landed = await this.eval(tab, "location.href").catch(() => undefined);
    if (typeof landed === "string" && landed && landed !== "about:blank" && tab.index >= 0) tab.history[tab.index] = landed;
    const title = await this.eval(tab, "document.title").catch(() => "");
    this.touch();
    if (typeof title === "string") {
      const status = this.statusOf(tab);
      status.title = title;
      this.last.set(tab.chatId, status);
    }
    await this.refresh(tab);
  }

  private remember(tab: Tab, url: string) {
    if (tab.history[tab.index] === url) return;
    if (tab.index < 0) {
      tab.history = [url];
      tab.index = 0;
      return;
    }
    tab.history = tab.history.slice(0, tab.index + 1);
    tab.history.push(url);
    tab.index = tab.history.length - 1;
    if (tab.history.length > 50) {
      tab.history.splice(0, tab.history.length - 50);
      tab.index = tab.history.length - 1;
    }
  }

  private async clickAt(tab: Tab, x: number, y: number) {
    await this.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, tab.sessionId);
    await this.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, tab.sessionId);
  }

  private async press(tab: Tab, key: string) {
    const named: Record<string, number> = {
      Enter: 13,
      Backspace: 8,
      Tab: 9,
      Escape: 27,
      ArrowLeft: 37,
      ArrowUp: 38,
      ArrowRight: 39,
      ArrowDown: 40,
    };
    const code = named[key];
    const down: Record<string, unknown> = { type: "keyDown", key, code: key };
    const up: Record<string, unknown> = { type: "keyUp", key, code: key };
    if (code) {
      down.windowsVirtualKeyCode = code;
      up.windowsVirtualKeyCode = code;
      if (key === "Enter") down.text = "\r";
    } else if (key.length === 1) {
      down.text = key;
    }
    await this.cdp("Input.dispatchKeyEvent", down, tab.sessionId);
    await this.cdp("Input.dispatchKeyEvent", up, tab.sessionId);
  }

  private async snapshot(tab: Tab): Promise<string> {
    const value = await this.eval(tab, `({
      url: location.href,
      title: document.title,
      text: (document.body && document.body.innerText || "").slice(0, 8000)
    })`);
    const page = value && typeof value === "object" ? value as { url?: unknown; title?: unknown; text?: unknown } : {};
    const url = typeof page.url === "string" ? page.url : this.statusOf(tab).url;
    const title = typeof page.title === "string" ? page.title : "";
    const text = typeof page.text === "string" ? page.text : "";
    if (url && url !== "about:blank" && tab.index >= 0) tab.history[tab.index] = url;
    return [url, title, "", text].join("\n").trim();
  }

  private async eval(tab: Tab, expression: string): Promise<unknown> {
    const result = await this.cdp("Runtime.evaluate", { expression, returnByValue: true }, tab.sessionId) as {
      result?: { value?: unknown };
      exceptionDetails?: unknown;
    };
    if (result?.exceptionDetails) throw new Error("page script failed");
    return result?.result?.value;
  }

  private async applySize(tab: Tab, width: number, height: number) {
    tab.width = width;
    tab.height = height;
    await this.cdp("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    }, tab.sessionId).catch(() => undefined);
    if (tab.watching) await this.screencast(tab);
  }

  private async screencast(tab: Tab) {
    await this.cdp("Page.startScreencast", {
      format: "jpeg",
      quality: 55,
      maxWidth: tab.width,
      maxHeight: tab.height,
      everyNthFrame: 1,
    }, tab.sessionId).catch(() => undefined);
    tab.casting = true;
  }

  private async screenshot(tab: Tab) {
    const shot = await this.cdp("Page.captureScreenshot", { format: "jpeg", quality: 55 }, tab.sessionId) as { data?: string };
    if (typeof shot?.data === "string" && shot.data) this.hooks.onFrame(tab.chatId, shot.data);
  }

  private async refresh(tab: Tab) {
    if (!tab.watching) return;
    await this.screenshot(tab).catch(() => undefined);
  }

  private async ensureClient(): Promise<CdpClient> {
    if (this.live && !this.live.closed) return this.live;
    this.shutdown();
    const launch = this.hooks.launch ?? (() => this.launchObscura());
    const client = await launch();
    this.live = client;
    client.listen((event) => this.onEvent(event));
    return client;
  }

  private async launchObscura(): Promise<CdpClient> {
    const env = childEnv(process.env, this.home);
    const binary = await resolveBinary(undefined, ["obscura"], env).catch(() => {
      throw new Error("obscura is not installed");
    });
    const storage = path.join(this.home, ".engineroom", "browser");
    await mkdir(storage, { recursive: true, mode: 0o700 });
    const ready = path.join(this.home, ".engineroom", "browser.ready");
    await rm(ready, { force: true });
    const port = await freePort();
    const token = randomBytes(32).toString("hex");
    const child = spawn(binary, [
      "serve",
      "--host", "127.0.0.1",
      "--port", String(port),
      "--storage-dir", storage,
      "--allow-private-network",
      "--ready-file", ready,
      "--quiet",
    ], {
      env: { ...env, OBSCURA_CDP_TOKEN: token, OBSCURA_ALLOW_PRIVATE_NETWORK: "1" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.child = child;
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-500);
    });
    try {
      const info = await waitForReady(ready, child);
      const wsPath = info.websocket_path || "/devtools/browser";
      return await openCdp(`ws://127.0.0.1:${port}${wsPath}`, token, () => {
        if (this.child === child) this.child = null;
        if (!child.killed) child.kill("SIGTERM");
      });
    } catch (error) {
      if (!child.killed) child.kill("SIGTERM");
      this.child = null;
      const detail = stderr.trim();
      throw new Error(detail || (error instanceof Error ? error.message : "obscura did not start"));
    }
  }

  private onEvent(event: CdpEvent) {
    if (event.method !== "Page.screencastFrame") return;
    const data = event.params.data;
    const frameId = event.params.sessionId;
    const sessionId = event.sessionId;
    if (sessionId && typeof frameId === "number" && this.live && !this.live.closed) {
      void this.live.call("Page.screencastFrameAck", { sessionId: frameId }, sessionId).catch(() => undefined);
    }
    if (typeof data !== "string" || !sessionId) return;
    const tab = [...this.tabs.values()].find((item) => item.sessionId === sessionId);
    if (tab?.watching) this.hooks.onFrame(tab.chatId, data);
  }

  private async cdp(method: string, params: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    const client = await this.ensureClient();
    try {
      return await client.call(method, params, sessionId);
    } catch (error) {
      if (client.closed) {
        this.live = null;
        this.tabs.clear();
      }
      throw error;
    }
  }

  private publish(tab: Tab): BrowserStatus {
    const title = this.last.get(tab.chatId)?.title ?? "";
    const status = this.statusOf(tab, title);
    this.last.set(tab.chatId, status);
    this.hooks.onStatus(tab.chatId, status);
    return status;
  }

  private statusOf(tab: Tab, title = this.last.get(tab.chatId)?.title ?? ""): BrowserStatus {
    return {
      url: tab.index >= 0 ? tab.history[tab.index] ?? "" : "",
      title,
      canBack: tab.index > 0,
      canForward: tab.index >= 0 && tab.index < tab.history.length - 1,
    };
  }

  private emit(chatId: string, patch: Partial<BrowserStatus>) {
    const prev = this.last.get(chatId) ?? { url: "", title: "", canBack: false, canForward: false };
    const next: BrowserStatus = { ...prev, ...patch };
    if (patch.error) next.error = patch.error;
    else delete next.error;
    this.last.set(chatId, next);
    this.hooks.onStatus(chatId, next);
  }

  private touch() {
    this.used = Date.now();
    this.armIdle();
  }

  private armIdle() {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.closed) return;
      if (this.busy > 0 || [...this.tabs.values()].some((tab) => tab.watching)) {
        this.armIdle();
        return;
      }
      if (Date.now() - this.used < this.idleMs) {
        this.armIdle();
        return;
      }
      this.shutdown();
    }, this.idleMs);
    this.timer.unref?.();
  }

  private shutdown() {
    this.live?.close();
    this.live = null;
    this.tabs.clear();
    if (this.child && !this.child.killed) this.child.kill("SIGTERM");
    this.child = null;
  }

  private run<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
    const job = this.chain.then(async () => {
      this.busy += 1;
      this.touch();
      try {
        return await fn();
      } catch (error) {
        const message = error instanceof Error ? error.message : "browser failed";
        this.emit(chatId, { error: message });
        throw error;
      } finally {
        this.busy -= 1;
      }
    });
    this.chain = job.then(() => undefined, () => undefined);
    return job;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function waitForReady(file: string, child: ChildProcess): Promise<{ websocket_path?: string }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (child.exitCode != null) {
        reject(new Error("obscura stopped"));
        return;
      }
      readFile(file, "utf8").then((body) => {
        try {
          resolve(JSON.parse(body) as { websocket_path?: string });
        } catch {
          resolve({});
        }
      }).catch(() => {
        if (Date.now() - started > 8000) reject(new Error("obscura did not start"));
        else setTimeout(tick, 40);
      });
    };
    tick();
  });
}

function openCdp(url: string, token: string, kill: () => void): Promise<CdpClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    const listeners = new Set<(event: CdpEvent) => void>();
    let next = 1;
    const client: CdpClient = {
      closed: false,
      call(method, params, sessionId) {
        if (client.closed) return Promise.reject(new Error("obscura connection closed"));
        const id = next++;
        return new Promise((ok, fail) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            fail(new Error(`${method} timed out`));
          }, 20000);
          pending.set(id, {
            resolve: (value) => {
              clearTimeout(timer);
              ok(value);
            },
            reject: (error) => {
              clearTimeout(timer);
              fail(error);
            },
          });
          ws.send(JSON.stringify({ id, method, params: params ?? {}, ...(sessionId ? { sessionId } : {}) }));
        });
      },
      listen(handler) {
        listeners.add(handler);
      },
      close() {
        client.closed = true;
        ws.close();
        kill();
      },
    };
    const fail = (error: Error) => {
      client.closed = true;
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      reject(error);
    };
    const timer = setTimeout(() => {
      ws.terminate();
      fail(new Error("obscura did not accept a connection"));
    }, 8000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve(client);
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      fail(error instanceof Error ? error : new Error("obscura connection failed"));
    });
    ws.on("close", () => {
      client.closed = true;
      const error = new Error("obscura connection closed");
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    });
    ws.on("message", (data) => {
      let message: { id?: number; method?: string; sessionId?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(String(data)) as typeof message;
      } catch {
        return;
      }
      if (message.id && pending.has(message.id)) {
        const waiter = pending.get(message.id)!;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message || "browser request failed"));
        else waiter.resolve(message.result);
        return;
      }
      if (message.method) {
        const event: CdpEvent = {
          method: message.method,
          ...(message.sessionId ? { sessionId: message.sessionId } : {}),
          params: message.params ?? {},
        };
        for (const listener of listeners) listener(event);
      }
    });
  });
}
