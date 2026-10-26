import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { assertBranchName, assertChatId, assertRepoRelativePath, assertUsername, cleanMode, cleanModel, decodePtyFrame, effectiveAgentOptions, encodePtyFrame, isAgentId, isBuiltinAgent, isInsidePath, isTheme, MAX_TRANSFER_BYTES, parseAgentCommand, parseAgentLabel, parseClientCommand, parseEnvEntries, parseFileVisibility, parseUserPolicy, repoUploadPath, type AgentDefinition, type AgentId, type AgentOptionChoice, type CatalogEntry, type ChatMeta, type EnvEntry, type FileVisibility, type RepoFileDownload, type RepoFileUpload, type RepositoryEntry, type RunnerRequest, type Settings, type SettingsPatch, type UserAccess, type UserPolicy } from "@engineroom/protocol";
import { type Account, cleanPassword, listAccounts, runAdminCtl } from "./accounts.ts";
import { loadAgentOptions, recordProbe, restrictPolicy, saveOfferedOptions } from "./agent-options.ts";
import { addCustomAgent, customCatalog, detectionNames, listAgents, loadAgentFlags, loadAppName, loadCliImport, loadFileDownload, loadFileEditor, loadFileManager, loadFileUpload, loadPiConfig, loadRawTerminal, namesFor, offeredAgentIds, piSetupAllowed, removeCustomAgent, saveAgentFlags, saveAppName, usableAgentIds, withResolvedCommands } from "./agents.ts";
import { addCatalogEntry, loadCatalog, removeCatalogEntry } from "./catalog.ts";
import { loadFileVisibility, loadProjectCreate, loadProjectDownloads, loadRepoDirectory, saveRepoDirectory } from "./repo-folder.ts";
import { serverOverview } from "./overview.ts";
import { invalidateUserCache, lookupUser, pamAuthenticate, userMayLogin, type LinuxUser } from "./auth.ts";
import { RunnerChannel, type PushMessage } from "./channel.ts";
import { readUpload } from "./multipart.ts";
import { callRunner, streamRunnerFile, type RunnerLink } from "./runner-client.ts";
import { clearCookie, cookieValue, readSession, sessionCookie, signSession } from "./session.ts";

export interface HubOptions {
  link: RunnerLink;
  sessionSecret: Buffer;
  pamHelper: string;
  webDist?: string;
  cookieSecure: boolean;
  adminUser?: string;
  agentsFile?: string;
  agentOptionsFile?: string;
  catalogFile?: string;
  reposFile?: string;
  checksFile?: string;
  commandDirs?: string[];
  adminCtl?: string;
  lookup?: (username: string) => LinuxUser | null;
  authenticate?: (username: string, password: string) => Promise<boolean>;
  listAccounts?: () => Account[];
  runAdmin?: (action: "add" | "revoke" | "passwd" | "remove", username: string, password?: string) => Promise<void>;
}

const failures = new Map<string, { count: number; reset: number }>();

interface RunnerCall {
  type: RunnerRequest["type"];
  chatId?: string;
  agent?: AgentId;
  mode?: string;
  model?: string;
  workspace?: string;
  title?: string;
  settings?: SettingsPatch;
  prompt?: string;
  enabled?: string[];
  policy?: UserPolicy;
  entries?: EnvEntry[];
  repos?: CatalogEntry[];
  catalog?: string[];
  agents?: AgentDefinition[];
  directory?: string;
  modeId?: string;
  modelId?: string;
  path?: string;
  newPath?: string;
  kind?: "file" | "dir";
  content?: string;
  contentBase64?: string;
  overwrite?: boolean;
  visibility?: FileVisibility;
  names?: string[];
  refresh?: boolean;
  install?: "user" | "global";
  auth?: "user" | "shared";
  provider?: string;
  linkShared?: boolean;
  name?: string;
  url?: string;
  branch?: string;
  archiveId?: string;
}

