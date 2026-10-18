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
): { directory: string; visibility: FileVisibility } {
  if (!file) throw new Error("repository folder is not configured");
  const clean = assertRepoDirectory(directory);
  const nextVisibility = visibility ? parseFileVisibility(visibility) : loadFileVisibility(file);
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ directory: clean, visibility: nextVisibility }, null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, file);
  return { directory: clean, visibility: nextVisibility };
}
