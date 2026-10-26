import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  assertRepoDirectory,
  DEFAULT_FILE_VISIBILITY,
  parseFileVisibility,
  type FileVisibility,
} from "@engineroom/protocol";

export function loadRepoDirectory(file: string): string {
  if (!file) return "Sites";
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { directory?: unknown };
    if (typeof parsed.directory !== "string" || !parsed.directory.trim()) return "Sites";
    return assertRepoDirectory(parsed.directory);
  } catch (error) {
    if (error instanceof Error && error.message === "invalid repository folder") return "Sites";
    return "Sites";
  }
}

export function loadProjectCreate(file: string): boolean {
  if (!file) return false;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { projectCreate?: unknown };
    return parsed.projectCreate === true;
  } catch {
    return false;
  }
}

export function loadProjectDownloads(file: string): boolean {
  if (!file) return false;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { projectDownloads?: unknown };
    return parsed.projectDownloads === true;
  } catch {
    return false;
  }
}

export function loadFileVisibility(file: string): FileVisibility {
  if (!file) return { ...DEFAULT_FILE_VISIBILITY };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { visibility?: unknown };
    if (!parsed || typeof parsed !== "object" || parsed.visibility == null) {
      return { ...DEFAULT_FILE_VISIBILITY };
    }
    return parseFileVisibility(parsed.visibility);
  } catch {
    return { ...DEFAULT_FILE_VISIBILITY };
  }
}

export function saveRepoDirectory(
  file: string,
  directory: string,
  visibility?: FileVisibility,
  projectCreate?: boolean,
  projectDownloads?: boolean,
): { directory: string; visibility: FileVisibility; projectCreate: boolean; projectDownloads: boolean } {
  if (!file) throw new Error("repository folder is not configured");
  const clean = assertRepoDirectory(directory);
  const nextVisibility = visibility ? parseFileVisibility(visibility) : loadFileVisibility(file);
  const nextCreate = typeof projectCreate === "boolean" ? projectCreate : loadProjectCreate(file);
  const nextDownloads = typeof projectDownloads === "boolean" ? projectDownloads : loadProjectDownloads(file);
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(
    tmp,
    `${JSON.stringify({ directory: clean, visibility: nextVisibility, projectCreate: nextCreate, projectDownloads: nextDownloads }, null, 2)}\n`,
    { mode: 0o644 },
  );
  renameSync(tmp, file);
  return { directory: clean, visibility: nextVisibility, projectCreate: nextCreate, projectDownloads: nextDownloads };
}
