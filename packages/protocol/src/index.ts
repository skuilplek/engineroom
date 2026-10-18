export const AGENTS = ["cursor", "claude", "pi"] as const;

export type AgentId = (typeof AGENTS)[number];

export function agentLabel(agent: AgentId): string {
  if (agent === "cursor") return "agent";
  return agent;
}

export const USERNAME_RE = /^[a-zA-Z_][a-zA-Z0-9_-]{0,31}$/;

export const CHAT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PermissionPolicy = "ask" | "allow" | "edits";

export interface Settings {
  defaultAgent: AgentId;
  defaultModel: string;
  binaries: Partial<Record<AgentId, string>>;
  permission: PermissionPolicy;
  lockedBinaries?: AgentId[];
}

export interface SettingsPatch {
  defaultAgent?: AgentId;
  defaultModel?: string;
  binaries?: Partial<Record<AgentId, string | null>>;
  permission?: PermissionPolicy;
}

export interface ChatMeta {
  id: string;
  title: string;
  agent: AgentId;
  model: string;
  workspace: string;
  agentSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  running?: boolean;
  mode?: string;
  needsResync?: boolean;
}

export interface ToolContentText {
  type: "text";
  text: string;
}

export interface ToolContentDiff {
  type: "diff";
  path: string;
  oldText?: string;
  newText?: string;
}

export interface ToolContentTerminal {
  type: "terminal";
  terminalId: string;
}

export type ToolContent = ToolContentText | ToolContentDiff | ToolContentTerminal;