export function createHub(options: HubOptions) {
  const lookup = options.lookup ?? lookupUser;
  const authenticate =
    options.authenticate ??
    ((username: string, password: string) => pamAuthenticate(username, password, options.pamHelper));
  const adminUser = (options.adminUser || "").trim();
  const agentsFile = options.agentsFile || "";
  const agentOptionsFile = options.agentOptionsFile || (agentsFile ? path.join(path.dirname(agentsFile), "agent-options.json") : "");
  const catalogFile = options.catalogFile || "";
  const reposFile = options.reposFile || "";
  const checksFile = options.checksFile || "";
  const commandDirs = options.commandDirs;
  const accounts = options.listAccounts ?? (() => listAccounts());
  const runAdmin = async (action: "add" | "revoke" | "passwd" | "remove", username: string, password?: string) => {
    if (options.runAdmin) await options.runAdmin(action, username, password);
    else await runAdminCtl(options.adminCtl || "/usr/local/bin/engineroom-admin", action, username, password);
    invalidateUserCache(username);
  };

  const liveSockets = new Map<string, Set<WebSocket>>();
  const endedSockets = new WeakSet<WebSocket>();

  function closeLiveSockets(username: string) {
    const group = liveSockets.get(username);
    if (!group) return;
    for (const ws of [...group]) {
      endedSockets.add(ws);
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(4401, "sign in required");
    }
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      const message = error instanceof Error ? error.message : "request failed";
      sendJson(res, statusFor(message), { error: message });
    });
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://hub.local");
    if (url.pathname !== "/api/ws") {
      socket.destroy();
      return;
    }
    if (!originAllowed(req)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      void handleWebSocket(req, ws).catch((error) => {
        const message = error instanceof Error ? error.message : "socket failed";
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "error", error: message }));
        ws.close();
      });
    });
  });
  return server;

  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    const url = new URL(req.url || "/", "http://hub.local");
    if (url.pathname.startsWith("/api/") && req.method !== "GET" && req.method !== "HEAD") {
      if (!mutationOriginAllowed(req)) {
        sendJson(res, 403, { error: "forbidden origin" });
        return;
      }
    }
    if (url.pathname === "/api/health" && req.method === "GET") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (url.pathname === "/api/login" && req.method === "POST") {
      await login(req, res);
      return;
    }
    if (url.pathname === "/api/logout" && req.method === "POST") {
      const username = readSession(cookieValue(req.headers.cookie), options.sessionSecret);
      if (username) closeLiveSockets(username);
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
      sendJson(res, 200, await profile(user));
      return;
    }
    if (url.pathname === "/api/pi/setup" && req.method === "POST") {
      await setupPi(user);
      sendJson(res, 200, await profile(user));
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
    const key = `${clientAddress(req)}:${username}`;
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
    await call(user, { type: "detect_repositories", directory: loadRepoDirectory(reposFile) }).catch(() => undefined);
    await syncAgentCatalog(user).catch(() => undefined);
    res.setHeader("Set-Cookie", sessionCookie(signSession(user.username, options.sessionSecret), options.cookieSecure));
    sendJson(res, 200, await profile(user));
  }

  async function profile(user: LinuxUser) {
    const access = await loadAccess(user, true);
    const settings = (await call(user, { type: "get_settings" })) as Settings;
    return {
      username: user.username,
      home: user.home,
      admin: adminUser !== "" && user.username === adminUser,
      agents: access.agents,
      rawTerminal: access.rawTerminal,
      fileManager: access.fileManager,
      fileManagerOffered: loadFileManager(agentsFile),
      fileEditor: access.fileEditor,
      fileDownload: access.fileDownload,
      fileUpload: access.fileUpload,
      fileDownloadOffered: loadFileDownload(agentsFile),
      fileUploadOffered: loadFileUpload(agentsFile),
      filesReadOnly: Boolean(settings.filesReadOnly),
      options: access.options,
      theme: isTheme(settings.theme) ? settings.theme : "dark",
      cliImport: loadCliImport(agentsFile),
      appName: loadAppName(agentsFile),
      piSetup: access.piSetup,
      piLoginHint: access.piLoginHint,
      fileVisibility: loadFileVisibility(reposFile),
      projectCreate: access.projectCreate,
      projectDownloads: loadProjectDownloads(reposFile),
      agentCatalog: namesFor(access.agents, agentsFile),
    };
  }

  async function loadAccess(user: LinuxUser, refresh = false): Promise<{
    agents: AgentId[];
    rawTerminal: boolean;
    fileManager: boolean;
    fileEditor: boolean;
    fileDownload: boolean;
    fileUpload: boolean;
    projectCreate: boolean;
    piSetup: boolean;
    piLoginHint: boolean;
    options: Partial<Record<AgentId, { modes: AgentOptionChoice[]; models: AgentOptionChoice[] }>>;
  }> {
    const flags = loadAgentFlags(agentsFile);
    const pi = loadPiConfig(agentsFile);
    await call(user, { type: "put_pi_site", install: pi.install, auth: pi.auth }).catch(() => undefined);
    const listed = await visibleAgents(user, refresh);
    const policy = (await call(user, { type: "get_policy" })) as UserPolicy;
    const stored = loadAgentOptions(agentOptionsFile);
    const missing = policy.agents.filter((agent) => !listed.some((item) => item.id === agent && item.available));
    const overrides: Partial<Record<string, string>> = { ...policy.binaries };
    const resolvedOverrides = new Map<string, string>();
    if (missing.length > 0) {
      const settings = (await call(user, { type: "get_settings" })) as Settings;
      for (const agent of missing) {
        overrides[agent] = policy.binaries[agent] || settings.binaries[agent];
      }
      const paths = [...new Set(missing.map((agent) => overrides[agent]).filter((value): value is string => Boolean(value)))];
      const resolved = await resolveCommands(user, paths);
      for (const [name, found] of resolved) resolvedOverrides.set(name, found);
    }
    const agents = usableAgentIds(flags, listed, policy.agents, overrides, resolvedOverrides);
    const piInstalled = listed.some((item) => item.id === "pi" && item.available);
    const piSetup = piSetupAllowed(pi, Boolean(flags.pi), policy.agents.includes("pi"), policy.piAuth, piInstalled);
    const optionMap: Partial<Record<AgentId, { modes: AgentOptionChoice[]; models: AgentOptionChoice[] }>> = {};
    for (const agent of agents) {
      const config = stored[agent];
      optionMap[agent] = effectiveAgentOptions(config?.discovered, config?.offered, policy.options?.[agent]);
    }
    const fileManager = loadFileManager(agentsFile) && policy.fileManager;
    return {
      agents,
      rawTerminal: loadRawTerminal(agentsFile) && policy.rawTerminal,
      fileManager,
      fileEditor: loadFileEditor(agentsFile) && policy.fileEditor !== false,
      fileDownload: fileManager && loadFileDownload(agentsFile) && policy.fileDownload,
      fileUpload: fileManager && loadFileUpload(agentsFile) && policy.fileUpload,
      projectCreate: loadProjectCreate(reposFile) && policy.projectCreate,
      piSetup,
      piLoginHint: false,
      options: optionMap,
    };
  }

  async function setupPi(user: LinuxUser) {
    const pi = loadPiConfig(agentsFile);
    const flags = loadAgentFlags(agentsFile);
    const policy = (await call(user, { type: "get_policy" })) as UserPolicy;
    const listed = await visibleAgents(user, true);
    const installed = listed.some((item) => item.id === "pi" && item.available);
    if (!piSetupAllowed(pi, Boolean(flags.pi), policy.agents.includes("pi"), policy.piAuth, installed)) {
      throw new Error("invalid pi setup");
    }
    await call(user, { type: "put_pi_site", install: pi.install, auth: pi.auth });
    await call(user, {
      type: "setup_pi",
      provider: pi.provider,
      model: pi.model,
      linkShared: false,
    });
  }

  async function assertCreateMode(user: LinuxUser, agent: AgentId, mode: string) {
    if (!mode) return;
    const access = await loadAccess(user);
    const allowed = access.options[agent]?.modes ?? [];
    if (!allowed.some((choice) => choice.id === mode)) throw new Error("invalid mode");
  }

  async function assertFileEditorAllowed(user: LinuxUser) {
    await assertFileManager(user);
    const access = await loadAccess(user);
    if (!access.fileEditor) throw new Error("file editing is not enabled");
    const settings = (await call(user, { type: "get_settings" })) as Settings;
    if (settings.filesReadOnly) throw new Error("file editing is not enabled");
  }

  async function assertModelChoice(user: LinuxUser, agent: AgentId, model: string) {
    const access = await loadAccess(user);
    const allowed = access.options[agent]?.models ?? [];
    if (allowed.length === 0) {
      if (model) throw new Error("invalid model");
      return;
    }
    if (!allowed.some((choice) => choice.id === model)) throw new Error("invalid model");
  }

  function assertModeChoice(options: { modes: AgentOptionChoice[] }, modeId: string) {
    if (!options.modes.some((choice) => choice.id === modeId)) throw new Error("invalid mode");
  }

  async function alignStored(user: LinuxUser, chat: ChatMeta, send: (request: RunnerCall) => Promise<unknown>) {
    const access = await loadAccess(user);
    const options = access.options[chat.agent] ?? { modes: [], models: [] };
    const mode = fitChoice(chat.mode || "", options.modes);
    const model = fitChoice(chat.model || "", options.models);
    if ((chat.mode || "") !== mode) {
      await send({ type: "set_mode", chatId: chat.id, modeId: mode });
      chat.mode = mode;
    }
    if ((chat.model || "") !== model) {
      await send({ type: "set_model", chatId: chat.id, modelId: model });
      chat.model = model;
    }
  }

  async function assertAgentAllowed(user: LinuxUser, agent: AgentId) {
    const access = await loadAccess(user);
    if (!access.agents.includes(agent)) throw new Error("invalid agent");
  }

  async function assertProjectCreate(user: LinuxUser) {
    const access = await loadAccess(user);
    if (!access.projectCreate) throw new Error("project creation is not enabled");
  }

  function assertProjectDownloads() {
    if (!loadProjectDownloads(reposFile)) throw new Error("project download is not enabled");
  }

  async function assertFileManager(user: LinuxUser) {
    const access = await loadAccess(user);
    if (!access.fileManager) throw new Error("file manager is not enabled");
  }

  async function assertFileDownload(user: LinuxUser) {
    await assertFileManager(user);
    const access = await loadAccess(user);
    if (!access.fileDownload) throw new Error("file download is not enabled");
  }

  async function assertFileUpload(user: LinuxUser) {
    await assertFileManager(user);
    const access = await loadAccess(user);
    if (!access.fileUpload) throw new Error("file upload is not enabled");
    const settings = (await call(user, { type: "get_settings" })) as Settings;
    if (settings.filesReadOnly) throw new Error("file upload is not enabled");
  }

  async function admin(req: IncomingMessage, res: ServerResponse, url: URL, user: LinuxUser) {
    if (user.username !== adminUser || adminUser === "") {
      sendJson(res, 403, { error: "admin only" });
      return;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[2] === "overview" && parts.length === 3 && req.method === "GET") {
      const overview = await serverOverview({ configFile: checksFile, commandDirs });
      const resolved = await resolveCommands(
        user,
        overview.commands.filter((command) => !command.available).map((command) => command.name),
      );
      sendJson(res, 200, {
        ...overview,
        commands: overview.commands.map((command) => {
          const found = resolved.get(command.name);
          return found ? { ...command, available: true, path: found } : command;
        }),
      });
      return;
    }
    if (parts[2] === "branding" && parts.length === 3 && req.method === "PUT") {
      const body = await readJson(req);
      const appName = saveAppName(agentsFile, appNameFrom(body));
      sendJson(res, 200, { appName });
      return;
    }
    if (parts[2] === "agents" && parts.length === 3 && req.method === "GET") {
      sendJson(res, 200, await agentState(user));
      return;
    }
    if (parts[2] === "agents" && parts.length === 3 && req.method === "PUT") {
      const body = await readJson(req);
      const flags = saveAgentFlags(
        agentsFile,
        body,
        rawTerminalFrom(body),
        cliImportFrom(body),
        fileManagerFrom(body),
        fileEditorFrom(body),
        fileDownloadFrom(body),
        fileUploadFrom(body),
      );
      const listed = await visibleAgents(user);
      sendJson(res, 200, {
        agents: offeredAgentIds(flags, listed),
        rawTerminal: loadRawTerminal(agentsFile),
        cliImport: loadCliImport(agentsFile),
        fileManager: loadFileManager(agentsFile),
        fileEditor: loadFileEditor(agentsFile),
        fileDownload: loadFileDownload(agentsFile),
        fileUpload: loadFileUpload(agentsFile),
        agentCatalog: namesFor(offeredAgentIds(flags, listed), agentsFile),
        ...piPayload(agentsFile),
      });
      return;
    }
    if (parts[2] === "agents" && parts[3] === "custom" && parts.length === 4 && req.method === "POST") {
      const body = (await readJson(req)) as { label?: unknown; binary?: unknown };
      addCustomAgent(agentsFile, parseAgentLabel(body.label), parseAgentCommand(body.binary));
      await syncAgentCatalog(user).catch(() => undefined);
      sendJson(res, 201, await agentState(user));
      return;
    }
    if (parts[2] === "agents" && parts[3] === "custom" && parts.length === 5 && req.method === "DELETE") {
      removeCustomAgent(agentsFile, decodeURIComponent(parts[4] || ""));
      await syncAgentCatalog(user).catch(() => undefined);
      sendJson(res, 200, await agentState(user));
      return;
    }
    if (parts[2] === "agent-options" && parts.length === 3 && req.method === "GET") {
      sendJson(res, 200, loadAgentOptions(agentOptionsFile));
      return;
    }
    if (parts[2] === "agent-options" && parts.length === 3 && req.method === "PUT") {
      sendJson(res, 200, saveOfferedOptions(agentOptionsFile, await readJson(req)));
      return;
    }
    if (parts[2] === "agent-options" && parts.length === 5 && parts[4] === "probe" && req.method === "POST") {
      const agent = decodeURIComponent(parts[3] || "");
      if (!isAgentId(agent) || !loadAgentFlags(agentsFile)[agent]) throw new Error("invalid agent");
      if (!isBuiltinAgent(agent)) {
        const listed = await visibleAgents(user);
        if (!listed.some((item) => item.id === agent && item.available)) throw new Error("invalid agent");
      }
      await syncAgentCatalog(user);
      const found = (await call(user, { type: "probe_agent", agent })) as { modes: AgentOptionChoice[]; models: AgentOptionChoice[] };
      sendJson(res, 200, recordProbe(agentOptionsFile, agent, found));
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
    if (parts[2] === "repository-folder" && parts.length === 3 && req.method === "GET") {
      sendJson(res, 200, {
        directory: loadRepoDirectory(reposFile),
        visibility: loadFileVisibility(reposFile),
        projectCreate: loadProjectCreate(reposFile),
        projectDownloads: loadProjectDownloads(reposFile),
      });
      return;
    }
    if (parts[2] === "repository-folder" && parts.length === 3 && req.method === "PUT") {
      const body = (await readJson(req)) as { directory?: unknown; visibility?: unknown; projectCreate?: unknown; projectDownloads?: unknown };
      if (body.projectCreate != null && typeof body.projectCreate !== "boolean") throw new Error("invalid project creation");
      if (body.projectDownloads != null && typeof body.projectDownloads !== "boolean") throw new Error("invalid project download");
      const nextVisibility = body.visibility != null ? parseFileVisibility(body.visibility) : undefined;
      const saved = saveRepoDirectory(
        reposFile,
        typeof body.directory === "string" ? body.directory : "",
        nextVisibility,
        typeof body.projectCreate === "boolean" ? body.projectCreate : undefined,
        typeof body.projectDownloads === "boolean" ? body.projectDownloads : undefined,
      );
      sendJson(res, 200, saved);
      return;
    }
    if (parts[2] === "catalog" && parts.length === 3 && req.method === "GET") {
      sendJson(res, 200, { repositories: loadCatalog(catalogFile) });
      return;
    }
    if (parts[2] === "catalog" && parts.length === 3 && req.method === "POST") {
      const body = (await readJson(req)) as { name?: unknown; url?: unknown };
      const entry = addCatalogEntry(catalogFile, typeof body.name === "string" ? body.name : "", typeof body.url === "string" ? body.url : "");
      sendJson(res, 201, entry);
      return;
    }
    if (parts[2] === "catalog" && parts.length === 4 && req.method === "DELETE") {
      sendJson(res, 200, { repositories: removeCatalogEntry(catalogFile, decodeURIComponent(parts[3] || "")) });
      return;
    }
    if (parts[2] === "users" && parts.length === 4 && req.method === "GET") {
      const target = managedUser(parts[3] || "");
      const access = (await call(target, { type: "get_access" })) as UserAccess;
      sendJson(res, 200, { username: target.username, home: target.home, uid: target.uid, ...access });
      return;
    }
    if (parts[2] === "users" && parts.length === 5) {
      const target = managedUser(parts[3] || "");
      const action = parts[4];
      if (action === "policy" && req.method === "PUT") {
        const policy = restrictPolicy(parseUserPolicy(await readJson(req)), loadAgentOptions(agentOptionsFile));
        const flags = loadAgentFlags(agentsFile);
        const listed = await visibleAgents(target);
        const offerable = new Set(offeredAgentIds(flags, listed));
        if (policy.agents.some((agent) => !offerable.has(agent))) throw new Error("invalid agent");
        await syncAgentCatalog(target);
        sendJson(res, 200, await call(target, { type: "put_policy", policy }));
        return;
      }
      if (action === "settings" && req.method === "PUT") {
        const body = (await readJson(req)) as SettingsPatch;
        if (body.defaultAgent) await assertAgentAllowed(target, body.defaultAgent);
        await assertSettingsModel(target, body);
        sendJson(res, 200, await call(target, { type: "put_settings", settings: body }));
        return;
      }
      if (action === "repositories" && req.method === "GET") {
        sendJson(res, 200, await call(target, { type: "list_repositories" }));
        return;
      }
      if (action === "repositories" && req.method === "PUT") {
        const body = (await readJson(req)) as { ids?: unknown };
        if (!Array.isArray(body.ids)) throw new Error("invalid repositories");
        const catalog = loadCatalog(catalogFile);
        const repos: CatalogEntry[] = [];
        const seen = new Set<string>();
        for (const id of body.ids) {
          if (typeof id !== "string" || seen.has(id)) throw new Error("invalid repositories");
          seen.add(id);
          const entry = catalog.find((item) => item.id === id);
          if (!entry) throw new Error("invalid repository");
          repos.push(entry);
        }
        sendJson(res, 200, await call(target, {
          type: "sync_repositories",
          repos,
          catalog: catalog.map((entry) => entry.name),
          directory: loadRepoDirectory(reposFile),
        }));
        return;
      }
      if (action === "chats" && req.method === "GET") {
        sendJson(res, 200, await call(target, { type: "list_chats" }));
        return;
      }
      if (action === "env" && req.method === "GET") {
        sendJson(res, 200, await call(target, { type: "get_env" }));
        return;
      }
      if (action === "env" && req.method === "PUT") {
        const body = (await readJson(req)) as { entries?: unknown };
        sendJson(res, 200, await call(target, { type: "put_env", entries: parseEnvEntries(body.entries) }));
        return;
      }
      if (action === "password" && req.method === "POST") {
        if (target.username === adminUser) throw new Error("must not change this account");
        const body = (await readJson(req)) as { password?: unknown };
        await runAdmin("passwd", target.username, cleanPassword(body.password));
        sendJson(res, 200, { ok: true });
        return;
      }
      if (action === "remove" && req.method === "POST") {
        if (target.username === adminUser) throw new Error("must not change this account");
        await runAdmin("remove", target.username);
        sendJson(res, 200, { ok: true });
        return;
      }
    }
    if (parts[2] === "users" && parts.length === 6 && parts[4] === "chats" && req.method === "GET") {
      const target = managedUser(parts[3] || "");
      const chatId = assertChatId(decodeURIComponent(parts[5] || ""));
      sendJson(res, 200, await call(target, { type: "get_chat", chatId }));
      return;
    }
    sendJson(res, 404, { error: "not found" });
  }

  function managedUser(name: string): LinuxUser {
    const username = assertUsername(decodeURIComponent(name));
    const target = lookup(username);
    if (!userMayLogin(target)) throw new Error("not found");
    return target;
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
      if (patch.defaultAgent) await assertAgentAllowed(user, patch.defaultAgent);
      await assertSettingsModel(user, patch);
      sendJson(res, 200, await call(user, { type: "put_settings", settings: patch }));
      return;
    }
    if (parts[1] === "workspaces" && req.method === "GET") {
      sendJson(res, 200, await call(user, { type: "list_workspaces" }));
      return;
    }
    if (parts[1] === "repositories" && parts.length === 2 && req.method === "GET") {
      const listed = (await call(user, { type: "list_repositories" })) as RepositoryEntry[];
      sendJson(res, 200, listed.filter((entry) => entry.enabled));
      return;
    }
    if (parts[1] === "repositories" && parts.length === 2 && req.method === "POST") {
      await assertProjectCreate(user);
      const body = (await readJson(req)) as { name?: unknown; url?: unknown };
      const url = typeof body.url === "string" ? body.url.trim() : "";
      const created = await call(user, {
        type: "create_repository",
        name: typeof body.name === "string" ? body.name.trim() : "",
        directory: loadRepoDirectory(reposFile),
        ...(url ? { url } : {}),
      });
      sendJson(res, 201, created);
      return;
    }
    if (parts[1] === "repositories" && parts[2] === "git" && parts.length === 3 && req.method === "GET") {
      const workspace = (url.searchParams.get("workspace") || "").trim();
      if (!workspace) throw new Error("invalid workspace");
      sendJson(res, 200, await call(user, { type: "git_status", workspace }));
      return;
    }
    if (parts[1] === "repositories" && parts[2] === "git" && parts.length === 3 && req.method === "POST") {
      const body = (await readJson(req)) as { workspace?: unknown; action?: unknown; branch?: unknown };
      const workspace = typeof body.workspace === "string" ? body.workspace.trim() : "";
      if (!workspace) throw new Error("invalid workspace");
      if (body.action === "init") {
        await assertProjectCreate(user);
        sendJson(res, 200, await call(user, { type: "git_init", workspace }));
        return;
      }
      if (body.action === "switch") {
        sendJson(res, 200, await call(user, { type: "git_switch", workspace, branch: assertBranchName(body.branch) }));
        return;
      }
      throw new Error("invalid git action");
    }
    if (parts[1] === "repositories" && parts[2] === "archive" && parts[3] === "download" && parts.length === 4 && req.method === "GET") {
      assertProjectDownloads();
      const archiveId = (url.searchParams.get("id") || "").trim();
      await streamRunnerFile(
        options.link,
        user.username,
        user.uid,
        { id: randomUUID(), type: "read_project_archive", archiveId },
        (meta) => {
          res.writeHead(200, {
            "Content-Type": "application/zip",
            "Content-Disposition": contentDisposition(meta.filename),
            "Cache-Control": "no-store",
            "Content-Length": meta.size,
          });
          return res;
        },
      );
      return;
    }
    if (parts[1] === "repositories" && parts[2] === "archive" && parts.length === 3 && req.method === "GET") {
      assertProjectDownloads();
      const archiveId = (url.searchParams.get("id") || "").trim();
      sendJson(res, 200, await call(user, { type: "project_archive_status", archiveId }));
      return;
    }
    if (parts[1] === "repositories" && parts[2] === "archive" && parts.length === 3 && req.method === "POST") {
      assertProjectDownloads();
      const body = (await readJson(req)) as { workspace?: unknown };
      const workspace = typeof body.workspace === "string" ? body.workspace.trim() : "";
      if (!workspace) throw new Error("invalid workspace");
      sendJson(res, 200, await call(user, { type: "start_project_archive", workspace }));
      return;
    }
    if (parts[1] === "repositories" && parts[2] === "files" && parts.length === 3 && req.method === "GET") {
      await assertFileManager(user);
      const workspace = (url.searchParams.get("workspace") || "").trim();
      if (!workspace) throw new Error("invalid workspace");
      const visibility = loadFileVisibility(reposFile);
      sendJson(res, 200, await call(user, { type: "list_repo_files", workspace, visibility }));
      return;
    }
    if (parts[1] === "repositories" && parts[2] === "file" && parts[3] === "download" && parts.length === 4 && req.method === "GET") {
      await assertFileDownload(user);
      const workspace = (url.searchParams.get("workspace") || "").trim();
      if (!workspace) throw new Error("invalid workspace");
      const filePath = assertRepoRelativePath(url.searchParams.get("path") || "");
      const visibility = loadFileVisibility(reposFile);
      const result = (await call(user, {
        type: "download_repo_file",
        workspace,
        path: filePath,
        visibility,
      })) as RepoFileDownload;
      const bytes = Buffer.from(result.contentBase64, "base64");
      if (bytes.length > MAX_TRANSFER_BYTES || bytes.length !== result.size) throw new Error("invalid file content");
      sendBytes(res, 200, bytes, contentDisposition(result.name));
      return;
    }
    if (parts[1] === "repositories" && parts[2] === "file" && parts[3] === "upload" && parts.length === 4 && req.method === "POST") {
      await assertFileUpload(user);
      const form = await readUpload(req);
      const workspace = (form.fields.workspace || "").trim();
      if (!workspace) throw new Error("invalid workspace");
      if (form.files.length === 0) throw new Error("invalid upload");
      const overwrite = form.fields.overwrite === "true";
      const visibility = loadFileVisibility(reposFile);
      const saved: RepoFileUpload[] = [];
      for (const file of form.files) {
        const filePath = repoUploadPath(form.fields.directory ?? "", file.filename);
        const result = (await call(user, {
          type: "upload_repo_file",
          workspace,
          path: filePath,
          contentBase64: file.data.toString("base64"),
          overwrite,
          visibility,
        })) as RepoFileUpload;
        saved.push(result);
      }
      sendJson(res, 201, { files: saved });
      return;
    }
    if (parts[1] === "repositories" && parts[2] === "file" && parts.length === 3 && req.method === "GET") {
      await assertFileManager(user);
      const workspace = (url.searchParams.get("workspace") || "").trim();
      if (!workspace) throw new Error("invalid workspace");
      const filePath = assertRepoRelativePath(url.searchParams.get("path") || "");
      const visibility = loadFileVisibility(reposFile);
      sendJson(res, 200, await call(user, { type: "read_repo_file", workspace, path: filePath, visibility }));
      return;
    }
    if (parts[1] === "repositories" && parts[2] === "file" && parts.length === 3 && req.method === "PUT") {
      await assertFileEditorAllowed(user);
      const body = (await readJson(req)) as { workspace?: unknown; path?: unknown; content?: unknown };
      const workspace = typeof body.workspace === "string" ? body.workspace.trim() : "";
      if (!workspace) throw new Error("invalid workspace");
      const filePath = assertRepoRelativePath(body.path);
      if (typeof body.content !== "string") throw new Error("invalid file content");
      const visibility = loadFileVisibility(reposFile);
      sendJson(res, 200, await call(user, {
        type: "write_repo_file",
        workspace,
        path: filePath,
        content: body.content,
        visibility,
      }));
      return;
    }
    if (parts[1] === "repositories" && parts[2] === "file" && parts.length === 3 && req.method === "POST") {
      await assertFileEditorAllowed(user);
      const body = (await readJson(req)) as { workspace?: unknown; path?: unknown; kind?: unknown; content?: unknown };
      const workspace = typeof body.workspace === "string" ? body.workspace.trim() : "";
      if (!workspace) throw new Error("invalid workspace");
      const filePath = assertRepoRelativePath(body.path);
      if (body.kind !== "file" && body.kind !== "dir") throw new Error("invalid entry kind");
      const content = typeof body.content === "string" ? body.content : undefined;
      const visibility = loadFileVisibility(reposFile);
      sendJson(res, 201, await call(user, {
        type: "create_repo_entry",
        workspace,
        path: filePath,
        kind: body.kind,
        ...(content !== undefined ? { content } : {}),
        visibility,
      }));
      return;
    }
    if (parts[1] === "repositories" && parts[2] === "file" && parts.length === 3 && req.method === "PATCH") {
      await assertFileEditorAllowed(user);
      const body = (await readJson(req)) as { workspace?: unknown; path?: unknown; newPath?: unknown };
      const workspace = typeof body.workspace === "string" ? body.workspace.trim() : "";
      if (!workspace) throw new Error("invalid workspace");
      const filePath = assertRepoRelativePath(body.path);
      const newPath = assertRepoRelativePath(body.newPath);
      const visibility = loadFileVisibility(reposFile);
      sendJson(res, 200, await call(user, {
        type: "rename_repo_entry",
        workspace,
        path: filePath,
        newPath,
        visibility,
      }));
      return;
    }
    if (parts[1] === "repositories" && parts[2] === "file" && parts.length === 3 && req.method === "DELETE") {
      await assertFileEditorAllowed(user);
      const workspace = (url.searchParams.get("workspace") || "").trim();
      if (!workspace) throw new Error("invalid workspace");
      const filePath = assertRepoRelativePath(url.searchParams.get("path") || "");
      const visibility = loadFileVisibility(reposFile);
      sendJson(res, 200, await call(user, {
        type: "delete_repo_entry",
        workspace,
        path: filePath,
        visibility,
      }));
      return;
    }
    if (parts[1] === "chats" && parts.length === 2 && req.method === "GET") {
      sendJson(res, 200, await call(user, { type: "list_chats" }));
      return;
    }
    if (parts[1] === "chats" && parts.length === 2 && req.method === "POST") {
      const body = (await readJson(req)) as Record<string, unknown>;
      let agent: AgentId;
      if (body.agent == null || body.agent === "") {
        const settings = (await call(user, { type: "get_settings" })) as Settings;
        agent = settings.defaultAgent;
      } else {
        if (!isAgentId(body.agent)) throw new Error("invalid agent");
        agent = body.agent;
      }
      await assertAgentAllowed(user, agent);
      const model = body.model == null || body.model === "" ? "" : cleanModel(body.model);
      await assertModelChoice(user, agent, model);
      const mode = body.mode == null || body.mode === "" ? "" : cleanMode(body.mode);
      await assertCreateMode(user, agent, mode);
      sendJson(
        res,
        201,
        await call(user, {
          type: "create_chat",
          agent,
          mode,
          model,
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
      const detail = (await call(user, { type: "get_chat", chatId: parts[2]! })) as { chat: ChatMeta };
      await assertAgentAllowed(user, detail.chat.agent);
      await alignStored(user, detail.chat, (request) => call(user, request));
      sendJson(res, 202, await call(user, { type: "send", chatId: parts[2]!, prompt: body.prompt }));
      return;
    }
    sendJson(res, 404, { error: "not found" });
  }

  async function handleWebSocket(req: IncomingMessage, ws: WebSocket) {
    const username = readSession(cookieValue(req.headers.cookie), options.sessionSecret);
    const user = username ? lookup(username) : null;
    if (!user || !userMayLogin(user)) {
      ws.close(4401, "sign in required");
      return;
    }
    const group = liveSockets.get(user.username) ?? new Set<WebSocket>();
    liveSockets.set(user.username, group);
    group.add(ws);
    const held = new Set<string>();
    const queued: Array<{ data: Buffer | ArrayBuffer | Buffer[]; isBinary: boolean }> = [];
    let channel: RunnerChannel | null = null;
    const deliver = (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (endedSockets.has(ws) || ws.readyState !== ws.OPEN) return;
      if (!channel) {
        queued.push({ data, isBinary });
        return;
      }
      void onClientMessage(user, channel, ws, data, isBinary, held).catch((error) => {
        const message = error instanceof Error ? error.message : "request failed";
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "error", error: message }));
      });
    };
    let closed = false;
    ws.on("message", (data, isBinary) => deliver(data, isBinary));
    ws.on("close", () => {
      closed = true;
      endedSockets.add(ws);
      group.delete(ws);
      if (group.size === 0) liveSockets.delete(user.username);
      if (!channel) return;
      for (const chatId of held) {
        void channel.request({ id: randomUUID(), type: "pty_detach", chatId }).catch(() => undefined);
      }
      channel.close();
    });
    channel = await RunnerChannel.open(options.link, user.username, user.uid, (message) => forward(ws, message));
    if (closed || ws.readyState !== ws.OPEN) {
      channel.close();
      return;
    }
    const early = queued.splice(0);
    for (const item of early) deliver(item.data, item.isBinary);
  }

  async function onClientMessage(
    user: LinuxUser,
    channel: RunnerChannel,
    ws: WebSocket,
    data: Buffer | ArrayBuffer | Buffer[],
    isBinary: boolean,
    held: Set<string>,
  ) {
    if (endedSockets.has(ws) || ws.readyState !== ws.OPEN) return;
    if (isBinary) {
      const frame = decodePtyFrame(rawBytes(data));
      if (!frame) return;
      await channel.request({
        id: randomUUID(),
        type: "pty_input",
        chatId: frame.chatId,
        data: Buffer.from(frame.data).toString("base64"),
      });
      return;
    }
    const command = parseClientCommand(JSON.parse(Buffer.from(rawBytes(data)).toString("utf8")));
    if (
      command.type === "get_policy" ||
      command.type === "put_policy" ||
      command.type === "get_env" ||
      command.type === "put_env" ||
      command.type === "get_access" ||
      command.type === "sync_repositories" ||
      command.type === "create_repository" ||
      command.type === "set_repositories" ||
      command.type === "probe_agent" ||
      command.type === "list_repo_files" ||
      command.type === "read_repo_file" ||
      command.type === "write_repo_file" ||
      command.type === "create_repo_entry" ||
      command.type === "rename_repo_entry" ||
      command.type === "delete_repo_entry" ||
      command.type === "download_repo_file" ||
      command.type === "upload_repo_file" ||
      command.type === "start_project_archive" ||
      command.type === "project_archive_status" ||
      command.type === "read_project_archive" ||
      command.type === "git_status" ||
      command.type === "git_init" ||
      command.type === "git_switch"
    ) {
      throw new Error("unknown request");
    }
    if (command.type === "prompt" || command.type === "send" || command.type === "pty_open" || command.type === "set_mode" || command.type === "set_model") {
      const detail = (await channel.request({ id: randomUUID(), type: "get_chat", chatId: command.chatId })) as { chat: ChatMeta };
      await assertAgentAllowed(user, detail.chat.agent);
      const access = await loadAccess(user);
      const choices = access.options[detail.chat.agent] ?? { modes: [], models: [] };
      if (command.type === "set_mode") assertModeChoice(choices, command.modeId);
      if (command.type === "set_model") {
        if (!choices.models.some((choice) => choice.id === command.modelId)) throw new Error("invalid model");
      }
      if (command.type === "prompt" || command.type === "send") {
        await alignStored(user, detail.chat, (request) => channel.request({ ...request, id: randomUUID() } as RunnerRequest));
      }
    }
    if (command.type === "pty_open" && !(await loadAccess(user)).rawTerminal) throw new Error("terminal is not enabled");
    if ((command.type === "list_sessions" || command.type === "import_session") && !loadCliImport(agentsFile)) {
      throw new Error("CLI import is not enabled");
    }
    if ((command.type === "list_sessions" || command.type === "import_session") && command.agent) {
      await assertAgentAllowed(user, command.agent);
    }
    if (command.type === "import_session" && !command.agent) await assertAgentAllowed(user, "cursor");
    const result = await channel.request({ ...command, id: randomUUID() });
    if (command.type === "pty_open") held.add(command.chatId);
    if (command.type === "pty_close" || command.type === "pty_detach") held.delete(command.chatId);
    if (ws.readyState !== ws.OPEN) return;
    if (command.type === "watch") {
      const snapshot = result as {
        chat: ChatMeta;
        modes?: { currentModeId: string; availableModes: Array<{ id: string; name: string; description?: string }> } | null;
        models?: { currentModelId: string; availableModels: Array<{ modelId: string; name: string }> } | null;
      };
      const access = await loadAccess(user);
      const choices = access.options[snapshot.chat.agent] ?? { modes: [], models: [] };
      snapshot.modes = filterModes(snapshot.modes, choices.modes, snapshot.chat.mode || "");
      snapshot.models = filterModels(snapshot.models, choices.models, snapshot.chat.model || "");
      ws.send(JSON.stringify({ type: "snapshot", chatId: command.chatId, ...snapshot }));
      // Alignment talks to the agent. The transcript is already on screen, and a
      // busy session must not hold the socket open waiting for that call.
      await alignStored(user, snapshot.chat, (request) => channel.request({ ...request, id: randomUUID() } as RunnerRequest)).catch(() => undefined);
      return;
    }
    if (command.type === "prompt" || command.type === "send") {
      const accepted = (result ?? {}) as { queued?: boolean };
      ws.send(JSON.stringify({ type: "accepted", chatId: command.chatId, queued: Boolean(accepted.queued) }));
      return;
    }
    if (command.type === "list_sessions") {
      ws.send(JSON.stringify({ type: "sessions", ...(result as object) }));
      return;
    }
    if (command.type === "import_session") {
      ws.send(JSON.stringify({ type: "imported", chat: result as ChatMeta }));
    }
    if (command.type === "pty_open") {
      ws.send(JSON.stringify({ type: "pty_open", chatId: command.chatId, ...(result as object) }));
    }
  }

  async function assertSettingsModel(user: LinuxUser, patch: SettingsPatch) {
    if (patch.defaultModel == null && !patch.defaultAgent) return;
    const current = (await call(user, { type: "get_settings" })) as Settings;
    const agent = patch.defaultAgent ?? current.defaultAgent;
    const model = patch.defaultModel != null ? patch.defaultModel : current.defaultModel;
    await assertModelChoice(user, agent, model);
  }

  async function agentState(user: LinuxUser) {
    const listed = await visibleAgents(user, true);
    return {
      agents: listed,
      rawTerminal: loadRawTerminal(agentsFile),
      cliImport: loadCliImport(agentsFile),
      fileManager: loadFileManager(agentsFile),
      fileEditor: loadFileEditor(agentsFile),
      fileDownload: loadFileDownload(agentsFile),
      fileUpload: loadFileUpload(agentsFile),
      ...piPayload(agentsFile),
    };
  }

  async function visibleAgents(user: LinuxUser, refresh = false) {
    const listed = await listAgents(agentsFile, commandDirs);
    const names = [...new Set(listed.filter((agent) => !agent.available).flatMap((agent) => detectionNames(agent)))];
    const resolved = await resolveCommands(user, names, refresh);
    return withResolvedCommands(listed, resolved);
  }

  async function resolveCommands(user: LinuxUser, names: string[], refresh = false): Promise<Map<string, string>> {
    if (names.length === 0) return new Map();
    try {
      const result = (await call(user, { type: "resolve_commands", names, refresh })) as {
        commands?: { name?: string; path?: string | null }[];
      };
      const found = new Map<string, string>();
      for (const item of result.commands ?? []) {
        if (item.name && item.path) found.set(item.name, item.path);
      }
      return found;
    } catch {
      return new Map();
    }
  }

  function syncAgentCatalog(user: LinuxUser) {
    return call(user, { type: "put_agent_catalog", agents: customCatalog(agentsFile) });
  }

  function call(user: LinuxUser, request: RunnerCall) {
    return callRunner(options.link, user.username, user.uid, { ...request, id: randomUUID() } as RunnerRequest);
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
  if (path.extname(file) === ".html") res.setHeader("Cache-Control", "no-store");
  createReadStream(file).pipe(res);
}

