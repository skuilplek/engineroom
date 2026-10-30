import { isExtensionSlug, parseExtensionSource, parseSlugList } from "./extensions.ts";

export const AGENTS = ["cursor", "claude", "pi"] as const;

export type BuiltinAgentId = (typeof AGENTS)[number];

/** Builtin ids plus custom slugs stored by the hub. */
export type AgentId = string;

export interface AgentName {
  id: string;
  label: string;
}

export interface AgentDefinition extends AgentName {
  binary: string;
}

export const AGENT_CATALOG: readonly AgentDefinition[] = [
  { id: "cursor", label: "Cursor", binary: "agent" },
  { id: "claude", label: "Claude", binary: "claude" },
  { id: "pi", label: "Pi", binary: "pi" },
];

export const AGENT_SLUG_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const AGENT_COMMAND_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
export const MAX_AGENTS = 40;

export function agentLabel(agent: string, names?: readonly AgentName[]): string {
  const named = names?.find((item) => item.id === agent)?.label;
  if (named) return named;
  return AGENT_CATALOG.find((item) => item.id === agent)?.label ?? agent;
}

export function agentBinary(agent: string): string {
  return AGENT_CATALOG.find((item) => item.id === agent)?.binary ?? agent;
}

export function isBuiltinAgent(value: unknown): value is BuiltinAgentId {
  return typeof value === "string" && (AGENTS as readonly string[]).includes(value);
}

export const USERNAME_RE = /^[a-zA-Z_][a-zA-Z0-9_-]{0,31}$/;

export const CHAT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PermissionPolicy = "ask" | "allow" | "edits";

export const THEMES = ["dark", "light", "haxor", "midnight", "engine", "pi"] as const;

export type BuiltinTheme = (typeof THEMES)[number];

/** A built-in theme id, or a theme id contributed by an enabled package. */
export type ThemePreference = string;

export function isTheme(value: unknown): value is BuiltinTheme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

export function isThemeId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(value);
}

/** Built-in themes stay. A package theme is kept only while that package is enabled. */
export function resolveTheme(value: unknown, installed: readonly string[] = []): string {
  if (isTheme(value)) return value;
  if (isThemeId(value) && installed.includes(value)) return value;
  return "dark";
}

export const COMMAND_BLOCK_STYLES = ["prompt", "window"] as const;

export type CommandBlockStyle = (typeof COMMAND_BLOCK_STYLES)[number];

export function isCommandBlockStyle(value: unknown): value is CommandBlockStyle {
  return typeof value === "string" && (COMMAND_BLOCK_STYLES as readonly string[]).includes(value);
}

export interface Settings {
  defaultAgent: AgentId;
  defaultModel: string;
  binaries: Partial<Record<AgentId, string>>;
  permission: PermissionPolicy;
  theme: ThemePreference;
  commandBlockStyle: CommandBlockStyle;
  filesReadOnly?: boolean;
  wrapText: boolean;
  visibleChats: number;
  /** Server binaries the person cannot change. Filled in when settings are read. */
  lockedBinaries?: AgentId[];
  /** Agents whose binary path the person may set. Filled in when settings are read. */
  binaryOverride?: AgentId[];
}

