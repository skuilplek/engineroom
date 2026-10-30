/** Keep these aligned with THEMES and AGENTS in index.ts. */
export const EXTENSION_THEME_IDS = ["dark", "light", "haxor", "midnight", "engine", "pi"] as const;
export const EXTENSION_AGENT_IDS = ["cursor", "pi"] as const;

export const EXTENSION_SLUG_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const MAX_EXTENSION_MANIFEST_BYTES = 64 * 1024;
export const MAX_EXTENSION_CSS_BYTES = 256 * 1024;
export const MAX_EXTENSION_DOC_BYTES = 256 * 1024;
export const MAX_EXTENSION_FILES = 200;
export const MAX_EXTENSION_FILE_BYTES = 2 * 1024 * 1024;

const COMMAND_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;
const GIT_URL_RE = /^(https?:\/\/|ssh:\/\/|git:\/\/)[A-Za-z0-9._~:/?#@%+=&-]+$/;
const GIT_SCP_RE = /^git@[A-Za-z0-9._-]+:[A-Za-z0-9._~/-]+$/;
const GIT_HOST_PATH_RE = /^(?:[A-Za-z0-9.-]+\.)+[A-Za-z]{2,}\/[A-Za-z0-9._~/-]+$/;

export type ExtensionScope = "site" | "user";

export interface ThemeSwatches {
  bg: string;
  sidebar: string;
  panel: string;
  accent: string;
  ink: string;
  border: string;
}

export interface ExtensionTheme {
  id: string;
  name: string;
  tagline: string;
  tier: "simple" | "elaborate";
  file: string;
  swatches: ThemeSwatches;
}

export interface ExtensionDoc {
  id: string;
  title: string;
  file: string;
}

export interface ExtensionAgent {
  id: string;
  label: string;
  binary: string;
}

export interface ExtensionManifest {
  name: string;
  version: string;
  description: string;
  themes: ExtensionTheme[];
  docs: ExtensionDoc[];
  agents: ExtensionAgent[];
}

export interface ExtensionRecord {
  name: string;
  source: string;
  commit: string | null;
  enabled: boolean;
  scope: ExtensionScope;
  version: string;
  description: string;
  themes: ExtensionTheme[];
  docs: ExtensionDoc[];
  agents: ExtensionAgent[];
  error?: string;
}

export interface ReservedIds {
  themes: string[];
  docs: string[];
  agents: string[];
}

export function emptyReserved(): ReservedIds {
  return { themes: [], docs: [], agents: [] };
}

export function isExtensionSlug(value: unknown): value is string {
  return typeof value === "string" && EXTENSION_SLUG_RE.test(value);
}

export function parseExtensionSource(value: unknown): { kind: "path"; path: string } | { kind: "git"; url: string } {
  if (typeof value !== "string") throw new Error("invalid extension source");
  const source = value.trim();
  if (!source || source.length > 500 || /[\u0000-\u001f]/.test(source)) throw new Error("invalid extension source");
  if (source.startsWith("git:")) return { kind: "git", url: gitUrl(source.slice(4)) };
  if (GIT_URL_RE.test(source) || GIT_SCP_RE.test(source)) return { kind: "git", url: source };
  if (source.startsWith("/") && !source.includes("\0")) return { kind: "path", path: source };
  throw new Error("invalid extension source");
}

export function parseExtensionManifest(value: unknown): ExtensionManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid extension manifest");
  const body = value as Record<string, unknown>;
  if (!isExtensionSlug(body.name)) throw new Error("invalid extension name");
  if (typeof body.version !== "string" || !VERSION_RE.test(body.version)) throw new Error("invalid extension version");
  const description = cleanText(body.description ?? "", "extension description", 240, true);
  const themes = parseThemes(body.themes);
  const docs = parseDocs(body.docs);
  const agents = parseAgents(body.agents);
  return { name: body.name, version: body.version, description, themes, docs, agents };
}

export function assertContributionsFree(manifest: ExtensionManifest, others: readonly ExtensionRecord[], reserved: ReservedIds = emptyReserved()) {
  const themes = new Set<string>([...EXTENSION_THEME_IDS, ...reserved.themes]);
  const docs = new Set<string>(reserved.docs);
  const agents = new Set<string>([...EXTENSION_AGENT_IDS, ...reserved.agents]);
  for (const other of others) {
    if (!other.enabled || other.error || other.name === manifest.name) continue;
    for (const theme of other.themes) themes.add(theme.id);
    for (const doc of other.docs) docs.add(doc.id);
    for (const agent of other.agents) agents.add(agent.id);
  }
  for (const theme of manifest.themes) {
    if (themes.has(theme.id)) throw new Error(`theme ${theme.id} is already in use`);
    themes.add(theme.id);
  }
  for (const doc of manifest.docs) {
    if (docs.has(doc.id)) throw new Error(`doc ${doc.id} is already in use`);
    docs.add(doc.id);
  }
  for (const agent of manifest.agents) {
    if (agents.has(agent.id)) throw new Error(`agent ${agent.id} is already in use`);
    agents.add(agent.id);
  }
}

