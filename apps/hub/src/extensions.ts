import path from "node:path";
import { EXTENSION_AGENT_IDS, type AgentDefinition, type AgentName, type ExtensionRecord, type ExtensionTheme, type ReservedIds } from "@engineroom/protocol";
import { listExtensions } from "@engineroom/protocol/extensions";
import { loadCustomAgents } from "./agents.ts";

export function siteExtensionRoot(agentsFile: string): string {
  return agentsFile ? path.dirname(path.resolve(agentsFile)) : "";
}

export async function siteExtensionRecords(agentsFile: string): Promise<ExtensionRecord[]> {
  const root = siteExtensionRoot(agentsFile);
  if (!root) return [];
  return listExtensions(root, "site");
}

export function enabledPackageAgents(records: readonly ExtensionRecord[]): Array<AgentDefinition & { packageName: string }> {
  const agents: Array<AgentDefinition & { packageName: string }> = [];
  for (const record of records) {
    if (!record.enabled || record.error) continue;
    for (const agent of record.agents) {
      agents.push({ id: agent.id, label: agent.label, binary: agent.binary, packageName: record.name });
    }
  }
  return agents;
}

export function packageAgentNames(records: readonly ExtensionRecord[]): AgentName[] {
  return enabledPackageAgents(records).map((agent) => ({ id: agent.id, label: agent.label }));
}

export function enabledThemes(records: readonly ExtensionRecord[]): ExtensionTheme[] {
  const themes: ExtensionTheme[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (!record.enabled || record.error) continue;
    for (const theme of record.themes) {
      if (seen.has(theme.id)) continue;
      seen.add(theme.id);
      themes.push(theme);
    }
  }
  return themes;
}

export async function siteReserved(agentsFile: string): Promise<ReservedIds> {
  const records = await siteExtensionRecords(agentsFile);
  const custom = agentsFile ? loadCustomAgents(agentsFile).map((agent) => agent.id) : [];
  const enabled = records.filter((record) => record.enabled && !record.error);
  return {
    themes: enabled.flatMap((record) => record.themes.map((theme) => theme.id)),
    docs: enabled.flatMap((record) => record.docs.map((doc) => doc.id)),
    agents: [...EXTENSION_AGENT_IDS, ...custom, ...enabled.flatMap((record) => record.agents.map((agent) => agent.id))],
  };
}