export interface SettingsPatch {
  defaultAgent?: AgentId;
  defaultModel?: string;
  binaries?: Partial<Record<AgentId, string | null>>;
  permission?: PermissionPolicy;
  theme?: ThemePreference;
  commandBlockStyle?: CommandBlockStyle;
  filesReadOnly?: boolean;
  wrapText?: boolean;
  visibleChats?: number;
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
  | { kind: "user"; text: string; at: string; attachments?: PromptAttachment[] }
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

export interface ActionError {
  id: string;
  at: string;
  action: string;
  message: string;
}

export interface WorkspaceEntry {
  path: string;
  name: string;
}

export interface RepositoryEntry {
  path: string;
  name: string;
  enabled: boolean;
  archived: boolean;
}

export interface FileVisibility {
  showHidden: boolean;
  showGitignored: boolean;
  showGitDir: boolean;
}

export const DEFAULT_FILE_VISIBILITY: FileVisibility = {
  showHidden: false,
  showGitignored: false,
  showGitDir: false,
};

export interface RepoFileEntry {
  path: string;
  name: string;
  kind: "file" | "dir";
  size?: number;
}

export type RepoChangeStatus = "M" | "A" | "D" | "R" | "U" | "?";

export interface RepoChangeEntry {
  path: string;
  status: RepoChangeStatus;
  staged: boolean;
  unstaged: boolean;
  /** Index letter when the file is staged. */
  indexStatus?: RepoChangeStatus;
  /** Worktree letter when the file has unstaged changes. Untracked files use "?". */
  worktreeStatus?: RepoChangeStatus;
}

export interface RepoFilesResult {
  workspace: string;
  branch: string;
  files: RepoFileEntry[];
  changes: RepoChangeEntry[];
}

export interface GitStatus {
  repo: boolean;
  branch: string;
  branches: string[];
  /** `origin` URL, or empty when the repository has no origin. */
  remote: string;
}

/** Global `user.name` and `user.email` for the signed-in account. */
export interface GitIdentity {
  name: string;
  email: string;
}

export interface RepoFileContent {
  path: string;
  content: string;
  oldContent?: string;
  binary: boolean;
  truncated: boolean;
  size: number;
}

export interface RepoSearchOptions {
  query: string;
  caseSensitive?: boolean;
  regex?: boolean;
  wholeWord?: boolean;
  maxResults?: number;
}

export interface RepoSearchMatch {
  path: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  column: number;
  /** Line text, shortened around the match when needed. */
  text: string;
  /** The matched text, shortened when the match is very long. */
  matchText: string;
  /** Offset of the match inside `text`. */
  matchStart: number;
}

export interface RepoSearchResult {
  query: string;
  matches: RepoSearchMatch[];
  truncated: boolean;
  filesSearched: number;
  filesSkipped: number;
}

/** Largest file the file manager will download or upload. */
export const MAX_TRANSFER_BYTES = 32 * 1024 * 1024;

/** Files pasted or picked in the prompt box. */
export const MAX_PROMPT_ATTACHMENTS = 8;
export const MAX_PROMPT_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ACTION_ERRORS = 200;
export const MAX_ACTION_ERROR_CHARS = 8_000;
export const PROMPT_UPLOAD_DIR = ".engineroom/uploads";
export const ATTACHED_PROMPT = "Attached files.";

export interface PromptAttachment {
  name: string;
  path: string;
  mimeType: string;
  size: number;
}

export interface QueuedPrompt {
  text: string;
  attachments: PromptAttachment[];
}

export interface RepoFileDownload {
  path: string;
  name: string;
  contentBase64: string;
  size: number;
}

export interface RepoFileUpload {
  path: string;
  size: number;
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
  fileManager: boolean;
  fileEditor?: boolean;
  fileDownload: boolean;
  fileUpload: boolean;
  projectCreate: boolean;
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
  | { type: "user_message"; text: string; attachments?: PromptAttachment[] }
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
  | { type: "queued"; text: string; attachments?: PromptAttachment[] }
  | { type: "dequeued"; index: number }
  | { type: "queue"; items: QueuedPrompt[] }
  | { type: "mode"; modeId: string }
  | { type: "model"; modelId: string }
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
      mode?: string;
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
  | { id: string; type: "create_repository"; name: string; directory: string; url?: string }
  | { id: string; type: "set_repository_archived"; workspace: string; archived: boolean }
  | { id: string; type: "delete_repository"; workspace: string; name: string }
  | { id: string; type: "send"; chatId: string; prompt: string; attachments?: PromptAttachment[] }
  | { id: string; type: "prompt"; chatId: string; prompt: string; attachments?: PromptAttachment[] }
  | { id: string; type: "cancel"; chatId: string }
  | { id: string; type: "subscribe" }
  | { id: string; type: "watch"; chatId: string; lastSeq: number }
  | { id: string; type: "unwatch"; chatId: string }
  | { id: string; type: "permission_response"; chatId: string; requestId: string; optionId: string }
  | { id: string; type: "set_mode"; chatId: string; modeId: string }
  | { id: string; type: "set_model"; chatId: string; modelId: string }
  | { id: string; type: "dequeue"; chatId: string; index: number }
  | { id: string; type: "git_status"; workspace: string }
  | { id: string; type: "git_init"; workspace: string }
  | { id: string; type: "git_switch"; workspace: string; branch: string }
  | { id: string; type: "git_remote_set"; workspace: string; url: string }
  | { id: string; type: "git_branch_create"; workspace: string; branch: string }
  | { id: string; type: "git_pull"; workspace: string }
  | { id: string; type: "git_push"; workspace: string }
  | { id: string; type: "git_stage"; workspace: string; path: string; visibility?: FileVisibility }
  | { id: string; type: "git_unstage"; workspace: string; path: string; visibility?: FileVisibility }
  | { id: string; type: "git_discard"; workspace: string; path: string; visibility?: FileVisibility }
  | {
      id: string;
      type: "git_commit";
      workspace: string;
      message: string;
      stageVisible?: boolean;
      visibility?: FileVisibility;
    }
  | { id: string; type: "git_identity_get" }
  | { id: string; type: "git_identity_set"; name: string; email: string }
  | { id: string; type: "list_errors" }
  | { id: string; type: "append_error"; action: string; message: string }
  | { id: string; type: "delete_error"; errorId: string }
  | { id: string; type: "clear_errors" }
  | { id: string; type: "pty_open"; chatId: string; cols: number; rows: number }
  | { id: string; type: "pty_input"; chatId: string; data: string }
  | { id: string; type: "pty_resize"; chatId: string; cols: number; rows: number }
  | { id: string; type: "pty_close"; chatId: string }
  | { id: string; type: "pty_detach"; chatId: string }
  | { id: string; type: "list_sessions"; agent?: AgentId }
  | { id: string; type: "import_session"; agent?: AgentId; agentSessionId: string; workspace?: string }
  | { id: string; type: "probe_agent"; agent: AgentId }
  | { id: string; type: "resolve_commands"; names: string[]; refresh?: boolean }
  | { id: string; type: "setup_pi"; provider: string; model: string }
  | { id: string; type: "apply_harness_defaults"; agent: "pi"; provider: string; model: string }
  | { id: string; type: "apply_harness_defaults"; agent: "cursor"; writeModel: boolean; commands: string[]; fast: boolean }
  | { id: string; type: "get_cursor_commands" }
  | { id: string; type: "put_cursor_commands"; commands: string[] }
  | { id: string; type: "put_agent_catalog"; agents: AgentDefinition[] }
  | { id: string; type: "list_extensions" }
  | { id: string; type: "install_extension"; source: string }
  | { id: string; type: "update_extension"; name: string }
  | { id: string; type: "remove_extension"; name: string }
  | {
      id: string;
      type: "set_extension_enabled";
      name: string;
      enabled: boolean;
      reservedThemes?: string[];
      reservedDocs?: string[];
      reservedAgents?: string[];
    }
  | { id: string; type: "read_extension_theme"; themeId: string }
  | { id: string; type: "read_extension_doc"; name: string; docId: string }
  | { id: string; type: "list_repo_files"; workspace: string; visibility?: FileVisibility }
  | ({
      id: string;
      type: "search_repo_files";
      workspace: string;
      visibility?: FileVisibility;
    } & RepoSearchOptions)
  | { id: string; type: "read_repo_file"; workspace: string; path: string; visibility?: FileVisibility }
  | { id: string; type: "read_home_file"; path: string }
  | { id: string; type: "write_repo_file"; workspace: string; path: string; content: string; visibility?: FileVisibility }
  | { id: string; type: "create_repo_entry"; workspace: string; path: string; kind: "file" | "dir"; content?: string; visibility?: FileVisibility }
  | { id: string; type: "rename_repo_entry"; workspace: string; path: string; newPath: string; visibility?: FileVisibility }
  | { id: string; type: "delete_repo_entry"; workspace: string; path: string; visibility?: FileVisibility }
  | { id: string; type: "download_repo_file"; workspace: string; path: string; visibility?: FileVisibility }
  | {
      id: string;
      type: "upload_repo_file";
      workspace: string;
      path: string;
      contentBase64: string;
      overwrite?: boolean;
      visibility?: FileVisibility;
    }
  | {
      id: string;
      type: "save_prompt_attachment";
      workspace: string;
      name: string;
      mimeType: string;
      contentBase64: string;
    }
  | { id: string; type: "start_project_archive"; workspace: string }
  | { id: string; type: "project_archive_status"; archiveId: string }
  | { id: string; type: "read_project_archive"; archiveId: string };

export type RunnerResponse =
  | { id: string; type: "event"; event: StreamEvent }
  | { id: string; type: "ok"; result: unknown }
  | { id: string; type: "error"; error: string };

export const DEFAULT_SETTINGS: Settings = {
  defaultAgent: "cursor",
  defaultModel: "",
  binaries: {},
  permission: "ask",
  theme: "dark",
  commandBlockStyle: "prompt",
  filesReadOnly: false,
  wrapText: false,
  visibleChats: 5,
};

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && AGENT_SLUG_RE.test(value);
}

export function parseAgentLabel(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid agent");
  const label = value.trim();
  if (!label || label.length > 64 || /[\u0000-\u001f]/.test(label)) throw new Error("invalid agent");
  return label;
}

export function agentSlug(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  if (!isAgentId(slug)) throw new Error("invalid agent");
  return slug;
}

export function parseAgentCommand(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid agent");
  const command = value.trim();
  if (AGENT_COMMAND_RE.test(command)) return command;
  if (
    command.startsWith("/") &&
    command.length <= 4096 &&
    !command.includes("\0") &&
    !command.includes("..") &&
    !/[\u0000-\u001f\s]/.test(command)
  ) {
    return command;
  }
  throw new Error("invalid agent command. Use a command name or an absolute path");
}

function parseCommandNames(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 40) throw new Error("invalid command");
  const names: string[] = [];
  for (const item of value) {
    const name = parseAgentCommand(item);
    if (!names.includes(name)) names.push(name);
  }
  if (names.length === 0) throw new Error("invalid command");
  return names;
}