export interface PlanEntry {
  content: string;
  status: string;
  priority?: string;
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export type TranscriptEntry = (
  | { kind: "user"; text: string; at: string }
  | { kind: "text"; text: string; at: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      phase: "start" | "done" | "error";
      input?: string;
      output?: string;
      toolKind?: string;
      title?: string;
      content?: ToolContent[];
      at: string;
    }
  | { kind: "error"; text: string; at: string }
  | { kind: "status"; text: string; at: string }
  | { kind: "thinking"; text: string; at: string }
  | { kind: "plan"; entries: PlanEntry[]; at: string }
) & { seq?: number };

export interface ChatDetail {
  chat: ChatMeta;
  transcript: TranscriptEntry[];
}

export interface WorkspaceEntry {
  path: string;
  name: string;
}

export interface RepositoryEntry {
  path: string;
  name: string;
  enabled: boolean;
}

export interface CatalogEntry {
  id: string;
  name: string;
  url: string;
}

export interface AgentOptionChoice {
  id: string;
  name: string;
  description?: string;
}

export interface AgentOptionList {
  modes: string[];
  models: string[];
}

export interface UserPolicy {
  agents: AgentId[];
  binaries: Partial<Record<AgentId, string>>;
  rawTerminal: boolean;
  /** Omitted means the person inherits the machine offer. */
  options?: Partial<Record<AgentId, AgentOptionList>>;
}

export interface EnvEntry {
  key: string;
  value: string;
}

export interface UserAccess {
  policy: UserPolicy;
  settings: Settings;
  grants: string[];
  env: EnvEntry[];
}

export const CATALOG_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export type StreamEvent =
  | { type: "user_message"; text: string }
  | { type: "text_delta"; text: string; messageId?: string }
  | {
      type: "tool";
      id: string;
      name: string;
      phase: "start" | "done" | "error";
      input?: string;
      output?: string;
      toolKind?: string;
      title?: string;
      status?: string;
      locations?: string[];
      content?: ToolContent[];
    }
  | { type: "terminal_output"; terminalId: string; data: string }
  | { type: "plan"; entries: PlanEntry[] }
  | { type: "permission_request"; requestId: string; toolCallId?: string; title?: string; options: PermissionOption[] }
  | { type: "permission_resolved"; requestId: string; optionId: string }
  | { type: "turn_start" }
  | { type: "turn_end"; stopReason?: string }
  | { type: "queued"; text: string }
  | { type: "mode"; modeId: string }
  | { type: "title"; text: string }
  | { type: "status"; text: string }
  | { type: "thinking"; text: string }
  | { type: "error"; text: string }
  | { type: "done"; agentSessionId?: string | null };

export interface ChatEvent {
  chatId: string;
  seq: number;
  at: string;
  event: StreamEvent;
}

export interface AgentMode {
  id: string;
  name: string;
  description?: string;
}

export interface AgentModel {
  modelId: string;
  name: string;
}

export interface ListedSession {
  sessionId: string;
  cwd?: string;
  updatedAt?: string;
  title?: string;
}

export type RunnerRequest =
  | { id: string; type: "list_chats" }
  | { id: string; type: "get_chat"; chatId: string }
  | {
      id: string;
      type: "create_chat";
      agent?: AgentId;
      model?: string;
      workspace?: string;
      title?: string;
    }
  | { id: string; type: "get_settings" }
  | { id: string; type: "put_settings"; settings: SettingsPatch }
  | { id: string; type: "list_workspaces" }
  | { id: string; type: "list_repositories" }
  | { id: string; type: "set_repositories"; enabled: string[] }
  | { id: string; type: "get_policy" }
  | { id: string; type: "put_policy"; policy: UserPolicy }
  | { id: string; type: "get_env" }
  | { id: string; type: "put_env"; entries: EnvEntry[] }
  | { id: string; type: "get_access" }
  | { id: string; type: "sync_repositories"; repos: CatalogEntry[]; catalog: string[]; directory: string }
  | { id: string; type: "detect_repositories"; directory: string }
  | { id: string; type: "send"; chatId: string; prompt: string }
  | { id: string; type: "prompt"; chatId: string; prompt: string }
  | { id: string; type: "cancel"; chatId: string }
  | { id: string; type: "subscribe" }
  | { id: string; type: "watch"; chatId: string; lastSeq: number }
  | { id: string; type: "unwatch"; chatId: string }
  | { id: string; type: "permission_response"; chatId: string; requestId: string; optionId: string }
  | { id: string; type: "set_mode"; chatId: string; modeId: string }
  | { id: string; type: "set_model"; chatId: string; modelId: string }
  | { id: string; type: "pty_open"; chatId: string; cols: number; rows: number }
  | { id: string; type: "pty_input"; chatId: string; data: string }
  | { id: string; type: "pty_resize"; chatId: string; cols: number; rows: number }
  | { id: string; type: "pty_close"; chatId: string }
  | { id: string; type: "pty_detach"; chatId: string }
  | { id: string; type: "list_sessions"; agent?: AgentId }
  | { id: string; type: "import_session"; agent?: AgentId; agentSessionId: string; workspace?: string }
  | { id: string; type: "probe_agent"; agent: AgentId };

export type RunnerResponse =
  | { id: string; type: "event"; event: StreamEvent }
  | { id: string; type: "ok"; result: unknown }
  | { id: string; type: "error"; error: string };

export const DEFAULT_SETTINGS: Settings = {
  defaultAgent: "cursor",
  defaultModel: "",
  binaries: {},
  permission: "ask",
};

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && (AGENTS as readonly string[]).includes(value);
}

export function assertUsername(value: string): string {
  if (!USERNAME_RE.test(value)) throw new Error("invalid username");
  return value;
}

export function assertChatId(value: unknown): string {
  if (typeof value !== "string" || !CHAT_ID_RE.test(value)) {
    throw new Error("invalid chat id");
  }
  return value;
}

export function cleanModel(value: unknown): string {
  if (value == null || value === "") return "";
  if (typeof value !== "string") throw new Error("model must be a string");
  const model = value.trim();
  if (model.length > 200) throw new Error("model is too long");
  if (/[\r\n\0]/.test(model)) throw new Error("model is invalid");
  return model;
}

export function cleanTitle(value: unknown): string {
  if (typeof value !== "string") return "";
  const title = value.replace(/\s+/g, " ").trim();
  return title.length > 120 ? title.slice(0, 120) : title;
}

