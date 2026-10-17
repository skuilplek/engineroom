import type { ChatDetail, ChatMeta, Settings, StreamEvent, WorkspaceEntry } from "@engineroom/protocol";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
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
  return api<{ username: string; home: string }>("/api/me");
}

export function login(username: string, password: string) {
  return api<{ username: string; home: string }>("/api/login", {
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

export function listWorkspaces() {
  return api<WorkspaceEntry[]>("/api/workspaces");
}

export function cancelChat(id: string) {
  return api<{ ok: boolean }>(`/api/chats/${id}/cancel`, { method: "POST" });
}

export async function sendMessage(
  chatId: string,
  prompt: string,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
    signal,
  });
  if (!response.ok || !response.body) {
    let message = response.statusText || "send failed";
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* ignore */
    }
    throw new ApiError(response.status, message);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";
    for (const chunk of chunks) {
      const data = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data) continue;
      onEvent(JSON.parse(data) as StreamEvent);
    }
  }
}