export function parseAgentCatalog(value: unknown): AgentDefinition[] {
  if (!Array.isArray(value) || value.length > MAX_AGENTS) throw new Error("invalid agents");
  const agents: AgentDefinition[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") throw new Error("invalid agents");
    const record = item as Record<string, unknown>;
    if (!isAgentId(record.id) || isBuiltinAgent(record.id) || seen.has(record.id)) throw new Error("invalid agents");
    const label = parseAgentLabel(record.label);
    const binary = parseAgentCommand(record.binary);
    seen.add(record.id);
    agents.push({ id: record.id, label, binary });
  }
  return agents;
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

export function assertArchiveId(value: unknown): string {
  if (typeof value !== "string" || !CHAT_ID_RE.test(value)) throw new Error("invalid archive");
  return value;
}

export function cleanMode(value: unknown): string {
  if (value == null || value === "") return "";
  return token(value, "mode");
}

export function cleanModel(value: unknown): string {
  if (value == null || value === "") return "";
  if (typeof value !== "string") throw new Error("model must be a string");
  const model = value.trim();
  if (model.length > 200) throw new Error("model is too long");
  if (/[\r\n\0]/.test(model)) throw new Error("model is invalid");
  return model;
}

const OPENROUTER_PREFIX = "openrouter/";

/** Label for a model choice. OpenRouter ids keep their prefix; the list shows the model path. */
export function displayModelName(id: string, name = ""): string {
  const label = (name || id).trim();
  if (id.startsWith(OPENROUTER_PREFIX) && label.startsWith(OPENROUTER_PREFIX)) return label.slice(OPENROUTER_PREFIX.length);
  return label;
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

export function displayPrompt(text: string, attachmentCount: number): string {
  const trimmed = text.trim();
  if (trimmed) return trimmed;
  return attachmentCount > 0 ? ATTACHED_PROMPT : "";
}

export function attachmentListText(text: string, attachments: readonly { path: string; mimeType: string }[]): string {
  if (attachments.length === 0) return text;
  const lines = attachments.map((item) => `- ${item.path} (${item.mimeType})`);
  return `${text}\n\nAttached files:\n${lines.join("\n")}`;
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

const REPO_PATH_SKIP = new Set(["node_modules", "vendor", "dist", "build"]);

export function repositoryPathAllowed(homeReal: string, resolved: string, directory = "Sites"): boolean {
  const sites = resolvePosix(homeReal, directory);
  if (!isInsidePath(sites, resolved) || stripSlash(resolved) === sites) return false;
  const rel = relativePosix(sites, resolved);
  if (!rel || rel.startsWith("..") || rel.startsWith("/")) return false;
  return !rel.split("/").some((segment) => segment.startsWith(".") || REPO_PATH_SKIP.has(segment));
}

function resolvePosix(root: string, directory: string): string {
  if (directory.startsWith("/")) return normalizePosix(directory);
  return normalizePosix(`${stripSlash(root)}/${directory}`);
}

function normalizePosix(value: string): string {
  const absolute = value.startsWith("/");
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push("..");
      continue;
    }
    parts.push(part);
  }
  return absolute ? `/${parts.join("/")}` : parts.join("/") || ".";
}

function relativePosix(root: string, target: string): string {
  const from = normalizePosix(root);
  const to = normalizePosix(target);
  if (from === to) return "";
  if (from === "/") return to.startsWith("/") ? to.slice(1) : `../${to}`;
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
    case "get_cursor_commands":
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
    case "create_repository": {
      const url = body.url == null || body.url === "" ? undefined : assertGitUrl(body.url);
      return {
        id: body.id,
        type: "create_repository",
        name: assertCatalogName(typeof body.name === "string" ? body.name.trim() : body.name),
        directory: body.directory == null || body.directory === "" ? "Sites" : assertRepoDirectory(body.directory),
        ...(url ? { url } : {}),
      };
    }
    case "set_repository_archived": {
      const workspace = optionalString(body.workspace, "workspace", 4096);
      if (!workspace?.trim()) throw new Error("invalid workspace");
      if (typeof body.archived !== "boolean") throw new Error("invalid repository");
      return { id: body.id, type: "set_repository_archived", workspace: workspace.trim(), archived: body.archived };
    }
    case "delete_repository": {
      const workspace = optionalString(body.workspace, "workspace", 4096);
      if (!workspace?.trim()) throw new Error("invalid workspace");
      if (typeof body.name !== "string" || !body.name.trim()) throw new Error("invalid project name");
      const name = body.name.trim();
      if (name.length > 512 || name.includes("\0") || name.includes("\\")) throw new Error("invalid project name");
      return { id: body.id, type: "delete_repository", workspace: workspace.trim(), name };
    }
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
        mode: body.mode == null ? undefined : cleanMode(body.mode),
        model: body.model == null ? undefined : cleanModel(body.model),
        workspace: optionalString(body.workspace, "workspace", 4096),
        title: body.title == null ? undefined : cleanTitle(body.title),
      };
    }
    case "put_settings":
      return { id: body.id, type: "put_settings", settings: parseSettingsPatch(body.settings) };
    case "send":
    case "prompt": {
      const attachments = parsePromptAttachments(body.attachments);
      const prompt = optionalString(body.prompt, "prompt", 100_000) ?? "";
      if (!prompt.trim() && attachments.length === 0) throw new Error("prompt is empty");
      return {
        id: body.id,
        type: body.type,
        chatId: assertChatId(body.chatId),
        prompt,
        ...(attachments.length > 0 ? { attachments } : {}),
      };
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
    case "resolve_commands":
      return {
        id: body.id,
        type: "resolve_commands",
        names: parseCommandNames(body.names),
        refresh: body.refresh === true,
      };
    case "setup_pi":
      return {
        id: body.id,
        type: "setup_pi",
        provider: parsePiValue(body.provider, "pi provider"),
        model: parsePiValue(body.model, "pi model"),
      };
    case "apply_harness_defaults":
      return parseHarnessDefaults(body);
    case "put_cursor_commands":
      return { id: body.id, type: "put_cursor_commands", commands: parseShellCommands(body.commands) };
    case "put_agent_catalog":
      return { id: body.id, type: "put_agent_catalog", agents: parseAgentCatalog(body.agents) };
    case "list_extensions":
      return { id: body.id, type: "list_extensions" };
    case "install_extension":
      parseExtensionSource(body.source);
      return { id: body.id, type: "install_extension", source: String(body.source).trim() };
    case "update_extension":
      if (!isExtensionSlug(body.name)) throw new Error("invalid extension name");
      return { id: body.id, type: "update_extension", name: body.name };
    case "remove_extension":
      if (!isExtensionSlug(body.name)) throw new Error("invalid extension name");
      return { id: body.id, type: "remove_extension", name: body.name };
    case "set_extension_enabled":
      if (!isExtensionSlug(body.name)) throw new Error("invalid extension name");
      if (typeof body.enabled !== "boolean") throw new Error("invalid extension");
      return {
        id: body.id,
        type: "set_extension_enabled",
        name: body.name,
        enabled: body.enabled,
        reservedThemes: parseSlugList(body.reservedThemes, "theme"),
        reservedDocs: parseSlugList(body.reservedDocs, "doc"),
        reservedAgents: parseSlugList(body.reservedAgents, "agent"),
      };
    case "read_extension_theme":
      if (!isExtensionSlug(body.themeId)) throw new Error("invalid extension theme");
      return { id: body.id, type: "read_extension_theme", themeId: body.themeId };
    case "read_extension_doc":
      if (!isExtensionSlug(body.name) || !isExtensionSlug(body.docId)) throw new Error("invalid extension doc");
      return { id: body.id, type: "read_extension_doc", name: body.name, docId: body.docId };
    case "set_model":
      return { id: body.id, type: "set_model", chatId: assertChatId(body.chatId), modelId: cleanModel(body.modelId) };
    case "dequeue":
      return { id: body.id, type: "dequeue", chatId: assertChatId(body.chatId), index: parseQueueIndex(body.index) };
    case "git_status":
    case "git_init":
      return { id: body.id, type: body.type, workspace: requiredWorkspace(body.workspace) };
    case "git_switch":
      return {
        id: body.id,
        type: "git_switch",
        workspace: requiredWorkspace(body.workspace),
        branch: assertBranchName(body.branch),
      };
    case "git_remote_set":
      return {
        id: body.id,
        type: "git_remote_set",
        workspace: requiredWorkspace(body.workspace),
        url: assertGitUrl(body.url),
      };
    case "git_branch_create":
      return {
        id: body.id,
        type: "git_branch_create",
        workspace: requiredWorkspace(body.workspace),
        branch: assertBranchName(body.branch),
      };
    case "git_pull":
    case "git_push":
      return { id: body.id, type: body.type, workspace: requiredWorkspace(body.workspace) };
    case "git_stage":
    case "git_unstage":
    case "git_discard":
      return {
        id: body.id,
        type: body.type,
        workspace: requiredWorkspace(body.workspace),
        path: assertRepoRelativePath(body.path),
        ...(body.visibility != null ? { visibility: parseFileVisibility(body.visibility) } : {}),
      };
    case "git_commit":
      return {
        id: body.id,
        type: "git_commit",
        workspace: requiredWorkspace(body.workspace),
        message: parseCommitMessage(body.message),
        ...(body.stageVisible === true ? { stageVisible: true } : {}),
        ...(body.visibility != null ? { visibility: parseFileVisibility(body.visibility) } : {}),
      };
    case "git_identity_get":
      return { id: body.id, type: "git_identity_get" };
    case "git_identity_set":
      return { id: body.id, type: "git_identity_set", name: parseGitName(body.name), email: parseGitEmail(body.email) };
    case "list_errors":
    case "clear_errors":
      return { id: body.id, type: body.type };
    case "append_error":
      return { id: body.id, type: "append_error", action: parseActionLabel(body.action), message: parseActionMessage(body.message) };
    case "delete_error":
      return { id: body.id, type: "delete_error", errorId: token(body.errorId, "error") };
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
    case "list_repo_files": {
      const workspace = optionalString(body.workspace, "workspace", 4096);
      if (!workspace?.trim()) throw new Error("invalid workspace");
      return {
        id: body.id,
        type: "list_repo_files",
        workspace: workspace.trim(),
        ...(body.visibility != null ? { visibility: parseFileVisibility(body.visibility) } : {}),
      };
    }
    case "search_repo_files": {
      const workspace = optionalString(body.workspace, "workspace", 4096);
      if (!workspace?.trim()) throw new Error("invalid workspace");
      if (typeof body.query !== "string") throw new Error("invalid search query");
      const query = body.query.trim();
      if (!query || query.length > 256) throw new Error("invalid search query");
      for (const key of ["caseSensitive", "regex", "wholeWord"] as const) {
        if (body[key] != null && typeof body[key] !== "boolean") throw new Error("invalid search option");
      }
      if (body.maxResults != null) {
        if (typeof body.maxResults !== "number" || !Number.isInteger(body.maxResults) || body.maxResults < 1 || body.maxResults > 5000) {
          throw new Error("invalid search option");
        }
      }
      return {
        id: body.id,
        type: "search_repo_files",
        workspace: workspace.trim(),
        query,
        ...(body.caseSensitive === true ? { caseSensitive: true } : {}),
        ...(body.regex === true ? { regex: true } : {}),
        ...(body.wholeWord === true ? { wholeWord: true } : {}),
        ...(body.maxResults != null ? { maxResults: body.maxResults as number } : {}),
        ...(body.visibility != null ? { visibility: parseFileVisibility(body.visibility) } : {}),
      };
    }
    case "read_repo_file": {
      const workspace = optionalString(body.workspace, "workspace", 4096);
      if (!workspace?.trim()) throw new Error("invalid workspace");
      return {
        id: body.id,
        type: "read_repo_file",
        workspace: workspace.trim(),
        path: assertRepoRelativePath(body.path),
        ...(body.visibility != null ? { visibility: parseFileVisibility(body.visibility) } : {}),
      };
    }
    case "read_home_file":
      return { id: body.id, type: "read_home_file", path: assertAbsoluteFilePath(body.path) };
    case "write_repo_file": {
      const workspace = optionalString(body.workspace, "workspace", 4096);
      if (!workspace?.trim()) throw new Error("invalid workspace");
      if (typeof body.content !== "string") throw new Error("invalid file content");
      if (new TextEncoder().encode(body.content).byteLength > 256 * 1024) throw new Error("file is too large");
      return {
        id: body.id,
        type: "write_repo_file",
        workspace: workspace.trim(),
        path: assertRepoRelativePath(body.path),
        content: body.content,
        ...(body.visibility != null ? { visibility: parseFileVisibility(body.visibility) } : {}),
      };
    }
    case "create_repo_entry": {
      const workspace = optionalString(body.workspace, "workspace", 4096);
      if (!workspace?.trim()) throw new Error("invalid workspace");
      if (body.kind !== "file" && body.kind !== "dir") throw new Error("invalid entry kind");
      let content: string | undefined;
      if (body.content != null) {
        if (typeof body.content !== "string") throw new Error("invalid file content");
        if (new TextEncoder().encode(body.content).byteLength > 256 * 1024) throw new Error("file is too large");
        content = body.content;
      }
      return {
        id: body.id,
        type: "create_repo_entry",
        workspace: workspace.trim(),
        path: assertRepoRelativePath(body.path),
        kind: body.kind,
        ...(content !== undefined ? { content } : {}),
        ...(body.visibility != null ? { visibility: parseFileVisibility(body.visibility) } : {}),
      };
    }
    case "rename_repo_entry": {
      const workspace = optionalString(body.workspace, "workspace", 4096);
      if (!workspace?.trim()) throw new Error("invalid workspace");
      return {
        id: body.id,
        type: "rename_repo_entry",
        workspace: workspace.trim(),
        path: assertRepoRelativePath(body.path),
        newPath: assertRepoRelativePath(body.newPath),
        ...(body.visibility != null ? { visibility: parseFileVisibility(body.visibility) } : {}),
      };
    }
    case "delete_repo_entry": {
      const workspace = optionalString(body.workspace, "workspace", 4096);
      if (!workspace?.trim()) throw new Error("invalid workspace");
      return {
        id: body.id,
        type: "delete_repo_entry",
        workspace: workspace.trim(),
        path: assertRepoRelativePath(body.path),
        ...(body.visibility != null ? { visibility: parseFileVisibility(body.visibility) } : {}),
      };
    }
    case "download_repo_file": {
      const workspace = optionalString(body.workspace, "workspace", 4096);
      if (!workspace?.trim()) throw new Error("invalid workspace");
      return {
        id: body.id,
        type: "download_repo_file",
        workspace: workspace.trim(),
        path: assertRepoRelativePath(body.path),
        ...(body.visibility != null ? { visibility: parseFileVisibility(body.visibility) } : {}),
      };
    }
    case "start_project_archive": {
      const workspace = optionalString(body.workspace, "workspace", 4096);
      if (!workspace?.trim()) throw new Error("invalid workspace");
      return { id: body.id, type: "start_project_archive", workspace: workspace.trim() };
    }
    case "project_archive_status":
      return { id: body.id, type: "project_archive_status", archiveId: assertArchiveId(body.archiveId) };
    case "read_project_archive":
      return { id: body.id, type: "read_project_archive", archiveId: assertArchiveId(body.archiveId) };
    case "upload_repo_file": {
      const workspace = optionalString(body.workspace, "workspace", 4096);
      if (!workspace?.trim()) throw new Error("invalid workspace");
      if (body.overwrite != null && typeof body.overwrite !== "boolean") throw new Error("invalid upload");
      return {
        id: body.id,
        type: "upload_repo_file",
        workspace: workspace.trim(),
        path: assertRepoRelativePath(body.path),
        contentBase64: parseTransferBase64(body.contentBase64),
        ...(body.overwrite === true ? { overwrite: true } : {}),
        ...(body.visibility != null ? { visibility: parseFileVisibility(body.visibility) } : {}),
      };
    }
    case "save_prompt_attachment":
      return {
        id: body.id,
        type: "save_prompt_attachment",
        workspace: requiredWorkspace(body.workspace),
        name: assertUploadFileName(body.name),
        mimeType: cleanMimeType(body.mimeType),
        contentBase64: parseAttachmentBase64(body.contentBase64),
      };
    default:
      throw new Error("unknown request");
  }
}