export function titleFromPrompt(prompt: string): string {
  const line = prompt.replace(/\s+/g, " ").trim();
  if (!line) return "New chat";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

export function loginAllowed(
  user: { uid: number; shell: string; groups: string[] },
  group = "engineroom-users",
): boolean {
  // 500 covers macOS accounts (501+) and older Linux login.defs. The group is the real gate.
  if (!Number.isInteger(user.uid) || user.uid < 500) return false;
  const base = user.shell.split("/").pop() || "";
  if (base === "nologin" || base === "false" || base === "sync") return false;
  return user.groups.includes(group);
}

export function isInsidePath(root: string, target: string): boolean {
  const rel = relativePosix(root, target);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

function relativePosix(root: string, target: string): string {
  const from = root.endsWith("/") ? root.slice(0, -1) : root;
  const to = target.endsWith("/") ? target.slice(0, -1) : target;
  if (from === to) return "";
  if (to.startsWith(`${from}/`)) return to.slice(from.length + 1);
  return `../${to}`;
}

export function socketPathForUser(dir: string, username: string): string {
  assertUsername(username);
  const root = stripSlash(dir);
  if (!root.startsWith("/")) throw new Error("socket directory must be absolute");
  return `${root}/${username}.sock`;
}

function stripSlash(dir: string): string {
  return dir.length > 1 && dir.endsWith("/") ? dir.slice(0, -1) : dir;
}

export function parseRunnerRequest(value: unknown): RunnerRequest {
  if (!value || typeof value !== "object") throw new Error("invalid request");
  const body = value as Record<string, unknown>;
  if (typeof body.id !== "string" || body.id.length < 1 || body.id.length > 80) {
    throw new Error("invalid request id");
  }
  switch (body.type) {
    case "list_chats":
    case "get_settings":
    case "list_workspaces":
    case "list_repositories":
      return { id: body.id, type: body.type };
    case "set_repositories":
      return { id: body.id, type: "set_repositories", enabled: parseEnabledPaths(body.enabled) };
    case "get_policy":
    case "get_env":
    case "get_access":
      return { id: body.id, type: body.type };
    case "put_policy":
      return { id: body.id, type: "put_policy", policy: parseUserPolicy(body.policy) };
    case "put_env":
      return { id: body.id, type: "put_env", entries: parseEnvEntries(body.entries) };
    case "sync_repositories":
      return {
        id: body.id,
        type: "sync_repositories",
        repos: parseCatalogEntries(body.repos),
        catalog: body.catalog == null ? [] : parseCatalogNames(body.catalog),
        directory: body.directory == null || body.directory === "" ? "Sites" : assertRepoDirectory(body.directory),
      };
    case "detect_repositories":
      return { id: body.id, type: "detect_repositories", directory: assertRepoDirectory(body.directory) };
    case "get_chat":
    case "cancel":
      return { id: body.id, type: body.type, chatId: assertChatId(body.chatId) };
    case "create_chat": {
      const agent = body.agent == null ? undefined : body.agent;
      if (agent != null && !isAgentId(agent)) throw new Error("invalid agent");
      return {
        id: body.id,
        type: "create_chat",
        agent,
        model: body.model == null ? undefined : cleanModel(body.model),
        workspace: optionalString(body.workspace, "workspace", 4096),
        title: body.title == null ? undefined : cleanTitle(body.title),
      };
    }
    case "put_settings":
      return { id: body.id, type: "put_settings", settings: parseSettingsPatch(body.settings) };
    case "send":
    case "prompt": {
      const prompt = optionalString(body.prompt, "prompt", 100_000);
      if (!prompt?.trim()) throw new Error("prompt is empty");
      return { id: body.id, type: body.type, chatId: assertChatId(body.chatId), prompt };
    }
    case "subscribe":
      return { id: body.id, type: "subscribe" };
    case "watch":
      return { id: body.id, type: "watch", chatId: assertChatId(body.chatId), lastSeq: parseSeq(body.lastSeq) };
    case "unwatch":
    case "pty_close":
    case "pty_detach":
      return { id: body.id, type: body.type, chatId: assertChatId(body.chatId) };
    case "permission_response":
      return {
        id: body.id,
        type: "permission_response",
        chatId: assertChatId(body.chatId),
        requestId: token(body.requestId, "request"),
        optionId: token(body.optionId, "option"),
      };
    case "set_mode":
      return { id: body.id, type: "set_mode", chatId: assertChatId(body.chatId), modeId: body.modeId === "" ? "" : token(body.modeId, "mode") };
    case "probe_agent":
      if (!isAgentId(body.agent)) throw new Error("invalid agent");
      return { id: body.id, type: "probe_agent", agent: body.agent };
    case "set_model":
      return { id: body.id, type: "set_model", chatId: assertChatId(body.chatId), modelId: cleanModel(body.modelId) };
    case "pty_open":
    case "pty_resize":
      return { id: body.id, type: body.type, chatId: assertChatId(body.chatId), cols: parseDim(body.cols), rows: parseDim(body.rows) };
    case "pty_input":
      return { id: body.id, type: "pty_input", chatId: assertChatId(body.chatId), data: parseBase64(body.data) };
    case "list_sessions": {
      const agent = body.agent == null || body.agent === "" ? undefined : body.agent;
      if (agent != null && !isAgentId(agent)) throw new Error("invalid agent");
      return { id: body.id, type: "list_sessions", agent };
    }
    case "import_session": {
      const agent = body.agent == null || body.agent === "" ? undefined : body.agent;
      if (agent != null && !isAgentId(agent)) throw new Error("invalid agent");
      return {
        id: body.id,
        type: "import_session",
        agent,
        agentSessionId: token(body.agentSessionId, "session"),
        workspace: optionalString(body.workspace, "workspace", 4096),
      };
    }
    default:
      throw new Error("unknown request");
  }
}

function parseSeq(value: unknown): number {
  const seq = typeof value === "number" ? value : 0;
  if (!Number.isInteger(seq) || seq < 0 || seq > 1_000_000_000_000) throw new Error("invalid sequence");
  return seq;
}

function parseDim(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 500) {
    throw new Error("invalid terminal size");
  }
  return value;
}

function token(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(value)) throw new Error(`invalid ${label}`);
  return value;
}

