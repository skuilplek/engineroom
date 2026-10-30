import type {
  AgentId,
  AgentOptionChoice,
  CatalogEntry,
  ChatDetail,
  ChatMeta,
  EnvEntry,
  FileVisibility,
  ActionError,
  GitIdentity,
  GitStatus,
  PromptAttachment,
  RepoFileContent,
  RepoFilesResult,
  RepoSearchOptions,
  RepoSearchResult,
  RepositoryEntry,
  CommandBlockStyle,
  Settings,
  SettingsPatch,
  ExtensionDoc,
  ExtensionRecord,
  ExtensionTheme,
  ThemePreference,
  UserAccess,
  UserPolicy,
} from "@engineroom/protocol";

export interface AgentOptionConfig {
  discovered: { modes: AgentOptionChoice[]; models: AgentOptionChoice[]; probedAt: string };
  offered: { modes: string[]; models: string[] };
}

export type AgentOptionsState = Partial<Record<AgentId, AgentOptionConfig>>;

export interface Session {
  username: string;
  home: string;
  admin: boolean;
  agents: AgentId[];
  rawTerminal: boolean;
  fileManager: boolean;
  fileManagerOffered?: boolean;
  fileEditor: boolean;
  fileDownload?: boolean;
  fileUpload?: boolean;
  fileDownloadOffered?: boolean;
  fileUploadOffered?: boolean;
  filesReadOnly?: boolean;
  wrapText?: boolean;
  visibleChats?: number;
  cliImport: boolean;
  appName: string;
  theme: ThemePreference;
  themes?: ExtensionTheme[];
  commandBlockStyle?: CommandBlockStyle;
  fileVisibility?: FileVisibility;
  projectCreate: boolean;
  projectDownloads: boolean;
  agentCatalog?: { id: string; label: string }[];
  piSetup?: boolean;
  piLoginHint?: boolean;
  options: Partial<Record<AgentId, { modes: AgentOptionChoice[]; models: AgentOptionChoice[] }>>;
}

export interface AdminAgent {
  id: string;
  label: string;
  binary: string;
  builtin: boolean;
  available: boolean;
  path: string | null;
  pathSource?: "detected" | "manual" | null;
  allowOverride?: boolean;
  enabled: boolean;
  packageName?: string;
}

export interface AgentInventory {
  agents: AdminAgent[];
  rawTerminal: boolean;
  cliImport: boolean;
  fileManager: boolean;
  fileEditor?: boolean;
  fileDownload?: boolean;
  fileUpload?: boolean;
  piProvider?: string;
  piModel?: string;
  cursorCommands?: string[];
}

export interface Account {
  username: string;
  home: string;
  uid: number;
}

export interface UserBundle extends UserAccess {
  username: string;
  home: string;
  uid: number;
  shell: string;
  themes?: ExtensionTheme[];
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* keep the status text */
    }
    throw new ApiError(response.status, message);
  }
  return (await response.json()) as T;
}

export function me() {
  return api<Session>("/api/me");
}