export function parseFileVisibility(value: unknown): FileVisibility {
  if (value == null) return { ...DEFAULT_FILE_VISIBILITY };
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("invalid file visibility");
  const record = value as Record<string, unknown>;
  if (record.showHidden != null && typeof record.showHidden !== "boolean") throw new Error("invalid file visibility");
  if (record.showGitignored != null && typeof record.showGitignored !== "boolean") throw new Error("invalid file visibility");
  if (record.showGitDir != null && typeof record.showGitDir !== "boolean") throw new Error("invalid file visibility");
  return {
    showHidden: Boolean(record.showHidden),
    showGitignored: Boolean(record.showGitignored),
    showGitDir: Boolean(record.showGitDir),
  };
}

export function assertUploadFileName(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid file name");
  const name = value.trim();
  if (
    !name ||
    name.length > 255 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    throw new Error("invalid file name");
  }
  return name;
}

export function repoUploadPath(directory: unknown, fileName: unknown): string {
  const name = assertUploadFileName(fileName);
  if (typeof directory !== "string" || !directory.trim()) return assertRepoRelativePath(name);
  const dir = directory.trim().replace(/^\/+|\/+$/g, "");
  if (!dir) return assertRepoRelativePath(name);
  return assertRepoRelativePath(`${dir}/${name}`);
}

