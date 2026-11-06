/**
 * Helpers for keeping the files pane in sync after a file or folder rename.
 * A renamed folder moves everything below it, so every path the pane holds
 * (selection, open editor, expanded folders, reveal target) has to follow.
 */

/** Rewrites `path` when it is `from` or lives inside the `from` folder. */
export function remapPath(path: string, from: string, to: string): string {
  if (!path || !from) return path;
  if (path === from) return to;
  const prefix = `${from}/`;
  if (path.startsWith(prefix)) return `${to}${path.slice(from.length)}`;
  return path;
}

/** Remaps every entry of a path set, collapsing duplicates. */
export function remapPathSet(paths: Iterable<string>, from: string, to: string): Set<string> {
  const next = new Set<string>();
  for (const path of paths) next.add(remapPath(path, from, to));
  return next;
}

/** True when `path` is `from` or lives inside it, so a rename affects it. */
export function isInsideRenamed(path: string, from: string): boolean {
  if (!path || !from) return false;
  return path === from || path.startsWith(`${from}/`);
}
