import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertCatalogName,
  assertGitUrl,
  assertRepoDirectory,
  isInsidePath,
  type CatalogEntry,
  type RepositoryEntry,
} from "@engineroom/protocol";
import { gitClone, gitInit } from "./clone.ts";
import { detectRepositories, listRepositories } from "./store.ts";
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
  directory = "Sites",
): Promise<{ grants: string[]; repositories: RepositoryEntry[] }> {
  const homeReal = await realpath(home);
  const sites = path.resolve(homeReal, directory);
  await mkdir(sites, { recursive: true });
  const sitesReal = await realpath(sites);
  if (!isInsidePath(homeReal, sitesReal) || sitesReal === homeReal) throw new Error("invalid repository");
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
  }
  await detectRepositories(home, directory);
  const ids = repos.map((repo) => repo.id);
  const file = grantsFile(home);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ ids }, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
  return { grants: ids, repositories: await listRepositories(home) };
}

export async function createRepository(
  home: string,
  name: string,
  directory = "Sites",
  url?: string,
  clone: CloneRepository = gitClone,
): Promise<RepositoryEntry> {
  const cleanName = assertCatalogName(name.trim());
  const cleanDir = assertRepoDirectory(directory);
  const remote = url?.trim() ? assertGitUrl(url) : "";
  const homeReal = await realpath(home);
  const sites = path.resolve(homeReal, cleanDir);
  await mkdir(sites, { recursive: true });
  const sitesReal = await realpath(sites);
  if (!isInsidePath(homeReal, sitesReal) || sitesReal === homeReal) throw new Error("invalid repository");
  const dest = path.join(sitesReal, cleanName);
  if (!isInsidePath(sitesReal, dest) || dest === sitesReal) throw new Error("invalid repository");
  if (await pathExists(dest)) throw new Error("repository already exists");
  try {
    if (remote) await clone(remote, dest);
    else await gitInit(dest);
    if (!(await isGitRepository(dest))) throw new Error("repository creation failed");
    const resolved = await realpath(dest);
    if (!isInsidePath(sitesReal, resolved) || resolved === sitesReal) throw new Error("invalid repository");
  } catch (error) {
    await discardIncomplete(dest).catch(() => undefined);
    throw error;
  }
  const repositories = await detectRepositories(home, cleanDir);
  const created = repositories.find((entry) => entry.name === cleanName && entry.enabled);
  if (!created) throw new Error("repository creation failed");
  return created;
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function discardIncomplete(dest: string): Promise<void> {
  let info;
  try {
    info = await lstat(dest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink()) {
    await unlink(dest);
    return;
  }
  if (await isGitRepository(dest)) return;
  await rm(dest, { recursive: true, force: true });
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
