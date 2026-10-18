import type {
  AgentId,
  CatalogEntry,
  ChatDetail,
  ChatMeta,
  EnvEntry,
  RepositoryEntry,
  Settings,
  SettingsPatch,
  UserAccess,
  UserPolicy,
} from "@engineroom/protocol";

export interface Session {
  username: string;
  home: string;
  admin: boolean;
  agents: AgentId[];
  rawTerminal: boolean;
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

export function createChat(input: { agent?: string; model?: string; workspace?: string; title?: string }) {
  return api<ChatMeta>("/api/chats", { method: "POST", body: JSON.stringify(input) });
}

export function getSettings() {
  return api<Settings>("/api/settings");
}

export function saveSettings(settings: Settings) {
  return api<Settings>("/api/settings", { method: "PUT", body: JSON.stringify(settings) });
}

export function listRepositories() {
  return api<RepositoryEntry[]>("/api/repositories");
}

export function listCatalog() {
  return api<{ repositories: CatalogEntry[] }>("/api/admin/catalog");
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

export function listAccounts() {
  return api<Account[]>("/api/admin/users");
}

export function addAccount(username: string, password: string) {
  return api<{ ok: boolean }>("/api/admin/users", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export function removeAccount(username: string) {
  return api<{ ok: boolean }>(`/api/admin/users/${encodeURIComponent(username)}/remove`, { method: "POST" });
}

export function saveAgents(flags: Record<AgentId, boolean>, rawTerminal?: boolean) {
  return api<{ agents: AgentId[]; rawTerminal?: boolean }>("/api/admin/agents", {
    method: "PUT",
    body: JSON.stringify({ ...flags, rawTerminal }),
  });
}

export function cancelChat(id: string) {
  return api<{ ok: boolean }>(`/api/chats/${id}/cancel`, { method: "POST" });
}