export function login(username: string, password: string) {
  return api<Session>("/api/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export function logout() {
  return api<{ ok: boolean }>("/api/logout", { method: "POST" });
}

export function listChats() {
  return api<ChatMeta[]>("/api/chats");
}

export function getChat(id: string) {
  return api<ChatDetail>(`/api/chats/${id}`);
}

export function createChat(input: { agent?: string; mode?: string; model?: string; workspace?: string; title?: string }) {
  return api<ChatMeta>("/api/chats", { method: "POST", body: JSON.stringify(input) });
}

export function getSettings() {
  return api<Settings>("/api/settings");
}

export function getGitIdentity() {
  return api<GitIdentity>("/api/git-identity");
}

export function saveGitIdentity(identity: GitIdentity) {
  return api<GitIdentity>("/api/git-identity", { method: "PUT", body: JSON.stringify(identity) });
}

export function listActionErrors() {
  return api<ActionError[]>("/api/errors");
}

export function saveActionError(action: string, message: string) {
  return api<ActionError>("/api/errors", { method: "POST", body: JSON.stringify({ action, message }) });
}

export function deleteActionError(id: string) {
  return api<{ ok: boolean }>(`/api/errors/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function clearActionErrors() {
  return api<{ ok: boolean }>("/api/errors", { method: "DELETE" });
}

export function saveSettings(settings: SettingsPatch) {
  return api<Settings>("/api/settings", { method: "PUT", body: JSON.stringify(settings) });
}

export function listRepositories() {
  return api<RepositoryEntry[]>("/api/repositories");
}

export function createRepository(name: string, url?: string) {
  return api<RepositoryEntry>("/api/repositories", {
    method: "POST",
    body: JSON.stringify({ name, ...(url ? { url } : {}) }),
  });
}

export function setRepositoryArchived(workspace: string, archived: boolean) {
  return api<RepositoryEntry[]>("/api/repositories/archived", {
    method: "POST",
    body: JSON.stringify({ workspace, archived }),
  });
}

export function deleteRepository(workspace: string, name: string) {
  return api<RepositoryEntry[]>("/api/repositories", {
    method: "DELETE",
    body: JSON.stringify({ workspace, name }),
  });
}

export function gitWorkspace(workspace: string) {
  return api<GitStatus>(`/api/repositories/git?workspace=${encodeURIComponent(workspace)}`);
}

export function initGitWorkspace(workspace: string) {
  return api<GitStatus>("/api/repositories/git", {
    method: "POST",
    body: JSON.stringify({ workspace, action: "init" }),
  });
}

export function switchGitBranch(workspace: string, branch: string) {
  return api<GitStatus>("/api/repositories/git", {
    method: "POST",
    body: JSON.stringify({ workspace, action: "switch", branch }),
  });
}

export function setGitRemote(workspace: string, url: string) {
  return api<GitStatus>("/api/repositories/git", {
    method: "POST",
    body: JSON.stringify({ workspace, action: "remote", url }),
  });
}

export function createGitBranch(workspace: string, branch: string) {
  return api<GitStatus>("/api/repositories/git", {
    method: "POST",
    body: JSON.stringify({ workspace, action: "branch", branch }),
  });
}

export function pullGit(workspace: string) {
  return api<GitStatus>("/api/repositories/git", {
    method: "POST",
    body: JSON.stringify({ workspace, action: "pull" }),
  });
}

export function pushGit(workspace: string) {
  return api<GitStatus>("/api/repositories/git", {
    method: "POST",
    body: JSON.stringify({ workspace, action: "push" }),
  });
}

export function stageRepoChange(workspace: string, filePath: string) {
  return gitFileAction(workspace, "stage", filePath);
}

export function unstageRepoChange(workspace: string, filePath: string) {
  return gitFileAction(workspace, "unstage", filePath);
}

export function discardRepoChange(workspace: string, filePath: string) {
  return gitFileAction(workspace, "discard", filePath);
}

export function commitRepoChanges(workspace: string, message: string, stageVisible = false) {
  return api<{ ok: true }>("/api/repositories/git", {
    method: "POST",
    body: JSON.stringify({
      workspace,
      action: "commit",
      message,
      ...(stageVisible ? { stageVisible: true } : {}),
    }),
  });
}

function gitFileAction(workspace: string, action: "stage" | "unstage" | "discard", filePath: string) {
  return api<{ path: string }>("/api/repositories/git", {
    method: "POST",
    body: JSON.stringify({ workspace, action, path: filePath }),
  });
}

export function listRepoFiles(workspace: string) {
  return api<RepoFilesResult>(`/api/repositories/files?workspace=${encodeURIComponent(workspace)}`);
}

export function searchRepoFiles(workspace: string, options: RepoSearchOptions) {
  const params = new URLSearchParams({ workspace, query: options.query });
  if (options.caseSensitive) params.set("caseSensitive", "true");
  if (options.regex) params.set("regex", "true");
  if (options.wholeWord) params.set("wholeWord", "true");
  if (options.maxResults != null) params.set("maxResults", String(options.maxResults));
  return api<RepoSearchResult>(`/api/repositories/search?${params.toString()}`);
}

export function readRepoFile(workspace: string, filePath: string) {
  return api<RepoFileContent>(
    `/api/repositories/file?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent(filePath)}`,
  );
}

export function readHomeFile(filePath: string) {
  return api<RepoFileContent>(`/api/files/preview?path=${encodeURIComponent(filePath)}`);
}

export function writeRepoFile(workspace: string, filePath: string, content: string) {
  return api<RepoFileContent>("/api/repositories/file", {
    method: "PUT",
    body: JSON.stringify({ workspace, path: filePath, content }),
  });
}

export function createRepoEntry(workspace: string, filePath: string, kind: "file" | "dir", content?: string) {
  return api<{ path: string; kind: "file" | "dir" }>("/api/repositories/file", {
    method: "POST",
    body: JSON.stringify({ workspace, path: filePath, kind, ...(content !== undefined ? { content } : {}) }),
  });
}

export function renameRepoEntry(workspace: string, filePath: string, newPath: string) {
  return api<{ path: string; newPath: string }>("/api/repositories/file", {
    method: "PATCH",
    body: JSON.stringify({ workspace, path: filePath, newPath }),
  });
}

export function deleteRepoEntry(workspace: string, filePath: string) {
  return api<{ path: string }>(
    `/api/repositories/file?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent(filePath)}`,
    { method: "DELETE" },
  );
}

export interface ProjectArchive {
  id: string;
  filename: string;
  status: "creating" | "ready" | "failed";
  error?: string;
  size?: number;
}

export function startProjectArchive(workspace: string) {
  return api<ProjectArchive>("/api/repositories/archive", {
    method: "POST",
    body: JSON.stringify({ workspace }),
  });
}

export function projectArchiveStatus(id: string) {
  return api<ProjectArchive>(`/api/repositories/archive?id=${encodeURIComponent(id)}`);
}

export function projectArchiveDownloadUrl(id: string) {
  return `/api/repositories/archive/download?id=${encodeURIComponent(id)}`;
}

export async function downloadRepoFile(workspace: string, filePath: string): Promise<{ blob: Blob; name: string }> {
  const response = await fetch(
    `/api/repositories/file/download?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent(filePath)}`,
    { cache: "no-store" },
  );
  if (!response.ok) throw new ApiError(response.status, await errorMessage(response));
  const blob = await response.blob();
  const fallback = filePath.split("/").pop() || "download";
  return { blob, name: filenameFromDisposition(response.headers.get("Content-Disposition"), fallback) };
}

export async function uploadRepoFiles(
  workspace: string,
  directory: string,
  files: File[],
  overwrite: boolean,
): Promise<{ files: { path: string; size: number }[] }> {
  const body = new FormData();
  body.set("workspace", workspace);
  body.set("directory", directory);
  body.set("overwrite", overwrite ? "true" : "false");
  for (const file of files) body.append("file", file, file.name);
  const response = await fetch("/api/repositories/file/upload", { method: "POST", body });
  if (!response.ok) throw new ApiError(response.status, await errorMessage(response));
  return (await response.json()) as { files: { path: string; size: number }[] };
}

export async function uploadPromptAttachment(workspace: string, file: File): Promise<PromptAttachment> {
  const body = new FormData();
  body.set("workspace", workspace);
  body.append("file", file, file.name);
  const response = await fetch("/api/chats/attachments", { method: "POST", body });
  if (!response.ok) throw new ApiError(response.status, await errorMessage(response));
  const payload = (await response.json()) as { files?: PromptAttachment[] };
  const saved = payload.files?.[0];
  if (!saved?.path) throw new ApiError(response.status, "invalid upload");
  return saved;
}

async function errorMessage(response: Response): Promise<string> {
  let text = response.statusText;
  try {
    const body = (await response.json()) as { error?: string };
    if (body.error) text = body.error;
  } catch {
    /* keep the status text */
  }
  return text;
}

function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* use the plain filename */
    }
  }
  const quoted = /filename="([^"]+)"/i.exec(header);
  return quoted?.[1] || fallback;
}

export function listCatalog() {
  return api<{ repositories: CatalogEntry[] }>("/api/admin/catalog");
}

export function getRepoDirectory() {
  return api<{ directory: string; visibility: FileVisibility; projectCreate?: boolean; projectDownloads?: boolean }>("/api/admin/repository-folder");
}

export function saveRepoDirectory(
  directory: string,
  visibility?: FileVisibility,
  projectCreate?: boolean,
  projectDownloads?: boolean,
) {
  return api<{ directory: string; visibility: FileVisibility; projectCreate: boolean; projectDownloads: boolean }>("/api/admin/repository-folder", {
    method: "PUT",
    body: JSON.stringify({
      directory,
      ...(visibility ? { visibility } : {}),
      ...(typeof projectCreate === "boolean" ? { projectCreate } : {}),
      ...(typeof projectDownloads === "boolean" ? { projectDownloads } : {}),
    }),
  });
}

export function addCatalog(name: string, url: string) {
  return api<CatalogEntry>("/api/admin/catalog", {
    method: "POST",
    body: JSON.stringify({ name, url }),
  });
}

export function removeCatalog(id: string) {
  return api<{ repositories: CatalogEntry[] }>(`/api/admin/catalog/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function getUserAccess(username: string) {
  return api<UserBundle>(`/api/admin/users/${encodeURIComponent(username)}`);
}

