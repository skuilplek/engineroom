import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseAgentCatalog, type AgentDefinition } from "@engineroom/protocol";
import { dataRoot, ensureRoot } from "./store.ts";

function catalogFile(home: string): string {
  return path.join(dataRoot(home), "agent-catalog.json");
}

export async function loadAgentCatalog(home: string): Promise<AgentDefinition[]> {
  try {
    return parseAgentCatalog(JSON.parse(await readFile(catalogFile(home), "utf8")));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || error instanceof SyntaxError) return [];
    if (error instanceof Error && error.message.startsWith("invalid")) return [];
    throw error;
  }
}

export async function saveAgentCatalog(home: string, agents: AgentDefinition[]): Promise<AgentDefinition[]> {
  const next = parseAgentCatalog(agents);
  await ensureRoot(home);
  const file = catalogFile(home);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  return next;
}