function parseBase64(value: unknown): string {
  if (typeof value !== "string" || value.length > 200_000 || !/^[A-Za-z0-9+/=\r\n]*$/.test(value)) {
    throw new Error("invalid terminal input");
  }
  return value;
}

export function parseClientCommand(value: unknown): Exclude<RunnerRequest, { type: "subscribe" }> {
  const request = parseRunnerRequest({ ...(value as Record<string, unknown>), id: "1" });
  if (request.type === "subscribe") throw new Error("unknown request");
  return request;
}

export function maxSeq(entries: Array<{ seq?: number }>): number {
  let max = 0;
  for (const entry of entries) {
    if (typeof entry.seq === "number" && entry.seq > max) max = entry.seq;
  }
  return max;
}

const PTY_ID_BYTES = 36;

export function encodePtyFrame(chatId: string, data: Uint8Array): Uint8Array {
  assertChatId(chatId);
  const frame = new Uint8Array(1 + PTY_ID_BYTES + data.length);
  frame[0] = 1;
  frame.set(new TextEncoder().encode(chatId), 1);
  frame.set(data, 1 + PTY_ID_BYTES);
  return frame;
}

export function decodePtyFrame(frame: Uint8Array): { chatId: string; data: Uint8Array } | null {
  if (frame.length < 1 + PTY_ID_BYTES || frame[0] !== 1) return null;
  const chatId = new TextDecoder().decode(frame.subarray(1, 1 + PTY_ID_BYTES));
  if (!CHAT_ID_RE.test(chatId)) return null;
  return { chatId, data: frame.subarray(1 + PTY_ID_BYTES) };
}

export function assertCatalogName(value: unknown): string {
  if (typeof value !== "string" || !CATALOG_NAME_RE.test(value)) throw new Error("invalid repository name");
  return value;
}

export function assertCatalogId(value: unknown): string {
  if (typeof value !== "string" || !CHAT_ID_RE.test(value)) throw new Error("invalid repository");
  return value;
}

export function assertGitUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid repository url");
  const url = value.trim();
  if (url.length < 8 || url.length > 2000) throw new Error("invalid repository url");
  if (/[\s\0]/.test(url) || url.includes("..") || /ext::/i.test(url) || url.startsWith("-")) {
    throw new Error("invalid repository url");
  }
  if (/^https:\/\//i.test(url)) return assertRemoteUrl(url, "https:");
  if (/^ssh:\/\//i.test(url)) return assertRemoteUrl(url, "ssh:");
  if (/^git@[A-Za-z0-9][A-Za-z0-9.-]*:[A-Za-z0-9][A-Za-z0-9._~/-]*$/.test(url)) return url;
  throw new Error("invalid repository url");
}

function assertRemoteUrl(value: string, protocol: "https:" | "ssh:"): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("invalid repository url");
  }
  if (parsed.protocol !== protocol || !parsed.hostname) throw new Error("invalid repository url");
  if (parsed.password || (protocol === "https:" && parsed.username)) throw new Error("invalid repository url");
  return value;
}