function forward(ws: WebSocket, message: PushMessage) {
  if (ws.readyState !== ws.OPEN) return;
  if (message.type === "pty") {
    ws.send(encodePtyFrame(message.chatId, Buffer.from(message.data, "base64")));
    return;
  }
  if (message.type === "chats_changed") {
    ws.send(JSON.stringify({ type: "chats_changed" }));
    return;
  }
  ws.send(JSON.stringify({ type: "event", chatId: message.chatId, seq: message.seq, at: message.at, event: message.event }));
}

function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function mutationOriginAllowed(req: IncomingMessage): boolean {
  if (req.headers.origin !== undefined) return originAllowed(req);
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site !== "same-origin" && site !== "none") return false;
  return true;
}

function clientAddress(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress || "";
  if (remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1") {
    const forwarded = req.headers["x-forwarded-for"];
    const raw = Array.isArray(forwarded) ? forwarded.at(-1) : forwarded;
    if (typeof raw === "string") {
      const last = raw.split(",").map((part) => part.trim()).filter(Boolean).at(-1);
      if (last) return last;
    }
  }
  return remote;
}

function fitChoice(current: string, choices: AgentOptionChoice[]): string {
  if (choices.length === 0) return current;
  if (choices.some((choice) => choice.id === current)) return current;
  return choices[0]!.id;
}

