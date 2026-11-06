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

/** Folder that holds `path`, or "" for an entry at the repository root. */
export function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** Last segment of `path`. */
export function baseName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
}

/**
 * Turns what was typed in the rename field into the new repository path.
 * A bare name stays in the same folder, so the common case is one edit;
 * anything with a slash is a move to that path.
 */
export function renameTargetPath(fromPath: string, typed: string): string {
  const cleaned = typed.trim().replace(/^\/+|\/+$/g, "");
  if (!cleaned) return "";
  if (cleaned.includes("/")) return cleaned;
  const parent = parentPath(fromPath);
  return parent ? `${parent}/${cleaned}` : cleaned;
}

/** Where the selection ends so the extension stays out of it: `Button|.tsx`. */
export function stemEnd(name: string): number {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? dot : name.length;
}

/** Message for a name that cannot be used, or null when it is fine. */
export function renamePathError(typed: string): string | null {
  const cleaned = typed.trim().replace(/^\/+|\/+$/g, "");
  if (!cleaned) return "Enter a name.";
  if (cleaned.includes("\0")) return "That name is not allowed.";
  if (cleaned.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    return "That name is not allowed.";
  }
  return null;
}
