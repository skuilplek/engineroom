import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { assertUsername, isAgentId, isInsidePath, type AgentId, type RunnerRequest, type Settings, type SettingsPatch, type StreamEvent } from "@engineroom/protocol";
import { type Account, cleanPassword, listAccounts, runAdminCtl } from "./accounts.ts";
import { enabledAgentIds, flagsFromBody, loadAgentFlags, saveAgentFlags } from "./agents.ts";
import { lookupUser, pamAuthenticate, userMayLogin, type LinuxUser } from "./auth.ts";
import { callRunner, type RunnerLink } from "./runner-client.ts";
import { clearCookie, cookieValue, readSession, sessionCookie, signSession } from "./session.ts";

export interface HubOptions {
  link: RunnerLink;
  sessionSecret: Buffer;
  pamHelper: string;
  webDist?: string;
  cookieSecure: boolean;
  adminUser?: string;
  agentsFile?: string;
  adminCtl?: string;
  lookup?: (username: string) => LinuxUser | null;
  authenticate?: (username: string, password: string) => Promise<boolean>;
  listAccounts?: () => Account[];
  runAdmin?: (action: "add" | "revoke", username: string, password?: string) => Promise<void>;
}

const failures = new Map<string, { count: number; reset: number }>();

interface RunnerCall {
  type: RunnerRequest["type"];
  chatId?: string;
  agent?: AgentId;
  model?: string;
  workspace?: string;
  title?: string;
  settings?: SettingsPatch;
  prompt?: string;
}

