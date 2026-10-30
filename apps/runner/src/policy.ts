import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  defaultPolicy,
  parseUserPolicy,
  type AgentId,
  type Settings,
  type UserPolicy,
} from "@engineroom/protocol";

function policyFile(home: string): string {
  return path.join(home, ".engineroom", "policy.json");
}

export async function loadPolicy(home: string): Promise<UserPolicy> {
  try {
    return parseUserPolicy(JSON.parse(await readFile(policyFile(home), "utf8")));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || error instanceof SyntaxError) return defaultPolicy();
    if (error instanceof Error && /invalid|at least one agent/.test(error.message)) return defaultPolicy();
    throw error;
  }
}

export async function savePolicy(home: string, policy: UserPolicy): Promise<UserPolicy> {
  const next = parseUserPolicy(policy);
  const root = path.join(home, ".engineroom");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const file = policyFile(home);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
  return next;
}

export function withLocks(settings: Settings, _policy: UserPolicy, _home?: string): Settings {
  return { ...settings, lockedBinaries: [], binaryOverride: [] };
}

export function binaryFor(_policy: UserPolicy, settings: Settings, agent: AgentId, _home?: string): string | undefined {
  return settings.binaries[agent] || undefined;
}
