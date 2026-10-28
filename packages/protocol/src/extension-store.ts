import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  assertContributionsFree,
  emptyReserved,
  isExtensionSlug,
  MAX_EXTENSION_CSS_BYTES,
  MAX_EXTENSION_DOC_BYTES,
  MAX_EXTENSION_FILE_BYTES,
  MAX_EXTENSION_FILES,
  MAX_EXTENSION_MANIFEST_BYTES,
  parseExtensionManifest,
  parseExtensionSource,
  type ExtensionManifest,
  type ExtensionRecord,
  type ExtensionScope,
  type ReservedIds,
} from "./extensions.ts";

const execFileAsync = promisify(execFile);

interface IndexEntry {
  name: string;
  source: string;
  commit: string | null;
  enabled: boolean;
  scope: ExtensionScope;
}

export function extensionDir(root: string): string {
  return path.join(root, "extensions");
}

export function extensionIndexFile(root: string): string {
  return path.join(root, "extensions.json");
}

export async function listExtensions(root: string, scope: ExtensionScope): Promise<ExtensionRecord[]> {
  if (!root) return [];
  const index = await readIndex(root);
  const records: ExtensionRecord[] = [];
  for (const entry of index) {
    records.push(await hydrate(root, { ...entry, scope }, scope));
  }
  return records;
}

