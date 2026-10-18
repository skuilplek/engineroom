import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  AGENTS,
  cleanModel,
  effectiveAgentOptions,
  isAgentId,
  parseOptionIds,
  type AgentId,
  type AgentOptionChoice,
  type AgentOptionList,
  type UserPolicy,
} from "@engineroom/protocol";

export interface AgentOptionCatalog {
  modes: AgentOptionChoice[];
  models: AgentOptionChoice[];
  probedAt: string;
}

export interface AgentOptionConfig {
  discovered: AgentOptionCatalog;
  offered: AgentOptionList;
}

export type AgentOptionsFile = Partial<Record<AgentId, AgentOptionConfig>>;

export function loadAgentOptions(file: string): AgentOptionsFile {
  if (!file) return {};
  try {
    return parseAgentOptions(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || error instanceof SyntaxError) return {};
    if (error instanceof Error && error.message.startsWith("invalid")) return {};
    throw error;
  }
}

export function recordProbe(
  file: string,
  agent: AgentId,
  found: { modes: AgentOptionChoice[]; models: AgentOptionChoice[] },
): AgentOptionConfig {
  const all = loadAgentOptions(file);
  const previous = all[agent]?.offered;
  const modes = choicesFrom(found.modes);
  const models = choicesFrom(found.models);
  const modeIds = new Set(modes.map((mode) => mode.id));
  const modelIds = new Set(models.map((model) => model.id));
  const next: AgentOptionConfig = {
    discovered: { modes, models, probedAt: new Date().toISOString() },
    offered: {
      modes: (previous?.modes ?? []).filter((id) => modeIds.has(id)),
      models: (previous?.models ?? []).filter((id) => modelIds.has(id)),
    },
  };
  all[agent] = next;
  writeAgentOptions(file, all);
  return next;
}

export function saveOfferedOptions(file: string, body: unknown): AgentOptionsFile {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid options");
  const all = loadAgentOptions(file);
  const record = body as Record<string, unknown>;
  for (const agent of optionAgentIds(record)) {
    if (record[agent] == null) continue;
    const current = all[agent];
    if (!current) throw new Error("invalid options");
    const raw = record[agent];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid options");
    const offered = raw as Record<string, unknown>;
    const modes = parseOptionIds(offered.modes, "mode");
    const models = parseOptionIds(offered.models, "model");
    const knownModes = new Set(current.discovered.modes.map((mode) => mode.id));
    const knownModels = new Set(current.discovered.models.map((model) => model.id));
    if (modes.some((id) => !knownModes.has(id)) || models.some((id) => !knownModels.has(id))) {
      throw new Error("invalid options");
    }
    current.offered = { modes, models };
  }
  writeAgentOptions(file, all);
  return all;
}

export function restrictPolicy(policy: UserPolicy, stored: AgentOptionsFile): UserPolicy {
  if (!policy.options) return policy;
  const options: NonNullable<UserPolicy["options"]> = {};
  for (const agent of policy.agents) {
    const personal = policy.options[agent];
    if (!personal) continue;
    const config = stored[agent];
    const allowed = effectiveAgentOptions(config?.discovered, config?.offered, undefined);
    const modes = new Set(allowed.modes.map((mode) => mode.id));
    const models = new Set(allowed.models.map((model) => model.id));
    options[agent] = {
      modes: personal.modes.filter((id) => modes.has(id)),
      models: personal.models.filter((id) => models.has(id)),
    };
  }
  return { ...policy, options };
}

export function choicesFrom(value: unknown): AgentOptionChoice[] {
  if (!Array.isArray(value)) return [];
  const choices: AgentOptionChoice[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    let id = "";
    try {
      id = cleanModel(record.id);
    } catch {
      continue;
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = typeof record.name === "string" && record.name.trim() ? record.name.trim().slice(0, 200) : id;
    const description = typeof record.description === "string" && record.description.trim()
      ? record.description.trim().slice(0, 500)
      : undefined;
    choices.push(description ? { id, name, description } : { id, name });
  }
  return choices;
}

function parseAgentOptions(value: unknown): AgentOptionsFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const options: AgentOptionsFile = {};
  for (const agent of optionAgentIds(value as Record<string, unknown>)) {
    const raw = (value as Record<string, unknown>)[agent];
    if (raw == null) continue;
    if (!isAgentId(agent) || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const discovered = record.discovered;
    if (!discovered || typeof discovered !== "object" || Array.isArray(discovered)) continue;
    const found = discovered as Record<string, unknown>;
    const offered = record.offered;
    const offeredRecord = offered && typeof offered === "object" && !Array.isArray(offered) ? (offered as Record<string, unknown>) : {};
    let modes: string[] = [];
    let models: string[] = [];
    try {
      modes = parseOptionIds(offeredRecord.modes ?? [], "mode");
      models = parseOptionIds(offeredRecord.models ?? [], "model");
    } catch {
      modes = [];
      models = [];
    }
    const catalogModes = choicesFrom(found.modes);
    const catalogModels = choicesFrom(found.models);
    const modeIds = new Set(catalogModes.map((mode) => mode.id));
    const modelIds = new Set(catalogModels.map((model) => model.id));
    options[agent] = {
      discovered: {
        modes: catalogModes,
        models: catalogModels,
        probedAt: typeof found.probedAt === "string" ? found.probedAt : "",
      },
      offered: {
        modes: modes.filter((id) => modeIds.has(id)),
        models: models.filter((id) => modelIds.has(id)),
      },
    };
  }
  return options;
}

function optionAgentIds(record: Record<string, unknown>): string[] {
  const ids: string[] = [...AGENTS];
  for (const key of Object.keys(record)) {
    if (isAgentId(key) && !ids.includes(key)) ids.push(key);
  }
  return ids;
}

function writeAgentOptions(file: string, options: AgentOptionsFile) {
  if (!file) throw new Error("invalid options");
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(options, null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, file);
}