export function listUserChats(username: string) {
  return api<ChatMeta[]>(`/api/admin/users/${encodeURIComponent(username)}/chats`);
}

export function getUserChat(username: string, chatId: string) {
  return api<ChatDetail>(`/api/admin/users/${encodeURIComponent(username)}/chats/${encodeURIComponent(chatId)}`);
}

export function saveUserPolicy(username: string, policy: UserPolicy) {
  return api<UserPolicy>(`/api/admin/users/${encodeURIComponent(username)}/policy`, {
    method: "PUT",
    body: JSON.stringify(policy),
  });
}

export function saveUserSettings(username: string, settings: SettingsPatch) {
  return api<Settings>(`/api/admin/users/${encodeURIComponent(username)}/settings`, {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export function saveUserGrants(username: string, ids: string[]) {
  return api<{ grants: string[]; repositories: RepositoryEntry[] }>(`/api/admin/users/${encodeURIComponent(username)}/repositories`, {
    method: "PUT",
    body: JSON.stringify({ ids }),
  });
}

export function saveUserEnv(username: string, entries: EnvEntry[]) {
  return api<EnvEntry[]>(`/api/admin/users/${encodeURIComponent(username)}/env`, {
    method: "PUT",
    body: JSON.stringify({ entries }),
  });
}

export function changePassword(username: string, password: string) {
  return api<{ ok: boolean }>(`/api/admin/users/${encodeURIComponent(username)}/password`, {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}

export function getUserGitIdentity(username: string) {
  return api<GitIdentity>(`/api/admin/users/${encodeURIComponent(username)}/git-identity`);
}

export function saveUserGitIdentity(username: string, identity: GitIdentity) {
  return api<GitIdentity>(`/api/admin/users/${encodeURIComponent(username)}/git-identity`, {
    method: "PUT",
    body: JSON.stringify(identity),
  });
}

export function listAccounts() {
  return api<Account[]>("/api/admin/users");
}

export function addAccount(username: string, password: string) {
  return api<{ ok: boolean; accounts?: Account[] }>("/api/admin/users", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export function removeAccount(username: string) {
  return api<{ ok: boolean }>(`/api/admin/users/${encodeURIComponent(username)}/remove`, { method: "POST" });
}

export interface ServerOverview {
  configFile: string;
  host: {
    hostname: string;
    platform: string;
    arch: string;
    node: string;
    uptimeSeconds: number;
    memoryFree: number;
    memoryTotal: number;
  };
  disks: { path: string; total: number; free: number }[];
  commands: { name: string; available: boolean; path: string | null }[];
}

export function serverOverview() {
  return api<ServerOverview>("/api/admin/overview");
}

export interface ServerWifiInterface {
  name: string;
  ssid: string | null;
  signal: number | null;
}

export interface ServerNetwork {
  hostname: string;
  url: string;
  avahi: boolean;
  port80: boolean;
  wifi: {
    available: boolean;
    backend: "networkmanager" | "netplan" | "none";
    interfaces: ServerWifiInterface[];
  };
}

export interface WifiNetwork {
  ssid: string;
  signal: number;
  security: string;
}

export function getServerNetwork() {
  return api<ServerNetwork>("/api/admin/server");
}

export function saveServerHostname(hostname: string) {
  return api<ServerNetwork>("/api/admin/server/hostname", {
    method: "PUT",
    body: JSON.stringify({ hostname }),
  });
}

export function scanServerWifi(iface: string) {
  return api<{ interface: string; networks: WifiNetwork[] }>("/api/admin/server/wifi/scan", {
    method: "POST",
    body: JSON.stringify({ interface: iface }),
  });
}

export function connectServerWifi(iface: string, ssid: string, password: string) {
  return api<ServerNetwork>("/api/admin/server/wifi", {
    method: "PUT",
    body: JSON.stringify({ interface: iface, ssid, password }),
  });
}

export function disconnectServerWifi(iface: string) {
  return api<ServerNetwork>("/api/admin/server/wifi", {
    method: "DELETE",
    body: JSON.stringify({ interface: iface }),
  });
}

export function getAgentOptions() {
  return api<AgentOptionsState>("/api/admin/agent-options");
}

export function saveAgentOptions(offered: Partial<Record<AgentId, { modes: string[]; models: string[] }>>) {
  return api<AgentOptionsState>("/api/admin/agent-options", {
    method: "PUT",
    body: JSON.stringify(offered),
  });
}

export function probeAgentOptions(agent: AgentId) {
  return api<AgentOptionConfig>(`/api/admin/agent-options/${agent}/probe`, { method: "POST" });
}

export function saveBranding(appName: string) {
  return api<{ appName: string }>("/api/admin/branding", {
    method: "PUT",
    body: JSON.stringify({ appName }),
  });
}

export function listAdminAgents() {
  return api<AgentInventory>("/api/admin/agents");
}

export function createCustomAgent(label: string, binary: string) {
  return api<AgentInventory>("/api/admin/agents/custom", {
    method: "POST",
    body: JSON.stringify({ label, binary }),
  });
}

export function deleteCustomAgent(id: string) {
  return api<AgentInventory>(`/api/admin/agents/custom/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function saveAgents(
  flags: Record<string, boolean>,
  rawTerminal?: boolean,
  cliImport?: boolean,
  fileManager?: boolean,
  fileEditor?: boolean,
  fileDownload?: boolean,
  fileUpload?: boolean,
  extra?: {
    piProvider?: string;
    piModel?: string;
    cursorCommands?: string[];
  },
) {
  return api<{
    agents: AgentId[];
    rawTerminal?: boolean;
    cliImport?: boolean;
    fileManager?: boolean;
    fileEditor?: boolean;
    fileDownload?: boolean;
    fileUpload?: boolean;
    agentCatalog?: { id: string; label: string }[];
    piProvider?: string;
    piModel?: string;
    cursorCommands?: string[];
  }>("/api/admin/agents", {
    method: "PUT",
    body: JSON.stringify({ ...flags, rawTerminal, cliImport, fileManager, fileEditor, fileDownload, fileUpload, ...extra }),
  });
}

export function setupPi() {
  return api<Session>("/api/pi/setup", { method: "POST" });
}

export interface HarnessApplyResult {
  applied: { username: string; model: boolean; commands: boolean }[];
  skipped: { username: string; reason: string }[];
}

export function applyAgentDefaults(agent: "pi" | "cursor", username?: string) {
  return api<HarnessApplyResult>("/api/admin/agent-defaults", {
    method: "POST",
    body: JSON.stringify(username ? { agent, username } : { agent }),
  });
}

export function getCursorCommands() {
  return api<{ commands: string[] }>("/api/cursor-commands");
}

export function saveCursorCommands(commands: string[]) {
  return api<{ commands: string[] }>("/api/cursor-commands", {
    method: "PUT",
    body: JSON.stringify({ commands }),
  });
}

export function getUserCursorCommands(username: string) {
  return api<{ commands: string[] }>(`/api/admin/users/${encodeURIComponent(username)}/cursor-commands`);
}

export function saveUserCursorCommands(username: string, commands: string[]) {
  return api<{ commands: string[] }>(`/api/admin/users/${encodeURIComponent(username)}/cursor-commands`, {
    method: "PUT",
    body: JSON.stringify({ commands }),
  });
}

export function cancelChat(id: string) {
  return api<{ ok: boolean }>(`/api/chats/${id}/cancel`, { method: "POST" });
}

export interface ExtensionLists {
  site: ExtensionRecord[];
  user: ExtensionRecord[];
}

export interface ExtensionDocPage {
  title: string;
  markdown: string;
}

export function listExtensions() {
  return api<ExtensionLists>("/api/extensions");
}

export function installExtension(source: string, scope: "site" | "user") {
  const path = scope === "site" ? "/api/admin/extensions" : "/api/extensions";
  return api<ExtensionRecord>(path, { method: "POST", body: JSON.stringify({ source }) });
}

export function updateExtension(name: string, scope: "site" | "user") {
  const path = scope === "site" ? `/api/admin/extensions/${name}/update` : `/api/extensions/${name}/update`;
  return api<ExtensionRecord>(path, { method: "POST" });
}

export function removeExtension(name: string, scope: "site" | "user") {
  const path = scope === "site" ? `/api/admin/extensions/${name}` : `/api/extensions/${name}`;
  return api<{ ok: boolean }>(path, { method: "DELETE" });
}

export function setExtensionEnabled(name: string, enabled: boolean, scope: "site" | "user") {
  const path = scope === "site" ? `/api/admin/extensions/${name}/enabled` : `/api/extensions/${name}/enabled`;
  return api<ExtensionRecord>(path, { method: "POST", body: JSON.stringify({ enabled }) });
}

export function listAdminExtensions() {
  return api<{ packages: ExtensionRecord[] }>("/api/admin/extensions");
}

export function readExtensionDoc(scope: "site" | "user", name: string, id: string) {
  return api<ExtensionDocPage>(`/api/extensions/docs/${scope}/${name}/${id}`);
}

export type { ExtensionDoc };
