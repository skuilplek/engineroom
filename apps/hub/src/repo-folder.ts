import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { assertRepoDirectory } from "@engineroom/protocol";

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

export function saveRepoDirectory(file: string, directory: string): string {
  if (!file) throw new Error("repository folder is not configured");
  const clean = assertRepoDirectory(directory);
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ directory: clean }, null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, file);
  return clean;
}
