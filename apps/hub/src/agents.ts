import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  AGENT_CATALOG,
  AGENTS,
  agentLabel,
  agentSlug,
  isAgentId,
  isBuiltinAgent,
  parseAgentCommand,
  parseAgentLabel,
  parsePiValue,
  type AgentDefinition,
  type AgentId,
  type PiAuth,
} from "@engineroom/protocol";
import { findCommand, SYSTEM_COMMAND_DIRS } from "./overview.ts";

export type AgentFlags = Record<string, boolean>;

export interface CustomAgent extends AgentDefinition {
  enabled: boolean;
}

export interface ListedAgent extends AgentDefinition {
  builtin: boolean;
  available: boolean;
  path: string | null;
  enabled: boolean;
}

export const DEFAULT_APP_NAME = "AgentWrapper";
const APP_NAME_MAX = 64;

export function parseAppName(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid app name");
  const name = value.trim();
  if (!name || name.length > APP_NAME_MAX || /[\u0000-\u001f]/.test(name)) throw new Error("invalid app name");
  return name;
}

export function allAgentsOn(): AgentFlags {
  const flags: AgentFlags = {};
  for (const agent of AGENTS) flags[agent] = true;
  return flags;
}

export function loadCustomAgents(file: string): CustomAgent[] {
  if (!file) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { customAgents?: unknown };
    return parseCustomAgents(parsed.customAgents);
  } catch {
    return [];
  }
}

export function customCatalog(file: string): AgentDefinition[] {
  return loadCustomAgents(file).map(({ id, label, binary }) => ({ id, label, binary }));
}

export function loadAgentFlags(file: string): AgentFlags {
  if (!file) return allAgentsOn();
  const custom = loadCustomAgents(file);
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
    for (const agent of custom) flags[agent.id] = agent.enabled;
    const any = Object.values(flags).some(Boolean);
    if (!seen || !any) return withCustom(allAgentsOn(), custom, false);
    return flags;
  } catch {
    return withCustom(allAgentsOn(), custom, false);
  }
}

export function enabledAgentIds(flags: AgentFlags, custom: CustomAgent[] = []): AgentId[] {
  return [...AGENTS, ...custom.map((agent) => agent.id)].filter((agent) => flags[agent]);
}

export function flagsFromBody(body: unknown, customIds: string[] = []): AgentFlags {
  if (!body || typeof body !== "object") throw new Error("invalid agents");
  const record = body as Record<string, unknown>;
  const flags = allAgentsOn();
  for (const agent of AGENTS) {
    if (typeof record[agent] !== "boolean") throw new Error("invalid agents");
    flags[agent] = record[agent];
  }
  for (const id of customIds) {
    if (typeof record[id] === "boolean") flags[id] = record[id];
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

export function loadFileManager(file: string): boolean {
  if (!file) return false;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { fileManager?: unknown };
    if (typeof parsed.fileManager === "boolean") return parsed.fileManager;
  } catch {
    /* default off */
  }
  return false;
}

export function loadFileEditor(file: string): boolean {
  if (!file) return true;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { fileEditor?: unknown };
    if (typeof parsed.fileEditor === "boolean") return parsed.fileEditor;
  } catch {
    /* default on */
  }
  return true;
}

export function loadFileDownload(file: string): boolean {
  if (!file) return false;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { fileDownload?: unknown };
    if (typeof parsed.fileDownload === "boolean") return parsed.fileDownload;
  } catch {
    /* default off */
  }
  return false;
}