function filterModes(
  raw: { currentModeId: string; availableModes: Array<{ id: string; name: string; description?: string }> } | null | undefined,
  allowed: AgentOptionChoice[],
  selected: string,
) {
  // Opening a chat does not start ACP, so the runner has no catalog yet.
  // The saved offer is enough to show the dropdown until a live session exists.
  if (!raw) {
    if (allowed.length === 0) return raw ?? null;
    return {
      currentModeId: fitChoice(selected, allowed),
      availableModes: allowed.map((choice) => ({
        id: choice.id,
        name: choice.name,
        ...(choice.description ? { description: choice.description } : {}),
      })),
    };
  }
  const ids = new Set(allowed.map((choice) => choice.id));
  const availableModes = raw.availableModes.filter((mode) => ids.has(mode.id));
  const currentModeId = availableModes.some((mode) => mode.id === selected) ? selected : availableModes[0]?.id || "";
  return { currentModeId, availableModes };
}

function filterModels(
  raw: { currentModelId: string; availableModels: Array<{ modelId: string; name: string }> } | null | undefined,
  allowed: AgentOptionChoice[],
  selected: string,
) {
  if (!raw) {
    if (allowed.length === 0) return raw ?? null;
    return {
      currentModelId: fitChoice(selected, allowed),
      availableModels: allowed.map((choice) => ({ modelId: choice.id, name: choice.name })),
    };
  }
  const ids = new Set(allowed.map((choice) => choice.id));
  const availableModels = raw.availableModels.filter((model) => ids.has(model.modelId));
  const currentModelId = availableModels.some((model) => model.modelId === selected) ? selected : availableModels[0]?.modelId || "";
  return { currentModelId, availableModels };
}