export function parseTransferBase64(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid file content");
  const cleaned = value.replace(/\s+/g, "");
  const maxChars = Math.ceil(MAX_TRANSFER_BYTES / 3) * 4;
  if (cleaned.length > maxChars) throw new Error("file is too large");
  if (cleaned.length > 0 && !/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) throw new Error("invalid file content");
  return cleaned;
}

export function parseAttachmentBase64(value: unknown): string {
  const cleaned = parseTransferBase64(value);
  const maxChars = Math.ceil(MAX_PROMPT_ATTACHMENT_BYTES / 3) * 4;
  if (cleaned.length > maxChars) throw new Error("file is too large");
  return cleaned;
}

export function cleanMimeType(value: unknown): string {
  if (typeof value !== "string") return "application/octet-stream";
  const mime = value.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime === "image/jpg") return "image/jpeg";
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(mime)) {
    return "application/octet-stream";
  }
  return mime;
}

export function assertPromptAttachmentPath(value: unknown): string {
  const rel = assertRepoRelativePath(value);
  const prefix = `${PROMPT_UPLOAD_DIR}/`;
  if (!rel.startsWith(prefix)) throw new Error("invalid attachment");
  const name = rel.slice(prefix.length);
  if (!name || name.includes("/")) throw new Error("invalid attachment");
  return rel;
}