export function loadFileUpload(file: string): boolean {
  if (!file) return false;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { fileUpload?: unknown };
    if (typeof parsed.fileUpload === "boolean") return parsed.fileUpload;
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

export function saveAgentFlags(
  file: string,
  body: unknown,
  rawTerminal?: boolean,
  cliImport?: boolean,
  fileManager?: boolean,
  fileEditor?: boolean,
  fileDownload?: boolean,
  fileUpload?: boolean,
): AgentFlags {
  const custom = loadCustomAgents(file);
  const parsed = flagsFromBody(body, custom.map((agent) => agent.id));
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const previous = loadAgentFlags(file);
  const next: AgentFlags = { ...previous };
  for (const agent of AGENTS) next[agent] = parsed[agent] ?? false;
  for (const agent of custom) {
    if (typeof record[agent.id] === "boolean") next[agent.id] = Boolean(parsed[agent.id]);
  }
  if (!Object.values(next).some(Boolean)) throw new Error("at least one agent must stay on");
  const pi = piFieldsFromBody(record, loadPiConfig(file));
  const terminal = typeof rawTerminal === "boolean" ? rawTerminal : loadRawTerminal(file);
  const imports = typeof cliImport === "boolean" ? cliImport : loadCliImport(file);
  const files = typeof fileManager === "boolean" ? fileManager : loadFileManager(file);
  const editor = typeof fileEditor === "boolean" ? fileEditor : loadFileEditor(file);
  const download = typeof fileDownload === "boolean" ? fileDownload : loadFileDownload(file);
  const upload = typeof fileUpload === "boolean" ? fileUpload : loadFileUpload(file);
  const current = readAgentFile(file);
  writeAgentFile(file, {
    ...current,
    cursor: Boolean(next.cursor),
    claude: Boolean(next.claude),
    pi: Boolean(next.pi),
    rawTerminal: terminal,
    cliImport: imports,
    fileManager: files,
    fileEditor: editor,
    fileDownload: download,
    fileUpload: upload,
    piInstall: pi.install,
    piAuth: pi.auth,
    piProvider: pi.provider,
    piModel: pi.model,
    appName: loadAppName(file),
    customAgents: custom.map((agent) => ({ ...agent, enabled: Boolean(next[agent.id]) })),
  });
  return next;
}

export function addCustomAgent(file: string, label: string, binary: string): CustomAgent {
  const name = parseAgentLabel(label);
  const command = parseAgentCommand(binary);
  const id = agentSlug(name);
  if (isBuiltinAgent(id)) throw new Error(`${name} is a built-in agent. Offer it from its tab.`);
  const existing = loadCustomAgents(file);
  if (existing.some((agent) => agent.id === id)) throw new Error("an agent with that name already exists");
  const next: CustomAgent = { id, label: name, binary: command, enabled: false };
  const current = readAgentFile(file);
  const flags = loadAgentFlags(file);
  writeAgentFile(file, {
    ...current,
    cursor: flags.cursor !== false,
    claude: flags.claude !== false,
    pi: flags.pi !== false,
    customAgents: [...existing, next],
  });
  return next;
}

export function removeCustomAgent(file: string, id: string): CustomAgent[] {
  if (!isAgentId(id) || isBuiltinAgent(id)) throw new Error("invalid agent");
  const existing = loadCustomAgents(file);
  if (!existing.some((agent) => agent.id === id)) throw new Error("invalid agent");
  const next = existing.filter((agent) => agent.id !== id);
  const current = readAgentFile(file);
  writeAgentFile(file, { ...current, customAgents: next });
  return next;
}

export async function listAgents(file: string, dirs: string[] = SYSTEM_COMMAND_DIRS): Promise<ListedAgent[]> {
  const flags = loadAgentFlags(file);
  const custom = loadCustomAgents(file);
  const specs = [
    ...AGENT_CATALOG.map((agent) => ({ ...agent, builtin: true })),
    ...custom.map((agent) => ({ id: agent.id, label: agent.label, binary: agent.binary, builtin: false })),
  ];
  const found = await Promise.all(specs.map((spec) => findCommand(spec.binary, dirs)));
  return specs.map((spec, index) => ({
    ...spec,
    available: found[index] !== null,
    path: found[index] ?? null,
    enabled: Boolean(flags[spec.id]),
  }));
}

// Names a launch will actually try. Claude's ACP adapter is a different command
// from the CLI, and either one means the agent is installed for this account.
export function detectionNames(agent: { id: string; binary: string }): string[] {
  const names = [agent.binary];
  if (agent.id === "claude" && agent.binary === "claude") names.push("claude-agent-acp");
  return [...new Set(names)];
}

export function withResolvedCommands(listed: ListedAgent[], resolved: ReadonlyMap<string, string>): ListedAgent[] {
  return listed.map((agent) => {
    if (agent.available) return agent;
    for (const name of detectionNames(agent)) {
      const found = resolved.get(name);
      if (found) return { ...agent, available: true, path: found };
    }
    return agent;
  });
}

export function offeredAgentIds(flags: AgentFlags, listed: ListedAgent[]): AgentId[] {
  const availableCustom = new Set(listed.filter((agent) => !agent.builtin && agent.available).map((agent) => agent.id));
  return listed
    .map((agent) => agent.id)
    .filter((id) => {
      if (!flags[id]) return false;
      if (isBuiltinAgent(id)) return true;
      return availableCustom.has(id);
    });
}

// Agents a person can start. An enabled command that is not installed for them
// is omitted, unless an absolute binary override for that account resolves.
export function usableAgentIds(
  flags: AgentFlags,
  listed: ListedAgent[],
  allowed: readonly AgentId[],
  overrides: Partial<Record<string, string>> = {},
  resolvedOverrides: ReadonlyMap<string, string> = new Map(),
): AgentId[] {
  const offerable = new Set(offeredAgentIds(flags, listed));
  const byId = new Map(listed.map((agent) => [agent.id, agent]));
  return allowed.filter((agent) => {
    if (!offerable.has(agent)) return false;
    if (byId.get(agent)?.available) return true;
    const override = overrides[agent];
    return Boolean(override && resolvedOverrides.has(override));
  });
}

export interface PiSiteConfig {
  install: "user" | "global";
  auth: PiAuth;
  provider: string;
  model: string;
}

export function loadPiConfig(file: string): PiSiteConfig {
  const fallback: PiSiteConfig = { install: "user", auth: "user", provider: "", model: "" };
  if (!file) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    return {
      install: parsed.piInstall === "global" ? "global" : "user",
      auth: parsed.piAuth === "shared" ? "shared" : "user",
      provider: typeof parsed.piProvider === "string" ? quietPiValue(parsed.piProvider) : "",
      model: typeof parsed.piModel === "string" ? quietPiValue(parsed.piModel) : "",
    };
  } catch {
    return fallback;
  }
}