function appNameFrom(body: unknown): string {
  if (!body || typeof body !== "object") throw new Error("invalid app name");
  const value = (body as { appName?: unknown }).appName;
  if (typeof value !== "string") throw new Error("invalid app name");
  return value;
}

function rawTerminalFrom(body: unknown): boolean | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as { rawTerminal?: unknown }).rawTerminal;
  return typeof value === "boolean" ? value : undefined;
}

function cliImportFrom(body: unknown): boolean | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as { cliImport?: unknown }).cliImport;
  return typeof value === "boolean" ? value : undefined;
}

function fileManagerFrom(body: unknown): boolean | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as { fileManager?: unknown }).fileManager;
  return typeof value === "boolean" ? value : undefined;
}

function fileEditorFrom(body: unknown): boolean | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as { fileEditor?: unknown }).fileEditor;
  return typeof value === "boolean" ? value : undefined;
}

function fileDownloadFrom(body: unknown): boolean | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as { fileDownload?: unknown }).fileDownload;
  return typeof value === "boolean" ? value : undefined;
}

function fileUploadFrom(body: unknown): boolean | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as { fileUpload?: unknown }).fileUpload;
  return typeof value === "boolean" ? value : undefined;
}

function contentDisposition(name: string): string {
  const base = name.split(/[/\\]/).pop()?.replace(/[\r\n]/g, "") || "download";
  const ascii = base.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_").trim() || "download";
  const encoded = encodeURIComponent(base).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, disposition: string) {
  if (res.headersSent) return;
  res.writeHead(status, {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": disposition,
    "Cache-Control": "no-store",
    "Content-Length": body.length,
  });
  res.end(body);
}