export function parsePromptAttachments(value: unknown): PromptAttachment[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("invalid attachment");
  if (value.length > MAX_PROMPT_ATTACHMENTS) throw new Error("too many attachments");
  return value.map((item) => parsePromptAttachment(item));
}

function parsePromptAttachment(value: unknown): PromptAttachment {
  if (!value || typeof value !== "object") throw new Error("invalid attachment");
  const body = value as Record<string, unknown>;
  const size = body.size;
  if (typeof size !== "number" || !Number.isInteger(size) || size < 0 || size > MAX_PROMPT_ATTACHMENT_BYTES) {
    throw new Error("invalid attachment");
  }
  return {
    name: assertUploadFileName(body.name),
    path: assertPromptAttachmentPath(body.path),
    mimeType: cleanMimeType(body.mimeType),
    size,
  };
}

const MAX_COMMIT_MESSAGE = 50_000;

const GIT_NAME_MAX = 200;
const GIT_EMAIL_MAX = 200;

export function parseGitName(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid git name");
  const name = value.trim();
  if (!name || name.length > GIT_NAME_MAX || name.startsWith("-") || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error("invalid git name");
  }
  return name;
}

export function parseGitEmail(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid git email");
  const email = value.trim();
  if (
    !email ||
    email.length > GIT_EMAIL_MAX ||
    email.startsWith("-") ||
    /[\s\u0000-\u001f\u007f]/.test(email) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new Error("invalid git email");
  }
  return email;
}

export function parseCommitMessage(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error("invalid commit message");
  const message = value.trim();
  if (!message || message.length > MAX_COMMIT_MESSAGE) throw new Error("invalid commit message");
  return message;
}