export function piFieldsFromBody(body: unknown, current: PiSiteConfig): PiSiteConfig {
  if (!body || typeof body !== "object") return current;
  const record = body as Record<string, unknown>;
  const next = { ...current };
  if (record.piInstall != null) {
    if (record.piInstall !== "user" && record.piInstall !== "global") throw new Error("invalid pi install");
    next.install = record.piInstall;
  }
  if (record.piAuth != null) {
    if (record.piAuth !== "user" && record.piAuth !== "shared") throw new Error("invalid pi auth");
    next.auth = record.piAuth;
  }
  if (record.piProvider != null) next.provider = parsePiValue(record.piProvider, "pi provider");
  if (record.piModel != null) next.model = parsePiValue(record.piModel, "pi model");
  return next;
}

export function effectivePiAuth(site: PiSiteConfig, personal?: string): PiAuth {
  if (site.install !== "global") return "user";
  if (personal === "user" || personal === "shared") return personal;
  return site.auth;
}

export function piSetupAllowed(
  site: PiSiteConfig,
  enabled: boolean,
  allowed: boolean,
  personal: string | undefined,
  installed: boolean,
): boolean {
  if (!enabled || !allowed || installed) return false;
  return effectivePiAuth(site, personal) === "user";
}

function quietPiValue(value: string): string {
  return /^[A-Za-z0-9._:/-]*$/.test(value) && value.length <= 200 ? value : "";
}

export function namesFor(ids: AgentId[], file: string): { id: string; label: string }[] {
  const custom = loadCustomAgents(file);
  return ids.map((id) => ({ id, label: agentLabel(id, custom) }));
}

function withCustom(flags: AgentFlags, custom: CustomAgent[], enabled = false): AgentFlags {
  const next = { ...flags };
  for (const agent of custom) next[agent.id] = enabled ? agent.enabled : false;
  return next;
}

function parseCustomAgents(value: unknown): CustomAgent[] {
  if (value == null) return [];
  if (!Array.isArray(value)) return [];
  const agents: CustomAgent[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (agents.length >= 40) break;
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (!isAgentId(record.id) || isBuiltinAgent(record.id) || seen.has(record.id)) continue;
    let label = "";
    let binary = "";
    try {
      label = parseAgentLabel(record.label);
      binary = parseAgentCommand(record.binary);
    } catch {
      continue;
    }
    seen.add(record.id);
    agents.push({ id: record.id, label, binary, enabled: record.enabled === true });
  }
  return agents;
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
