import { CHAT_ID_RE, type ChatMeta } from "@engineroom/protocol";

type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storageKey(username: string) {
  return `engineroom.lastChat.${username}`;
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
