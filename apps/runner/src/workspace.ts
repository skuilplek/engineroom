import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isInsidePath, type WorkspaceEntry } from "@engineroom/protocol";

const SKIP = new Set(["node_modules", "vendor", "dist", "build"]);
const DEFAULT_REPO_DIRECTORY = "Sites";

export async function resolveWorkspace(home: string, requested?: string): Promise<string> {
  const homeReal = await realpath(home);
  const raw = requested?.trim() ? requested.trim() : homeReal;
  const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(homeReal, raw);
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch {
    throw new Error("workspace does not exist");
  }
  if (!isInsidePath(homeReal, resolved)) {
    throw new Error("workspace must stay inside the home directory");
  }
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error("workspace must be a directory");
  return resolved;
}

export function repositoryPathAllowed(homeReal: string, resolved: string, directory = DEFAULT_REPO_DIRECTORY): boolean {
  const sites = path.resolve(homeReal, directory);
  if (!isInsidePath(sites, resolved) || resolved === sites) return false;
  const rel = path.relative(sites, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  return !rel.split(path.sep).some((segment) => segment.startsWith(".") || SKIP.has(segment));
}

export async function isGitRepository(dir: string): Promise<boolean> {
  try {
    const info = await stat(path.join(dir, ".git"));
    return info.isDirectory() || info.isFile();
  } catch {
    return false;
  }
}

export async function listGitRepositories(home: string, directory = DEFAULT_REPO_DIRECTORY, depth = 6): Promise<WorkspaceEntry[]> {
  const root = await realpath(home);
  let sites: string;
  try {
    sites = await realpath(path.resolve(root, directory));
  } catch {
    return [];
  }
  if (!isInsidePath(root, sites) || sites === root) return [];
  const found: WorkspaceEntry[] = [];
  const seen = new Set<string>();

  function add(resolved: string) {
    if (seen.has(resolved) || resolved === sites || found.length >= 200) return;
    seen.add(resolved);
    found.push({ path: resolved, name: path.relative(sites, resolved) || path.basename(resolved) });
  }

  async function walk(dir: string, level: number) {
    if (level >= depth || found.length >= 200) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (found.length >= 200) return;
      if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      let resolved: string;
      try {
        resolved = await realpath(full);
      } catch {
        continue;
      }
      if (!isInsidePath(sites, resolved) || resolved === sites) continue;
      let info;
      try {
        info = await stat(resolved);
      } catch {
        continue;
      }
      if (!info.isDirectory()) continue;
      if (await isGitRepository(resolved)) {
        add(resolved);
        continue;
      }
      if (entry.isSymbolicLink()) continue;
      await walk(resolved, level + 1);
    }
  }

  await walk(sites, 0);
  found.sort((a, b) => a.name.localeCompare(b.name));
  return found;
}

export async function listWorkspaces(home: string, depth = 3): Promise<WorkspaceEntry[]> {
  const root = await realpath(home);
  const found: WorkspaceEntry[] = [{ path: root, name: path.basename(root) || root }];

  async function walk(dir: string, level: number) {
    if (level > depth || found.length >= 200) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (found.length >= 200) return;
      if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          const target = await realpath(full);
          if (!isInsidePath(root, target)) continue;
          const info = await stat(target);
          if (!info.isDirectory()) continue;
          found.push({ path: target, name: path.relative(root, target) || entry.name });
        } catch {
          continue;
        }
        continue;
      }
      if (!entry.isDirectory()) continue;
      found.push({ path: full, name: path.relative(root, full) });
      await walk(full, level + 1);
    }
  }

  await walk(root, 1);
  return found;
}
