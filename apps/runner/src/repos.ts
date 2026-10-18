import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isInsidePath, type CatalogEntry, type RepositoryEntry } from "@engineroom/protocol";
import { gitClone } from "./clone.ts";
import { listRepositories, setEnabledRepositories } from "./store.ts";
import { isGitRepository } from "./workspace.ts";

export type CloneRepository = (url: string, dest: string) => Promise<void>;

function grantsFile(home: string): string {
  return path.join(home, ".engineroom", "grants.json");
}

export async function loadGrants(home: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(grantsFile(home), "utf8")) as { ids?: unknown };
    if (!Array.isArray(parsed.ids)) return [];
    return parsed.ids.filter((id): id is string => typeof id === "string");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    if (error instanceof SyntaxError) return [];
    throw error;
  }
}

export async function syncGrantedRepositories(
  home: string,
  repos: CatalogEntry[],
  clone: CloneRepository = gitClone,
): Promise<{ grants: string[]; repositories: RepositoryEntry[] }> {
  const homeReal = await realpath(home);
  const sites = path.join(homeReal, "Sites");
  await mkdir(sites, { recursive: true });
  const sitesReal = await realpath(sites);
  if (!isInsidePath(homeReal, sitesReal) || sitesReal === homeReal) throw new Error("invalid repository");
  const enabled: string[] = [];
  for (const repo of repos) {
    const dest = path.join(sitesReal, repo.name);
    if (!isInsidePath(sitesReal, dest) || dest === sitesReal) throw new Error("invalid repository");
    if (await exists(dest)) {
      if (!(await isGitRepository(dest))) throw new Error("invalid repository");
    } else {
      await clone(repo.url, dest);
      if (!(await isGitRepository(dest))) throw new Error("clone failed");
    }
    const resolved = await realpath(dest);
    if (!isInsidePath(sitesReal, resolved) || resolved === sitesReal) throw new Error("invalid repository");
    enabled.push(resolved);
  }
  await setEnabledRepositories(home, enabled);
  const ids = repos.map((repo) => repo.id);
  const file = grantsFile(home);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ ids }, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
  return { grants: ids, repositories: await listRepositories(home) };
}

async function exists(file: string): Promise<boolean> {
  try {
    const info = await stat(file);
    return info.isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
