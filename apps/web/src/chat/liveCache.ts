import type { ChatLive } from "./state.ts";

const MAX_ENTRIES = 20;
const cache = new Map<string, ChatLive>();

function key(username: string, chatId: string) {
  return `${username}\0${chatId}`;
}

export function readCachedLive(username: string, chatId: string): ChatLive | undefined {
  const stored = cache.get(key(username, chatId));
  if (!stored) return undefined;
  // Refresh insertion order so the least recently used chat is evicted first.
  cache.delete(key(username, chatId));
  cache.set(key(username, chatId), stored);
  return stored;
}

export function writeCachedLive(username: string, chatId: string, live: ChatLive) {
  cache.delete(key(username, chatId));
  cache.set(key(username, chatId), live);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function forgetCachedLive(username: string, chatId: string) {
  cache.delete(key(username, chatId));
}

export function clearCachedLive(username: string) {
  const prefix = `${username}\0`;
  for (const stored of [...cache.keys()]) {
    if (stored.startsWith(prefix)) cache.delete(stored);
  }
}
