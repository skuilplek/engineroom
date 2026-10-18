import { readFileSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseEnvEntries, type EnvEntry } from "@engineroom/protocol";

const MAX_BYTES = 65_536;
const BLOCKED = new Set(["HOME", "USER", "LOGNAME", "SHELL", "PATH", "LD_PRELOAD", "LD_LIBRARY_PATH"]);

export function envPath(home: string): string {
  return path.join(home, ".env");
}

export function envKeyBlocked(key: string): boolean {
  return BLOCKED.has(key) || key.startsWith("LISTEN_");
}

export function readEnvEntries(text: string): EnvEntry[] {
  const entries: EnvEntry[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;
    const key = match[1]!;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ key, value: unquote(match[2] ?? "") });
  }
  return entries;
}

export function applyEnvEntries(text: string, entries: EnvEntry[]): string {
  const incoming = new Map(entries.map((entry) => [entry.key, entry.value]));
  const seen = new Set<string>();
  const output: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) {
      output.push(line);
      continue;
    }
    const key = match[1]!;
    if (!incoming.has(key) || seen.has(key)) continue;
    seen.add(key);
    output.push(formatEnvLine(key, incoming.get(key) ?? ""));
  }
  for (const entry of entries) {
    if (seen.has(entry.key)) continue;
    output.push(formatEnvLine(entry.key, entry.value));
  }
  const body = output.length === 0 ? "" : `${output.join("\n").replace(/\n$/, "")}\n`;
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("environment is too large");
  return body;
}

export async function loadEnv(home: string): Promise<EnvEntry[]> {
  try {
    const text = await readFile(envPath(home), "utf8");
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("environment is too large");
    return readEnvEntries(text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function saveEnv(home: string, entries: EnvEntry[]): Promise<EnvEntry[]> {
  const clean = parseEnvEntries(entries);
  const file = envPath(home);
  let current = "";
  try {
    current = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const next = applyEnvEntries(current, clean);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, next, { mode: 0o600 });
  await rename(tmp, file);
  return readEnvEntries(next);
}

export function readEnvFileSync(home: string): EnvEntry[] {
  try {
    const text = readFileSync(envPath(home), "utf8");
    if (Buffer.byteLength(text) > MAX_BYTES) return [];
    return readEnvEntries(text);
  } catch {
    return [];
  }
}

function formatEnvLine(key: string, value: string): string {
  if (value === "" || /^[A-Za-z0-9_./:@%+-]+$/.test(value)) return `${key}=${value}`;
  return `${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}