export function assertRepoDirectory(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid repository folder");
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200 || trimmed.startsWith("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new Error("invalid repository folder");
  }
  const parts = trimmed.split("/").filter((part) => part.length > 0);
  if (parts.length === 0 || parts.length > 8) throw new Error("invalid repository folder");
  for (const part of parts) {
    if (
      part === "."
      || part === ".."
      || part.startsWith(".")
      || part === "node_modules"
      || part === "vendor"
      || part === "dist"
      || part === "build"
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(part)
    ) {
      throw new Error("invalid repository folder");
    }
  }
  return parts.join("/");
}

export function parseCatalogNames(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error("invalid repositories");
  const names: string[] = [];
  for (const item of value) {
    const name = assertCatalogName(item);
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

export function parseCatalogEntries(value: unknown): CatalogEntry[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error("invalid repositories");
  const entries: CatalogEntry[] = [];
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") throw new Error("invalid repositories");
    const record = item as Record<string, unknown>;
    const id = assertCatalogId(record.id);
    const name = assertCatalogName(record.name);
    const url = assertGitUrl(record.url);
    if (ids.has(id) || names.has(name)) throw new Error("invalid repositories");
    ids.add(id);
    names.add(name);
    entries.push({ id, name, url });
  }
  return entries;
}

export function parsePolicyBinaries(value: unknown): Partial<Record<AgentId, string>> {
  if (value == null) return {};
  if (typeof value !== "object") throw new Error("invalid binaries");
  const binaries: Partial<Record<AgentId, string>> = {};
  for (const agent of AGENTS) {
    const raw = (value as Record<string, unknown>)[agent];
    if (raw == null || raw === "") continue;
    if (typeof raw !== "string" || !raw.startsWith("/") || raw.length > 4096 || raw.includes("\0") || raw.includes("\n")) {
      throw new Error(`${agent} binary must be an absolute path`);
    }
    binaries[agent] = raw;
  }
  return binaries;
}

export function parseUserPolicy(value: unknown): UserPolicy {
  if (!value || typeof value !== "object") throw new Error("invalid policy");
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.agents) || body.agents.length === 0 || body.agents.length > AGENTS.length) {
    throw new Error("at least one agent must stay on");
  }
  const agents: AgentId[] = [];
  for (const agent of body.agents) {
    if (!isAgentId(agent) || agents.includes(agent)) throw new Error("invalid agent");
    agents.push(agent);
  }
  if (typeof body.rawTerminal !== "boolean") throw new Error("invalid terminal");
  const options = parsePolicyOptions(body.options);
  return { agents, binaries: parsePolicyBinaries(body.binaries), rawTerminal: body.rawTerminal, ...(options ? { options } : {}) };
}

