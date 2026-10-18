import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  assertCatalogId,
  assertCatalogName,
  assertGitUrl,
  type CatalogEntry,
} from "@engineroom/protocol";

export function loadCatalog(file: string): CatalogEntry[] {
  if (!file) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { repositories?: unknown };
    if (!Array.isArray(parsed.repositories)) return [];
    const entries: CatalogEntry[] = [];
    for (const item of parsed.repositories) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      try {
        entries.push({
          id: assertCatalogId(record.id),
          name: assertCatalogName(record.name),
          url: assertGitUrl(record.url),
        });
      } catch {
        continue;
      }
    }
    return entries;
  } catch {
    return [];
  }
}

export function addCatalogEntry(file: string, name: string, url: string): CatalogEntry {
  if (!file) throw new Error("catalog is not configured");
  const entries = loadCatalog(file);
  const cleanName = assertCatalogName(name);
  const cleanUrl = assertGitUrl(url);
  if (entries.some((entry) => entry.name === cleanName)) throw new Error("repository name is taken");
  if (entries.length >= 200) throw new Error("invalid repositories");
  const entry = { id: randomUUID(), name: cleanName, url: cleanUrl };
  writeCatalog(file, [...entries, entry]);
  return entry;
}

export function removeCatalogEntry(file: string, id: string): CatalogEntry[] {
  if (!file) throw new Error("catalog is not configured");
  const cleanId = assertCatalogId(id);
  const entries = loadCatalog(file).filter((entry) => entry.id !== cleanId);
  writeCatalog(file, entries);
  return entries;
}

function writeCatalog(file: string, entries: CatalogEntry[]) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ repositories: entries }, null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, file);
}
