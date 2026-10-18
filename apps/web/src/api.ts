import type { AgentId, ChatDetail, ChatMeta, RepositoryEntry, Settings } from "@engineroom/protocol";

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

export function listUserRepositories(username: string) {
  return api<RepositoryEntry[]>(`/api/admin/users/${encodeURIComponent(username)}/repositories`);
}

export function saveUserRepositories(username: string, enabled: string[]) {
  return api<RepositoryEntry[]>(`/api/admin/users/${encodeURIComponent(username)}/repositories`, {
    method: "PUT",
    body: JSON.stringify({ enabled }),
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

export function revokeAccount(username: string) {
  return api<{ ok: boolean }>(`/api/admin/users/${encodeURIComponent(username)}/revoke`, { method: "POST" });
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
