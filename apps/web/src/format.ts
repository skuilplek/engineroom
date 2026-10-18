import type { ChatMeta, RepositoryEntry } from "@engineroom/protocol";

export interface RepoGroup {
  key: string;
  label: string;
  path: string;
  chats: ChatMeta[];
  canStart: boolean;
  time?: string;
  marked: boolean;
}

export function buildGroups(chats: ChatMeta[], repos: RepositoryEntry[], home: string, query = ""): RepoGroup[] {
  const needle = query.trim().toLowerCase();
  const homeKey = strip(home);
  const homeIsRepo = repos.some((repo) => strip(repo.path) === homeKey);
  const listed = homeIsRepo ? chats : chats.filter((chat) => strip(chat.workspace) !== homeKey);
  const visible = needle
    ? listed.filter((chat) => chat.title.toLowerCase().includes(needle) || chat.workspace.toLowerCase().includes(needle))
    : listed;
  const buckets = new Map<string, ChatMeta[]>();
  for (const chat of visible) {
    const key = strip(chat.workspace);
    const list = buckets.get(key) ?? [];
    list.push(chat);
    buckets.set(key, list);
  }
  const newestKey = visible[0] ? strip(visible[0].workspace) : "";
  function take(key: string, label: string, canStart: boolean): RepoGroup {
    const items = buckets.get(key) ?? [];
    buckets.delete(key);
    return {
      key,
      label,
      path: key,
      chats: items,
      canStart,
      time: items[0] ? relativeTime(items[0].updatedAt) : undefined,
      marked: items.some((chat) => chat.running) || (newestKey !== "" && newestKey === key),
    };
  }
  const groups: RepoGroup[] = [];
  for (const repo of [...repos].sort((a, b) => a.name.localeCompare(b.name))) {
    groups.push(take(strip(repo.path), repo.name, true));
  }
  for (const [key, items] of [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const label = key.split("/").filter(Boolean).pop() || key;
    groups.push({
      key,
      label,
      path: key,
      chats: items,
      canStart: false,
      time: items[0] ? relativeTime(items[0].updatedAt) : undefined,
      marked: items.some((chat) => chat.running) || newestKey === key,
    });
  }
  return groups.filter((group) => !needle || group.chats.length > 0 || group.label.toLowerCase().includes(needle));
}

export function workspaceLabel(workspace: string, home: string, repos: RepositoryEntry[]): string {
  if (strip(workspace) === strip(home)) return "No repository";
  return repos.find((repo) => strip(repo.path) === strip(workspace))?.name
    || workspace.split("/").filter(Boolean).pop()
    || workspace;
}

export function strip(value: string): string {
  return value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
}

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const delta = Math.max(0, Date.now() - then);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return "just now";
  if (delta < hour) return `${Math.round(delta / minute)}m ago`;
  if (delta < day) return `${Math.round(delta / hour)}h ago`;
  const days = Math.round(delta / day);
  if (days < 14) return `${days}d ago`;
  return `${Math.round(days / 7)}w ago`;
}

export function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "request failed";
}
