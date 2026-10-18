import { constants, readFileSync } from "node:fs";
import { access, stat, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_COMMANDS = ["node", "git", "caddy", "agent", "claude", "claude-agent-acp", "pi", "obscura"];
export const SYSTEM_COMMAND_DIRS = ["/usr/local/bin", "/usr/bin", "/bin"];
const DISK_PATHS = ["/", "/var/lib/engineroom"];
const COMMAND_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const COMMAND_LIMIT = 40;

export interface ServerOverview {
  configFile: string;
  host: {
    hostname: string;
    platform: string;
    arch: string;
    node: string;
    uptimeSeconds: number;
    memoryFree: number;
    memoryTotal: number;
  };
  disks: { path: string; total: number; free: number }[];
  commands: { name: string; available: boolean; path: string | null }[];
}

export function loadCheckCommands(file: string): string[] {
  if (!file) return [...DEFAULT_COMMANDS];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { commands?: unknown };
    if (!Array.isArray(parsed.commands)) return [...DEFAULT_COMMANDS];
    const names: string[] = [];
    for (const item of parsed.commands) {
      if (names.length >= COMMAND_LIMIT) break;
      if (typeof item !== "string" || !COMMAND_RE.test(item) || names.includes(item)) continue;
      names.push(item);
    }
    return names;
  } catch {
    return [...DEFAULT_COMMANDS];
  }
}

export async function serverOverview(options: {
  configFile: string;
  commandDirs?: string[];
  diskPaths?: string[];
}): Promise<ServerOverview> {
  const names = loadCheckCommands(options.configFile);
  const dirs = options.commandDirs ?? SYSTEM_COMMAND_DIRS;
  const commands = [];
  for (const name of names) {
    const found = await findCommand(name, dirs);
    commands.push({ name, available: found !== null, path: found });
  }
  return {
    configFile: options.configFile,
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      node: process.version,
      uptimeSeconds: Math.floor(os.uptime()),
      memoryFree: os.freemem(),
      memoryTotal: os.totalmem(),
    },
    disks: await diskUsage(options.diskPaths ?? DISK_PATHS),
    commands,
  };
}

export async function findCommand(name: string, dirs: string[]): Promise<string | null> {
  if (name.startsWith("/")) {
    return executable(name);
  }
  for (const dir of dirs) {
    const found = await executable(path.join(dir, name));
    if (found) return found;
  }
  return null;
}

async function executable(full: string): Promise<string | null> {
  try {
    await access(full, constants.X_OK);
    const info = await stat(full);
    if (info.isFile() && (info.mode & 0o111) !== 0) return full;
  } catch {
    return null;
  }
  return null;
}

async function diskUsage(paths: string[]): Promise<ServerOverview["disks"]> {
  const seen = new Set<number>();
  const rows: ServerOverview["disks"] = [];
  for (const target of paths) {
    try {
      const info = await stat(target);
      if (seen.has(info.dev)) continue;
      seen.add(info.dev);
      const space = await statfs(target);
      const block = Number(space.bsize);
      rows.push({
        path: target,
        total: Number(space.blocks) * block,
        free: Number(space.bavail) * block,
      });
    } catch {
      continue;
    }
  }
  return rows;
}
