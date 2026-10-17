import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isInsidePath, type WorkspaceEntry } from "@engineroom/protocol";

const SKIP = new Set(["node_modules", "vendor", "dist", "build"]);

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