function rawBytes(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
  if (Buffer.isBuffer(data)) return new Uint8Array(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(Buffer.concat(data));
}

function piPayload(file: string) {
  const pi = loadPiConfig(file);
  return { piInstall: pi.install, piAuth: pi.auth, piProvider: pi.provider, piModel: pi.model };
}

function statusFor(message: string): number {
  if (message.includes("file already exists")) return 409;
  if (message.includes("not enabled") || message.includes("hidden by policy") || message.includes("cannot modify .git")) return 403;
  if (
    message.includes("invalid") ||
    message.includes("empty") ||
    message.includes("must") ||
    message.includes("taken") ||
    message.includes("does not report") ||
    message.includes("not a regular file") ||
    message.includes("too large") ||
    message.includes("cannot edit binary") ||
    message.includes("already exists") ||
    message.includes("built-in agent")
  ) return 400;
  if (message.includes("not found") || message.includes("does not exist") || message.includes("ENOENT")) return 404;
  if (message.includes("not ready")) return 409;
  if (message.includes("already running")) return 409;
  return 500;
}

const MAX_FAILURES = 4096;
const FAILURE_TTL_MS = 10 * 60 * 1000;

function pruneFailures(now: number) {
  for (const [k, v] of failures) {
    if (v.reset <= now) failures.delete(k);
  }
  while (failures.size >= MAX_FAILURES) {
    const oldest = failures.keys().next().value;
    if (oldest === undefined) break;
    failures.delete(oldest);
  }
}

function limited(key: string): boolean {
  const now = Date.now();
  const entry = failures.get(key);
  if (!entry) return false;
  if (entry.reset <= now) {
    failures.delete(key);
    return false;
  }
  return entry.count >= 8;
}

function noteFailure(key: string) {
  const now = Date.now();
  const entry = failures.get(key);
  if (!entry || entry.reset <= now) {
    if (failures.size >= MAX_FAILURES) pruneFailures(now);
    failures.set(key, { count: 1, reset: now + FAILURE_TTL_MS });
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
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}