export function createHub(options: HubOptions) {
  const lookup = options.lookup ?? lookupUser;
  const authenticate =
    options.authenticate ??
    ((username: string, password: string) => pamAuthenticate(username, password, options.pamHelper));
  const adminUser = (options.adminUser || "").trim();
  const agentsFile = options.agentsFile || "";
  const accounts = options.listAccounts ?? (() => listAccounts());
  const runAdmin =
    options.runAdmin ??
    ((action: "add" | "revoke", username: string, password?: string) =>
      runAdminCtl(options.adminCtl || "/usr/local/bin/engineroom-admin", action, username, password));

  return createServer((req, res) => {
    void handle(req, res).catch((error) => {
      const message = error instanceof Error ? error.message : "request failed";
      sendJson(res, statusFor(message), { error: message });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    const url = new URL(req.url || "/", "http://hub.local");
    if (url.pathname === "/api/health" && req.method === "GET") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (url.pathname === "/api/login" && req.method === "POST") {
      await login(req, res);
      return;
    }
    if (url.pathname === "/api/logout" && req.method === "POST") {
      res.setHeader("Set-Cookie", clearCookie(options.cookieSecure));
      sendJson(res, 200, { ok: true });
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      serveStatic(req, res, url.pathname);
      return;
    }
    const username = readSession(cookieValue(req.headers.cookie), options.sessionSecret);
    if (!username) {
      sendJson(res, 401, { error: "sign in required" });
      return;
    }
    const user = lookup(username);
    if (!userMayLogin(user)) {
      sendJson(res, 401, { error: "sign in required" });
      return;
    }
    if (url.pathname === "/api/me" && req.method === "GET") {
      sendJson(res, 200, profile(user));
      return;
    }
    if (url.pathname.startsWith("/api/admin")) {
      await admin(req, res, url, user);
      return;
    }
    await proxy(req, res, url, user);
  }

  async function login(req: IncomingMessage, res: ServerResponse) {
    const body = (await readJson(req)) as { username?: unknown; password?: unknown };
    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";
    const key = `${req.socket.remoteAddress || ""}:${username}`;
    if (limited(key)) {
      sendJson(res, 429, { error: "too many attempts" });
      return;
    }
    const user = lookup(username);
    let ok = false;
    if (user && userMayLogin(user) && password.length > 0) {
      ok = await authenticate(user.username, password);
    }
    if (!ok || !user) {
      noteFailure(key);
      sendJson(res, 401, { error: "invalid username or password" });
      return;
    }
    failures.delete(key);
    res.setHeader("Set-Cookie", sessionCookie(signSession(user.username, options.sessionSecret), options.cookieSecure));
    sendJson(res, 200, profile(user));
  }

  function profile(user: LinuxUser) {
    return {
      username: user.username,
      home: user.home,
      admin: adminUser !== "" && user.username === adminUser,
      agents: enabledAgentIds(loadAgentFlags(agentsFile)),
    };
  }

  function assertAgentEnabled(agent: AgentId) {
    if (!loadAgentFlags(agentsFile)[agent]) throw new Error("invalid agent");
  }

  async function admin(req: IncomingMessage, res: ServerResponse, url: URL, user: LinuxUser) {
    if (user.username !== adminUser || adminUser === "") {
      sendJson(res, 403, { error: "admin only" });
      return;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[2] === "agents" && parts.length === 3 && req.method === "PUT") {
      const flags = saveAgentFlags(agentsFile, flagsFromBody(await readJson(req)));
      sendJson(res, 200, { agents: enabledAgentIds(flags) });
      return;
    }
    if (parts[2] === "users" && parts.length === 3 && req.method === "GET") {
      sendJson(res, 200, accounts());
      return;
    }
    if (parts[2] === "users" && parts.length === 3 && req.method === "POST") {
      const body = (await readJson(req)) as { username?: unknown; password?: unknown };
      const username = assertUsername(typeof body.username === "string" ? body.username : "");
      if (username === adminUser) throw new Error("must not change this account");
      await runAdmin("add", username, cleanPassword(body.password));
      sendJson(res, 201, { ok: true });
      return;
    }
    if (parts[2] === "users" && parts[4] === "revoke" && parts.length === 5 && req.method === "POST") {
      const username = assertUsername(decodeURIComponent(parts[3] || ""));
      if (username === adminUser) throw new Error("must not change this account");
      await runAdmin("revoke", username);
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 404, { error: "not found" });
  }

  async function proxy(req: IncomingMessage, res: ServerResponse, url: URL, user: LinuxUser) {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[1] === "settings" && parts.length === 2 && req.method === "GET") {
      sendJson(res, 200, await call(user, { type: "get_settings" }));
      return;
    }
    if (parts[1] === "settings" && parts.length === 2 && req.method === "PUT") {
      const body = (await readJson(req)) as { settings?: SettingsPatch };
      const patch = (body.settings ?? body) as SettingsPatch;
      if (patch.defaultAgent) assertAgentEnabled(patch.defaultAgent);
      sendJson(res, 200, await call(user, { type: "put_settings", settings: patch }));
      return;
    }
    if (parts[1] === "workspaces" && req.method === "GET") {
      sendJson(res, 200, await call(user, { type: "list_workspaces" }));
      return;
    }
    if (parts[1] === "chats" && parts.length === 2 && req.method === "GET") {
      sendJson(res, 200, await call(user, { type: "list_chats" }));
      return;
    }
    if (parts[1] === "chats" && parts.length === 2 && req.method === "POST") {
      const body = (await readJson(req)) as Record<string, unknown>;
      if (body.agent == null || body.agent === "") {
        const settings = (await call(user, { type: "get_settings" })) as Settings;
        assertAgentEnabled(settings.defaultAgent);
      } else {
        if (!isAgentId(body.agent)) throw new Error("invalid agent");
        assertAgentEnabled(body.agent);
      }
      sendJson(
        res,
        201,
        await call(user, {
          type: "create_chat",
          agent: isAgentId(body.agent) ? body.agent : undefined,
          model: body.model as string | undefined,
          workspace: body.workspace as string | undefined,
          title: body.title as string | undefined,
        }),
      );
      return;
    }
    if (parts[1] === "chats" && parts.length === 3 && req.method === "GET") {
      sendJson(res, 200, await call(user, { type: "get_chat", chatId: parts[2]! }));
      return;
    }
    if (parts[1] === "chats" && parts[3] === "cancel" && req.method === "POST") {
      sendJson(res, 200, await call(user, { type: "cancel", chatId: parts[2]! }));
      return;
    }
    if (parts[1] === "chats" && parts[3] === "messages" && req.method === "POST") {
      const body = (await readJson(req)) as { prompt?: unknown };
      if (typeof body.prompt !== "string") throw new Error("prompt is empty");
      await streamMessage(res, user, parts[2]!, body.prompt);
      return;
    }
    sendJson(res, 404, { error: "not found" });
  }

  async function streamMessage(res: ServerResponse, user: LinuxUser, chatId: string, prompt: string) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let finished = false;
    let sawFailure = false;
    res.on("close", () => {
      if (!finished) {
        finished = true;
        void call(user, { type: "cancel", chatId }).catch(() => undefined);
      }
    });
    try {
      await call(
        user,
        { type: "send", chatId, prompt },
        (event) => {
          if (event.type === "error") sawFailure = true;
          if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "send failed";
      if (!sawFailure && !res.writableEnded) {
        const event: StreamEvent = { type: "error", text: message };
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } finally {
      finished = true;
      if (!res.writableEnded) res.end();
    }
  }

  function call(user: LinuxUser, request: RunnerCall, onEvent?: (event: StreamEvent) => void) {
    return callRunner(
      options.link,
      user.username,
      user.uid,
      { ...request, id: randomUUID() } as RunnerRequest,
      onEvent,
    );
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
    if (!options.webDist) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    const root = path.resolve(options.webDist);
    const requested = pathname === "/" ? "/index.html" : pathname;
    const file = path.resolve(root, requested.replace(/^\/+/, ""));
    if (!isInsidePath(root, file) || !existsSync(file) || !statSync(file).isFile()) {
      const index = path.join(root, "index.html");
      if (req.method === "GET" && existsSync(index)) {
        streamFile(res, index);
        return;
      }
      sendJson(res, 404, { error: "not found" });
      return;
    }
    streamFile(res, file);
  }
}

function streamFile(res: ServerResponse, file: string) {
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json",
    ".woff2": "font/woff2",
  };
  res.setHeader("Content-Type", types[path.extname(file)] || "application/octet-stream");
  createReadStream(file).pipe(res);
}

function statusFor(message: string): number {
  if (message.includes("invalid") || message.includes("empty") || message.includes("must")) return 400;
  if (message.includes("not found") || message.includes("ENOENT")) return 404;
  if (message.includes("already running")) return 409;
  return 500;
}

function limited(key: string): boolean {
  const entry = failures.get(key);
  if (!entry || entry.reset < Date.now()) return false;
  return entry.count >= 8;
}

function noteFailure(key: string) {
  const entry = failures.get(key);
  if (!entry || entry.reset < Date.now()) {
    failures.set(key, { count: 1, reset: Date.now() + 10 * 60 * 1000 });
    return;
  }
  entry.count += 1;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 1_000_000) throw new Error("body is too large");
    chunks.push(buf);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid JSON");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}
