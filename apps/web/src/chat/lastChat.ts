import { CHAT_ID_RE, type ChatMeta } from "@engineroom/protocol";

type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storageKey(username: string) {
  return `engineroom.lastChat.${username}`;
}

function projectStorageKey(username: string) {
  return `engineroom.lastChats.${username}`;
}

function normalizeWorkspace(workspace: string): string {
  return workspace.length > 1 && workspace.endsWith("/") ? workspace.slice(0, -1) : workspace;
}

function browserStorage(): KeyValueStore | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function readLastChat(username: string, store: KeyValueStore | null = browserStorage()): string | null {
  if (!username || !store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(storageKey(username));
  } catch {
    return null;
  }
  if (!raw) return null;
  if (!CHAT_ID_RE.test(raw)) {
    forgetLastChat(username, store);
    return null;
  }
  return raw;
}

export function writeLastChat(username: string, chatId: string, store: KeyValueStore | null = browserStorage()) {
  if (!username || !store || !CHAT_ID_RE.test(chatId)) return;
  try {
    store.setItem(storageKey(username), chatId);
  } catch {
    /* storage can be blocked */
  }
}

export function forgetLastChat(username: string, store: KeyValueStore | null = browserStorage()) {
  if (!username || !store) return;
  try {
    store.removeItem(storageKey(username));
  } catch {
    /* storage can be blocked */
  }
}

export function pickLastChat(chats: readonly ChatMeta[], storedId: string | null): ChatMeta | null {
  if (!storedId || !CHAT_ID_RE.test(storedId)) return null;
  return chats.find((chat) => chat.id === storedId) ?? null;
}

export function readLastChatFor(
  username: string,
  workspace: string,
  store: KeyValueStore | null = browserStorage(),
): string | null {
  if (!username || !workspace || !store) return null;
  return readChatMap(username, store)[normalizeWorkspace(workspace)] ?? null;
}

/** Record the chat globally and as the last chat for its project. */
export function writeLastChatFor(
  username: string,
  workspace: string,
  chatId: string,
  store: KeyValueStore | null = browserStorage(),
) {
  if (!username || !store || !CHAT_ID_RE.test(chatId)) return;
  writeLastChat(username, chatId, store);
  if (!workspace) return;
  const map = readChatMap(username, store);
  map[normalizeWorkspace(workspace)] = chatId;
  writeChatMap(username, map, store);
}

/** Remove a chat from the global pointer and every project pointer. */
export function forgetChat(username: string, chatId: string | null, store: KeyValueStore | null = browserStorage()) {
  if (!username || !chatId || !store) return;
  if (readLastChat(username, store) === chatId) forgetLastChat(username, store);
  const map = readChatMap(username, store);
  let changed = false;
  for (const [workspace, stored] of Object.entries(map)) {
    if (stored !== chatId) continue;
    delete map[workspace];
    changed = true;
  }
  if (changed) writeChatMap(username, map, store);
}

function readChatMap(username: string, store: KeyValueStore): Record<string, string> {
  let raw: string | null;
  try {
    raw = store.getItem(projectStorageKey(username));
  } catch {
    return {};
  }
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const map: Record<string, string> = {};
    for (const [workspace, value] of Object.entries(parsed)) {
      if (workspace && typeof value === "string" && CHAT_ID_RE.test(value)) map[workspace] = value;
    }
    return map;
  } catch {
    return {};
  }
}

function writeChatMap(username: string, map: Record<string, string>, store: KeyValueStore) {
  try {
    store.setItem(projectStorageKey(username), JSON.stringify(map));
  } catch {
    /* storage can be blocked */
  }
}