export function assertAbsoluteFilePath(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid file path");
  const trimmed = value.trim();
  if (
    !trimmed.startsWith("/") ||
    trimmed.length > 4096 ||
    trimmed.includes("\0") ||
    trimmed.includes("\\") ||
    trimmed.includes("\n")
  ) {
    throw new Error("invalid file path");
  }
  const parts = trimmed.split("/");
  if (parts.length < 3) throw new Error("invalid file path");
  for (const part of parts.slice(1)) {
    if (!part || part === "." || part === "..") throw new Error("invalid file path");
  }
  return parts.join("/");
}

export function assertRepoRelativePath(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid file path");
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 4096 || trimmed.startsWith("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new Error("invalid file path");
  }
  const parts = trimmed.split("/").filter((part) => part.length > 0);
  if (parts.length === 0 || parts.length > 64) throw new Error("invalid file path");
  for (const part of parts) {
    if (part === "." || part === "..") throw new Error("invalid file path");
  }
  return parts.join("/");
}

function parseQueueIndex(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1000) {
    throw new Error("invalid queue index");
  }
  return value;
}

function requiredWorkspace(value: unknown): string {
  const workspace = optionalString(value, "workspace", 4096);
  if (!workspace?.trim()) throw new Error("invalid workspace");
  return workspace.trim();
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

function parseActionLabel(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid action");
  const action = value.replace(/\s+/g, " ").trim();
  if (!action || action.length > 80) throw new Error("invalid action");
  return action;
}

function parseActionMessage(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid error");
  const message = value.replace(/\0/g, "").trim();
  if (!message || message.length > MAX_ACTION_ERROR_CHARS) throw new Error("invalid error");
  return message;
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

export function assertBranchName(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid branch");
  const name = value.trim();
  if (
    name.startsWith("-")
    || name.includes("..")
    || name.endsWith(".")
    || name.endsWith("/")
    || name.endsWith(".lock")
    || name.includes("@{")
    || name.includes("//")
    || name.includes("\\")
    || name.includes("\0")
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(name)
  ) {
    throw new Error("invalid branch");
  }
  return name;
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

function agentKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const keys: string[] = [];
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (!isAgentId(key) || keys.includes(key)) continue;
    if (keys.length >= MAX_AGENTS) break;
    keys.push(key);
  }
  return keys;
}

export function parsePolicyBinaries(value: unknown): Partial<Record<AgentId, string>> {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("invalid binaries");
  const binaries: Partial<Record<AgentId, string>> = {};
  for (const agent of agentKeys(value)) {
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
  if (!Array.isArray(body.agents) || body.agents.length === 0 || body.agents.length > MAX_AGENTS) {
    throw new Error("at least one agent must stay on");
  }
  const agents: AgentId[] = [];
  for (const agent of body.agents) {
    if (!isAgentId(agent) || agents.includes(agent)) throw new Error("invalid agent");
    agents.push(agent);
  }
  if (typeof body.rawTerminal !== "boolean") throw new Error("invalid terminal");
  const fileManager = typeof body.fileManager === "boolean" ? body.fileManager : true;
  if (body.fileEditor != null && typeof body.fileEditor !== "boolean") throw new Error("invalid file editor");
  const fileEditor = body.fileEditor == null ? true : body.fileEditor;
  if (body.fileDownload != null && typeof body.fileDownload !== "boolean") throw new Error("invalid file download");
  if (body.fileUpload != null && typeof body.fileUpload !== "boolean") throw new Error("invalid file upload");
  if (body.projectCreate != null && typeof body.projectCreate !== "boolean") throw new Error("invalid project creation");
  const fileDownload = body.fileDownload == null ? true : body.fileDownload;
  const fileUpload = body.fileUpload == null ? true : body.fileUpload;
  const projectCreate = body.projectCreate == null ? true : body.projectCreate;
  const options = parsePolicyOptions(body.options);
  return {
    agents,
    binaries: parsePolicyBinaries(body.binaries),
    rawTerminal: body.rawTerminal,
    fileManager,
    fileEditor,
    fileDownload,
    fileUpload,
    projectCreate,
    ...(options ? { options } : {}),
  };
}

export function parsePiValue(value: unknown, label: string): string {
  if (value == null || value === "") return "";
  if (typeof value !== "string" || value.length > 200 || !/^[A-Za-z0-9._:/-]+$/.test(value)) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

export const CURSOR_DEFAULT_MODEL_ID = "grok-4.7";
export const CURSOR_DEFAULT_MODEL_NAME = "Grok 4.7 256K High";
export const CURSOR_DEFAULT_PARAMETERS: { id: string; value: string }[] = [
  { id: "context", value: "256k" },
  { id: "reasoning_effort", value: "high" },
  { id: "fast", value: "false" },
];

const SHELL_COMMAND_RE = /^[A-Za-z0-9][A-Za-z0-9._+/-]*(?: [A-Za-z0-9][A-Za-z0-9._+/-]*)*$/;

export function parseShellCommands(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error("invalid commands");
  const commands: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new Error("invalid commands");
    const name = item.trim();
    if (!name || name.length > 64 || !SHELL_COMMAND_RE.test(name)) throw new Error("invalid commands");
    if (!commands.includes(name)) commands.push(name);
  }
  return commands;
}

export function shellAllowEntry(name: string): string {
  const commands = parseShellCommands([name]);
  return `Shell(${commands[0]})`;
}

export function isShellAllowEntry(value: string): boolean {
  return value.startsWith("Shell(") && value.endsWith(")");
}

export function readShellCommands(current: unknown): string[] {
  const permissions = plainRecord(plainRecord(current)?.permissions);
  const allow = Array.isArray(permissions?.allow) ? permissions.allow : [];
  const commands: string[] = [];
  for (const item of allow) {
    if (typeof item !== "string" || !isShellAllowEntry(item)) continue;
    const name = item.slice("Shell(".length, -1).trim();
    if (!name || name.length > 64 || !SHELL_COMMAND_RE.test(name) || commands.includes(name)) continue;
    commands.push(name);
  }
  return commands;
}

export function piDefaultAllowed(models: readonly { id: string }[], provider: string, model: string): boolean {
  if (!provider || !model) return false;
  const full = `${provider}/${model}`;
  return models.some((item) => item.id === model || item.id === full);
}

export function mergePiDefaults(current: unknown, provider: string, model: string): Record<string, unknown> {
  const next = { ...(plainRecord(current) ?? {}) };
  next.defaultProvider = provider;
  next.defaultModel = model;
  return next;
}

export function mergeCursorConfig(
  current: unknown,
  patch: { writeModel?: boolean; commands?: string[] | null; fast?: boolean },
): Record<string, unknown> {
  const next = { ...(plainRecord(current) ?? {}) };
  if (patch.writeModel) {
    const parameters = cursorParameters(patch.fast === true);
    const existing = plainRecord(next.model) ?? {};
    next.model = {
      ...existing,
      modelId: CURSOR_DEFAULT_MODEL_ID,
      displayModelId: CURSOR_DEFAULT_MODEL_ID,
      displayName: CURSOR_DEFAULT_MODEL_NAME,
      displayNameShort: CURSOR_DEFAULT_MODEL_NAME,
      aliases: Array.isArray(existing.aliases) ? existing.aliases : [],
      maxMode: false,
    };
    next.selectedModel = { modelId: CURSOR_DEFAULT_MODEL_ID, parameters };
    const modelParameters = { ...(plainRecord(next.modelParameters) ?? {}) };
    modelParameters[CURSOR_DEFAULT_MODEL_ID] = parameters;
    next.modelParameters = modelParameters;
    next.hasChangedDefaultModel = true;
  }
  if (patch.commands != null) {
    const permissions = { ...(plainRecord(next.permissions) ?? {}) };
    const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
    const kept = allow.filter((item) => !(typeof item === "string" && isShellAllowEntry(item)));
    permissions.allow = [...patch.commands.map((name) => shellAllowEntry(name)), ...kept];
    next.permissions = permissions;
  }
  return next;
}

function cursorParameters(fast: boolean): { id: string; value: string }[] {
  return CURSOR_DEFAULT_PARAMETERS.map((item) => ({
    id: item.id,
    value: item.id === "fast" ? (fast ? "true" : "false") : item.value,
  }));
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseHarnessDefaults(body: Record<string, unknown>): RunnerRequest {
  if (body.agent === "pi") {
    const provider = parsePiValue(body.provider, "pi provider");
    const model = parsePiValue(body.model, "pi model");
    if (!provider || !model) throw new Error("invalid pi model");
    return { id: body.id as string, type: "apply_harness_defaults", agent: "pi", provider, model };
  }
  if (body.agent !== "cursor") throw new Error("invalid agent");
  if (typeof body.writeModel !== "boolean") throw new Error("invalid model");
  return {
    id: body.id as string,
    type: "apply_harness_defaults",
    agent: "cursor",
    writeModel: body.writeModel,
    commands: parseShellCommands(body.commands),
    fast: parseCursorFast(body),
  };
}

function parseCursorFast(body: Record<string, unknown>): boolean {
  if (!Object.prototype.hasOwnProperty.call(body, "fast")) return false;
  if (typeof body.fast !== "boolean") throw new Error("invalid fast");
  return body.fast;
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
  for (const agent of agentKeys(value)) {
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
  return {
    agents: [...AGENTS],
    binaries: {},
    rawTerminal: true,
    fileManager: true,
    fileEditor: true,
    fileDownload: true,
    fileUpload: true,
    projectCreate: true,
  };
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

export function parseVisibleChats(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error("invalid visibleChats");
  }
  return value;
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
  if (body.theme != null) {
    if (!isThemeId(body.theme)) throw new Error("invalid theme");
    patch.theme = body.theme;
  }
  if (body.commandBlockStyle != null) {
    if (!isCommandBlockStyle(body.commandBlockStyle)) throw new Error("invalid commandBlockStyle");
    patch.commandBlockStyle = body.commandBlockStyle;
  }
  if (body.filesReadOnly != null) {
    if (typeof body.filesReadOnly !== "boolean") throw new Error("invalid filesReadOnly");
    patch.filesReadOnly = body.filesReadOnly;
  }
  if (body.wrapText != null) {
    if (typeof body.wrapText !== "boolean") throw new Error("invalid wrapText");
    patch.wrapText = body.wrapText;
  }
  if (body.visibleChats != null) patch.visibleChats = parseVisibleChats(body.visibleChats);
  if (body.binaries != null) {
    if (typeof body.binaries !== "object") throw new Error("invalid binaries");
    const binaries: SettingsPatch["binaries"] = {};
    for (const agent of agentKeys(body.binaries)) {
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
    theme: patch.theme ?? current.theme ?? "dark",
    commandBlockStyle: patch.commandBlockStyle ?? current.commandBlockStyle ?? "prompt",
    filesReadOnly: patch.filesReadOnly ?? current.filesReadOnly ?? false,
    wrapText: patch.wrapText ?? current.wrapText ?? false,
    visibleChats: patch.visibleChats ?? current.visibleChats ?? 5,
  };
  if (patch.binaries) {
    for (const agent of Object.keys(patch.binaries)) {
      if (!isAgentId(agent)) continue;
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
export {
  assertContributionsFree,
  emptyReserved,
  EXTENSION_AGENT_IDS,
  EXTENSION_SLUG_RE,
  EXTENSION_THEME_IDS,
  isExtensionSlug,
  MAX_EXTENSION_CSS_BYTES,
  MAX_EXTENSION_DOC_BYTES,
  parseExtensionManifest,
  parseExtensionSource,
  parseSlugList,
  type ExtensionAgent,
  type ExtensionDoc,
  type ExtensionManifest,
  type ExtensionRecord,
  type ExtensionScope,
  type ExtensionTheme,
  type ReservedIds,
  type ThemeSwatches,
} from "./extensions.ts";