export function parseSlugList(value: unknown, label: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 80) throw new Error(`invalid ${label}`);
  const ids: string[] = [];
  for (const item of value) {
    if (!isExtensionSlug(item) || ids.includes(item)) throw new Error(`invalid ${label}`);
    ids.push(item);
  }
  return ids;
}

function gitUrl(value: string): string {
  const rest = value.trim();
  if (GIT_URL_RE.test(rest) || GIT_SCP_RE.test(rest)) return rest;
  if (GIT_HOST_PATH_RE.test(rest)) return rest.endsWith(".git") ? `https://${rest}` : `https://${rest}.git`;
  throw new Error("invalid extension source");
}

function parseThemes(value: unknown): ExtensionTheme[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 40) throw new Error("invalid extension theme");
  const themes: ExtensionTheme[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid extension theme");
    const record = item as Record<string, unknown>;
    if (!isExtensionSlug(record.id) || seen.has(record.id)) throw new Error("invalid extension theme");
    if ((EXTENSION_THEME_IDS as readonly string[]).includes(record.id)) throw new Error("invalid extension theme");
    const tier = record.tier === "elaborate" ? "elaborate" : record.tier === "simple" ? "simple" : "";
    if (!tier) throw new Error("invalid extension theme");
    seen.add(record.id);
    themes.push({
      id: record.id,
      name: cleanText(record.name, "extension theme", 64, false),
      tagline: cleanText(record.tagline, "extension theme", 80, false),
      tier,
      file: parseRelativeFile(record.file, ".css"),
      swatches: parseSwatches(record.swatches),
    });
  }
  return themes;
}

function parseDocs(value: unknown): ExtensionDoc[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 40) throw new Error("invalid extension doc");
  const docs: ExtensionDoc[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid extension doc");
    const record = item as Record<string, unknown>;
    if (!isExtensionSlug(record.id) || seen.has(record.id)) throw new Error("invalid extension doc");
    seen.add(record.id);
    docs.push({
      id: record.id,
      title: cleanText(record.title, "extension doc", 80, false),
      file: parseRelativeFile(record.file, ".md"),
    });
  }
  return docs;
}

function parseAgents(value: unknown): ExtensionAgent[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 40) throw new Error("invalid extension agent");
  const agents: ExtensionAgent[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid extension agent");
    const record = item as Record<string, unknown>;
    if (!isExtensionSlug(record.id) || seen.has(record.id)) throw new Error("invalid extension agent");
    if ((EXTENSION_AGENT_IDS as readonly string[]).includes(record.id)) throw new Error("invalid extension agent");
    seen.add(record.id);
    agents.push({
      id: record.id,
      label: cleanText(record.label, "extension agent", 64, false),
      binary: parseCommand(record.binary),
    });
  }
  return agents;
}

function parseSwatches(value: unknown): ThemeSwatches {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid extension theme");
  const record = value as Record<string, unknown>;
  const swatches = {} as ThemeSwatches;
  for (const key of ["bg", "sidebar", "panel", "accent", "ink", "border"] as const) {
    if (typeof record[key] !== "string" || !COLOR_RE.test(record[key])) throw new Error("invalid extension theme");
    swatches[key] = record[key];
  }
  return swatches;
}

function parseRelativeFile(value: unknown, suffix: string): string {
  if (typeof value !== "string") throw new Error("invalid extension file");
  const file = value.trim();
  if (!file || file.length > 200 || file.startsWith("/") || file.includes("\\") || file.includes("\0")) {
    throw new Error("invalid extension file");
  }
  const parts = file.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw new Error("invalid extension file");
  if (suffix && !file.endsWith(suffix)) throw new Error("invalid extension file");
  return file;
}

function parseCommand(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid extension agent");
  const command = value.trim();
  if (COMMAND_RE.test(command)) return command;
  if (
    command.startsWith("/") &&
    command.length <= 4096 &&
    !command.includes("\0") &&
    !command.includes("..") &&
    !/[\u0000-\u001f\s]/.test(command)
  ) {
    return command;
  }
  throw new Error("invalid extension agent");
}

function cleanText(value: unknown, label: string, max: number, allowEmpty: boolean): string {
  if (typeof value !== "string") throw new Error(`invalid ${label}`);
  const text = value.trim();
  if ((!text && !allowEmpty) || text.length > max || /[\u0000-\u001f]/.test(text)) throw new Error(`invalid ${label}`);
  return text;
}