export function parseOptionIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error(`invalid ${label}`);
  const ids: string[] = [];
  for (const item of value) {
    const id = cleanModel(item);
    if (!id) throw new Error(`invalid ${label}`);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function parsePolicyOptions(value: unknown): UserPolicy["options"] {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("invalid options");
  const options: NonNullable<UserPolicy["options"]> = {};
  let seen = false;
  for (const agent of AGENTS) {
    const raw = (value as Record<string, unknown>)[agent];
    if (raw == null) continue;
    if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid options");
    const record = raw as Record<string, unknown>;
    options[agent] = {
      modes: parseOptionIds(record.modes, "mode"),
      models: parseOptionIds(record.models, "model"),
    };
    seen = true;
  }
  return seen ? options : undefined;
}

export function effectiveAgentOptions(
  discovered: { modes: AgentOptionChoice[]; models: AgentOptionChoice[] } | undefined,
  offered: AgentOptionList | undefined,
  personal: AgentOptionList | undefined,
): { modes: AgentOptionChoice[]; models: AgentOptionChoice[] } {
  return {
    modes: offeredChoices(discovered?.modes ?? [], offered?.modes ?? [], personal?.modes),
    models: offeredChoices(discovered?.models ?? [], offered?.models ?? [], personal?.models),
  };
}

function offeredChoices(available: AgentOptionChoice[], offeredIds: string[], personalIds: string[] | undefined): AgentOptionChoice[] {
  const offered = new Set(offeredIds);
  const personal = personalIds ? new Set(personalIds) : null;
  const seen = new Set<string>();
  const choices: AgentOptionChoice[] = [];
  for (const choice of available) {
    if (!offered.has(choice.id) || seen.has(choice.id)) continue;
    if (personal && !personal.has(choice.id)) continue;
    seen.add(choice.id);
    choices.push(choice);
  }
  return choices;
}

export function defaultPolicy(): UserPolicy {
  return { agents: [...AGENTS], binaries: {}, rawTerminal: true };
}

export function parseEnvEntries(value: unknown): EnvEntry[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error("invalid environment");
  const entries: EnvEntry[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") throw new Error("invalid environment");
    const record = item as Record<string, unknown>;
    if (typeof record.key !== "string" || !ENV_KEY_RE.test(record.key)) throw new Error("invalid environment");
    if (typeof record.value !== "string" || record.value.length > 8192 || /[\r\n\0]/.test(record.value)) {
      throw new Error("invalid environment");
    }
    if (seen.has(record.key)) throw new Error("invalid environment");
    seen.add(record.key);
    entries.push({ key: record.key, value: record.value });
  }
  return entries;
}

function parseEnabledPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error("invalid repositories");
  const enabled: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length < 1 || item.length > 4096) {
      throw new Error("invalid repositories");
    }
    enabled.push(item);
  }
  return enabled;
}

function optionalString(value: unknown, label: string, max: number): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (value.length > max) throw new Error(`${label} is too long`);
  return value;
}

export function parseSettingsPatch(value: unknown): SettingsPatch {
  if (!value || typeof value !== "object") throw new Error("invalid settings");
  const body = value as Record<string, unknown>;
  const patch: SettingsPatch = {};
  if (body.defaultAgent != null) {
    if (!isAgentId(body.defaultAgent)) throw new Error("invalid agent");
    patch.defaultAgent = body.defaultAgent;
  }
  if (body.defaultModel != null) patch.defaultModel = cleanModel(body.defaultModel);
  if (body.permission != null) {
    if (body.permission !== "ask" && body.permission !== "allow" && body.permission !== "edits") {
      throw new Error("invalid permission");
    }
    patch.permission = body.permission;
  }
  if (body.binaries != null) {
    if (typeof body.binaries !== "object") throw new Error("invalid binaries");
    const binaries: SettingsPatch["binaries"] = {};
    for (const agent of AGENTS) {
      const raw = (body.binaries as Record<string, unknown>)[agent];
      if (raw == null || raw === "") {
        binaries[agent] = null;
        continue;
      }
      if (typeof raw !== "string" || !raw.startsWith("/") || raw.length > 4096) {
        throw new Error(`${agent} binary must be an absolute path`);
      }
      if (raw.includes("\0") || raw.includes("\n")) throw new Error("invalid binary path");
      binaries[agent] = raw;
    }
    patch.binaries = binaries;
  }
  return patch;
}

export function applySettings(current: Settings, patch: SettingsPatch): Settings {
  const next: Settings = {
    defaultAgent: patch.defaultAgent ?? current.defaultAgent,
    defaultModel: patch.defaultModel ?? current.defaultModel,
    binaries: { ...current.binaries },
    permission: patch.permission ?? current.permission ?? "ask",
  };
  if (patch.binaries) {
    for (const agent of AGENTS) {
      if (!(agent in patch.binaries)) continue;
      const value = patch.binaries[agent];
      if (value == null || value === "") delete next.binaries[agent];
      else next.binaries[agent] = value;
    }
  }
  return next;
}

export function clip(text: string, max = 4000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…`;
}

export { createCliParser, summarizeInput, type CliParser } from "./normalize.ts";
