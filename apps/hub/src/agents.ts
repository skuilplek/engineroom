import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { AGENTS, type AgentId } from "@engineroom/protocol";

export type AgentFlags = Record<AgentId, boolean>;

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

export function saveAgentFlags(file: string, flags: AgentFlags, rawTerminal?: boolean): AgentFlags {
  const next = flagsFromBody(flags);
  if (!AGENTS.some((agent) => next[agent])) throw new Error("at least one agent must stay on");
  const terminal = typeof rawTerminal === "boolean" ? rawTerminal : loadRawTerminal(file);
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...next, rawTerminal: terminal })}\n`, { mode: 0o644 });
  renameSync(tmp, file);
  return next;
}
