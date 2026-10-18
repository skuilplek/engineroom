import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { AGENTS, type AgentId } from "@engineroom/protocol";

export type AgentFlags = Record<AgentId, boolean>;

export const DEFAULT_APP_NAME = "AgentWrapper";
const APP_NAME_MAX = 64;

export function parseAppName(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid app name");
  const name = value.trim();
  if (!name || name.length > APP_NAME_MAX || /[\u0000-\u001f]/.test(name)) throw new Error("invalid app name");
  return name;
}

export function allAgentsOn(): AgentFlags {
  return { cursor: true, claude: true, pi: true };
}

export function loadAgentFlags(file: string): AgentFlags {
  if (!file) return allAgentsOn();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const flags = allAgentsOn();
    let seen = false;
    for (const agent of AGENTS) {
      if (typeof parsed[agent] === "boolean") {
        flags[agent] = parsed[agent];
        seen = true;
      }
    }
    if (!seen || !AGENTS.some((agent) => flags[agent])) return allAgentsOn();
    return flags;
  } catch {
    return allAgentsOn();
  }
}

export function enabledAgentIds(flags: AgentFlags): AgentId[] {
  return AGENTS.filter((agent) => flags[agent]);
}

export function flagsFromBody(body: unknown): AgentFlags {
  if (!body || typeof body !== "object") throw new Error("invalid agents");
  const record = body as Record<string, unknown>;
  const flags = allAgentsOn();
  for (const agent of AGENTS) {
    if (typeof record[agent] !== "boolean") throw new Error("invalid agents");
    flags[agent] = record[agent];
  }
  return flags;
}

export function loadRawTerminal(file: string): boolean {
  if (!file) return true;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { rawTerminal?: unknown };
    if (typeof parsed.rawTerminal === "boolean") return parsed.rawTerminal;
  } catch {
    /* default on */
  }
  return true;
}

export function loadCliImport(file: string): boolean {
  if (!file) return false;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { cliImport?: unknown };
    if (typeof parsed.cliImport === "boolean") return parsed.cliImport;
  } catch {
    /* default off */
  }
  return false;
}

export function loadAppName(file: string): string {
  if (!file) return DEFAULT_APP_NAME;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { appName?: unknown };
    return parseAppName(parsed.appName);
  } catch {
    return DEFAULT_APP_NAME;
  }
}

export function saveAppName(file: string, name: string): string {
  const appName = parseAppName(name);
  const current = readAgentFile(file);
  writeAgentFile(file, { ...current, appName });
  return appName;
}

export function saveAgentFlags(file: string, flags: AgentFlags, rawTerminal?: boolean, cliImport?: boolean): AgentFlags {
  const next = flagsFromBody(flags);
  if (!AGENTS.some((agent) => next[agent])) throw new Error("at least one agent must stay on");
  const terminal = typeof rawTerminal === "boolean" ? rawTerminal : loadRawTerminal(file);
  const imports = typeof cliImport === "boolean" ? cliImport : loadCliImport(file);
  writeAgentFile(file, { ...next, rawTerminal: terminal, cliImport: imports, appName: loadAppName(file) });
  return next;
}

function readAgentFile(file: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* start from the fields being saved */
  }
  return {};
}

function writeAgentFile(file: string, body: Record<string, unknown>) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(body)}\n`, { mode: 0o644 });
  renameSync(tmp, file);
}
