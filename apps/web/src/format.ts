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

export function buildGroups(
  chats: ChatMeta[],
  repos: RepositoryEntry[],
  home: string,
  query = "",
  archived = false,
): RepoGroup[] {
  const needle = query.trim().toLowerCase();
  const homeKey = strip(home);
  const selected = repos.filter((repo) => Boolean(repo.archived) === archived);
  const enabled = new Set(selected.map((repo) => strip(repo.path)));
  const homeIsRepo = enabled.has(homeKey);
  const allowed = chats.filter((chat) => {
    const key = strip(chat.workspace);
    return enabled.has(key) || key === homeKey;
  });
  const listed = homeIsRepo ? allowed : allowed.filter((chat) => strip(chat.workspace) !== homeKey);
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
  for (const repo of [...selected].sort((a, b) => a.name.localeCompare(b.name))) {
    groups.push(take(strip(repo.path), repo.name, true));
  }
  return groups.filter((group) => !needle || group.chats.length > 0 || group.label.toLowerCase().includes(needle));
}

export function visibleProjectChats(
  chats: ChatMeta[],
  limit: number,
  activeId: string | null,
  options: { expanded: boolean; uncapped: boolean },
): { shown: ChatMeta[]; older: number } {
  const sorted = [...chats].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (options.uncapped || limit <= 0) return { shown: sorted, older: 0 };
  const capped = sorted.filter((chat, index) => index < limit || chat.id === activeId);
  const older = sorted.length - capped.length;
  if (options.expanded) return { shown: sorted, older };
  return { shown: capped, older };
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