export async function installExtension(root: string, scope: ExtensionScope, source: string): Promise<ExtensionRecord> {
  assertRoot(root);
  const parsed = parseExtensionSource(source);
  const index = await readIndex(root);
  const staging = path.join(root, `.extension-staging-${randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    const commit = await materialize(parsed, staging, root);
    const manifest = await readManifest(staging);
    if (index.some((entry) => entry.name === manifest.name)) throw new Error("extension already exists");
    await publish(root, staging, manifest.name);
    const entry: IndexEntry = { name: manifest.name, source: source.trim(), commit, enabled: false, scope };
    await writeIndex(root, [...index, entry]);
    return recordFrom(entry, manifest);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function updateExtension(root: string, scope: ExtensionScope, name: string): Promise<ExtensionRecord> {
  assertRoot(root);
  if (!isExtensionSlug(name)) throw new Error("invalid extension name");
  const index = await readIndex(root);
  const current = index.find((entry) => entry.name === name);
  if (!current) throw new Error("extension not found");
  const parsed = parseExtensionSource(current.source);
  const staging = path.join(root, `.extension-staging-${randomUUID()}`);
  try {
    const commit = await materialize(parsed, staging, root);
    const manifest = await readManifest(staging);
    if (manifest.name !== name) throw new Error("invalid extension name");
    if (current.enabled) assertContributionsFree(manifest, await listExtensions(root, scope));
    await rm(packageDir(root, name), { recursive: true, force: true });
    await publish(root, staging, name);
    const entry: IndexEntry = { ...current, commit, scope };
    await writeIndex(root, index.map((item) => (item.name === name ? entry : item)));
    return recordFrom(entry, manifest);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function removeExtension(root: string, name: string): Promise<void> {
  assertRoot(root);
  if (!isExtensionSlug(name)) throw new Error("invalid extension name");
  const index = await readIndex(root);
  if (!index.some((entry) => entry.name === name)) throw new Error("extension not found");
  await rm(packageDir(root, name), { recursive: true, force: true });
  await writeIndex(root, index.filter((entry) => entry.name !== name));
}

export async function setExtensionEnabled(
  root: string,
  scope: ExtensionScope,
  name: string,
  enabled: boolean,
  reserved: ReservedIds = emptyReserved(),
): Promise<ExtensionRecord> {
  assertRoot(root);
  if (!isExtensionSlug(name)) throw new Error("invalid extension name");
  const index = await readIndex(root);
  const current = index.find((entry) => entry.name === name);
  if (!current) throw new Error("extension not found");
  const manifest = await readManifest(packageDir(root, name));
  if (manifest.name !== name) throw new Error("invalid extension name");
  if (enabled) assertContributionsFree(manifest, await listExtensions(root, scope), reserved);
  const entry: IndexEntry = { ...current, enabled, scope };
  await writeIndex(root, index.map((item) => (item.name === name ? entry : item)));
  return recordFrom(entry, manifest);
}

export async function readScopedTheme(root: string, scope: ExtensionScope, themeId: string): Promise<string | null> {
  if (!root || !isExtensionSlug(themeId)) return null;
  for (const record of await listExtensions(root, scope)) {
    const css = await themeCss(root, record, themeId);
    if (css != null) return css;
  }
  return null;
}

export async function readExtensionDoc(
  root: string,
  scope: ExtensionScope,
  name: string,
  docId: string,
): Promise<{ title: string; markdown: string }> {
  if (!root) throw new Error("extensions are not configured");
  if (!isExtensionSlug(name) || !isExtensionSlug(docId)) throw new Error("invalid extension doc");
  const record = (await listExtensions(root, scope)).find((item) => item.name === name && item.enabled && !item.error);
  const doc = record?.docs.find((item) => item.id === docId);
  if (!record || !doc) throw new Error("extension doc not found");
  const markdown = await readPackageFile(packageDir(root, name), doc.file, MAX_EXTENSION_DOC_BYTES);
  return { title: doc.title, markdown };
}

async function themeCss(root: string, record: ExtensionRecord, themeId: string): Promise<string | null> {
  if (!record.enabled || record.error) return null;
  const theme = record.themes.find((item) => item.id === themeId);
  if (!theme) return null;
  return readPackageFile(packageDir(root, record.name), theme.file, MAX_EXTENSION_CSS_BYTES);
}

async function hydrate(root: string, entry: IndexEntry, scope: ExtensionScope): Promise<ExtensionRecord> {
  try {
    const manifest = await readManifest(packageDir(root, entry.name));
    if (manifest.name !== entry.name) return broken(entry, scope, "invalid extension name");
    return recordFrom({ ...entry, scope }, manifest);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid extension manifest";
    return broken(entry, scope, message);
  }
}

function recordFrom(entry: IndexEntry, manifest: ExtensionManifest): ExtensionRecord {
  return {
    name: entry.name,
    source: entry.source,
    commit: entry.commit,
    enabled: entry.enabled,
    scope: entry.scope,
    version: manifest.version,
    description: manifest.description,
    themes: manifest.themes,
    docs: manifest.docs,
    agents: manifest.agents,
  };
}

function broken(entry: IndexEntry, scope: ExtensionScope, error: string): ExtensionRecord {
  return {
    name: entry.name,
    source: entry.source,
    commit: entry.commit,
    enabled: false,
    scope,
    version: "",
    description: "",
    themes: [],
    docs: [],
    agents: [],
    error,
  };
}

async function materialize(
  source: { kind: "path"; path: string } | { kind: "git"; url: string },
  dest: string,
  root: string,
): Promise<string | null> {
  await rm(dest, { recursive: true, force: true });
  if (source.kind === "git") {
    await git(["clone", "--depth", "1", "--no-recurse-submodules", source.url, dest]);
    const { stdout } = await git(["rev-parse", "HEAD"], dest);
    await guardTree(dest);
    return stdout.trim() || null;
  }
  const from = await realpath(path.resolve(source.path));
  const info = await lstat(from);
  if (!info.isDirectory()) throw new Error("invalid extension source");
  const extensions = await realpath(extensionDir(root)).catch(() => path.resolve(extensionDir(root)));
  if (from === extensions || from.startsWith(`${extensions}${path.sep}`)) throw new Error("invalid extension source");
  await mkdir(path.dirname(dest), { recursive: true });
  await cp(from, dest, { recursive: true, errorOnExist: false });
  await guardTree(dest);
  return null;
}

async function publish(root: string, staging: string, name: string) {
  const dir = extensionDir(root);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const dest = packageDir(root, name);
  await rm(dest, { recursive: true, force: true });
  await rename(staging, dest);
}

async function guardTree(dir: string) {
  const base = await realpath(dir);
  let count = 0;
  async function walk(current: string) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      count += 1;
      if (count > MAX_EXTENSION_FILES) throw new Error("extension file is too large");
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await realpath(full).catch(() => "");
        if (!target || (target !== base && !target.startsWith(`${base}${path.sep}`))) throw new Error("invalid extension file");
        const linked = await lstat(target);
        if (!linked.isDirectory() && linked.size > MAX_EXTENSION_FILE_BYTES) throw new Error("extension file is too large");
        continue;
      }
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) throw new Error("invalid extension file");
      const info = await lstat(full);
      if (info.size > MAX_EXTENSION_FILE_BYTES) throw new Error("extension file is too large");
    }
  }
  await walk(base);
}

async function readManifest(dir: string): Promise<ExtensionManifest> {
  const file = path.join(dir, "engineroom.json");
  const info = await lstat(file);
  if (!info.isFile() || info.size > MAX_EXTENSION_MANIFEST_BYTES) throw new Error("invalid extension manifest");
  await confined(dir, file);
  return parseExtensionManifest(JSON.parse(await readFile(file, "utf8")));
}

function extensionFilePath(packageDir: string, relative: string): string {
  const root = path.resolve(packageDir);
  const full = path.resolve(root, relative);
  if (full !== root && !full.startsWith(`${root}${path.sep}`)) throw new Error("invalid extension file");
  return full;
}

async function readPackageFile(dir: string, relative: string, max: number): Promise<string> {
  const full = extensionFilePath(dir, relative);
  const info = await lstat(full);
  if (!info.isFile() || info.size > max) throw new Error("extension file is too large");
  await confined(dir, full);
  const text = await readFile(full, "utf8");
  if (text.includes("\0")) throw new Error("invalid extension file");
  return text;
}

async function confined(dir: string, file: string) {
  const base = await realpath(dir);
  const full = await realpath(file);
  if (full !== base && !full.startsWith(`${base}${path.sep}`)) throw new Error("invalid extension file");
}

async function readIndex(root: string): Promise<IndexEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(extensionIndexFile(root), "utf8")) as { packages?: unknown };
    if (!parsed || !Array.isArray(parsed.packages)) return [];
    const entries: IndexEntry[] = [];
    for (const item of parsed.packages) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      if (!isExtensionSlug(record.name) || typeof record.source !== "string") continue;
      entries.push({
        name: record.name,
        source: record.source,
        commit: typeof record.commit === "string" ? record.commit : null,
        enabled: record.enabled === true,
        scope: record.scope === "site" ? "site" : "user",
      });
    }
    return entries;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [];
  }
}

async function writeIndex(root: string, packages: IndexEntry[]) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const file = extensionIndexFile(root);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ packages }, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

function packageDir(root: string, name: string): string {
  if (!isExtensionSlug(name)) throw new Error("invalid extension name");
  return path.join(extensionDir(root), name);
}

function assertRoot(root: string) {
  if (!root || !path.isAbsolute(root)) throw new Error("extensions are not configured");
}

async function git(args: string[], cwd?: string): Promise<{ stdout: string }> {
  try {
    const result = await execFileAsync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    return { stdout: String(result.stdout ?? "") };
  } catch (error) {
    const stderr = error instanceof Error && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
    const line = stderr.trim().split("\n").pop()?.trim();
    throw new Error(line ? `invalid extension source: ${line.slice(0, 200)}` : "invalid extension source");
  }
}
