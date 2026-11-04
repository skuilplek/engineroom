type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

function storageKey(username: string) {
  return `engineroom.collapsedProjects.${username}`;
}

function browserStorage(): KeyValueStore | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function readCollapsedProjects(username: string, store: KeyValueStore | null = browserStorage()): Set<string> {
  if (!username || !store) return new Set();
  let raw: string | null;
  try {
    raw = store.getItem(storageKey(username));
  } catch {
    return new Set();
  }
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === "string" && value.length > 0));
  } catch {
    return new Set();
  }
}

export function writeCollapsedProjects(
  username: string,
  projects: Iterable<string>,
  store: KeyValueStore | null = browserStorage(),
) {
  if (!username || !store) return;
  try {
    store.setItem(storageKey(username), JSON.stringify([...projects]));
  } catch {
    /* storage can be blocked */
  }
}
