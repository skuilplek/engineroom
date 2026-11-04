import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { mergeCursorAcpConfig, mergeCursorConfig, mergePiDefaults, readShellCommands } from "@engineroom/protocol";

export function piSettingsPath(home: string): string {
  return path.join(home, ".pi", "agent", "settings.json");
}

export function cursorConfigPath(home: string): string {
  return path.join(home, ".cursor", "cli-config.json");
}

export function cursorAcpConfigPath(home: string): string {
  return path.join(home, ".cursor", "acp-config.json");
}

export async function applyPiDefaults(home: string, provider: string, model: string): Promise<void> {
  const file = piSettingsPath(home);
  const current = await readConfigObject(file);
  await writeConfigObject(file, mergePiDefaults(current.value, provider, model));
}

export async function applyCursorDefaults(
  home: string,
  patch: { writeModel?: boolean; commands?: string[] | null; fast?: boolean },
): Promise<void> {
  const file = cursorConfigPath(home);
  const current = await readConfigObject(file);
  const next = mergeCursorConfig(current.value, patch);
  if (!current.existed && next.version == null) next.version = 1;
  await writeConfigObject(file, next);
  if (patch.fast === undefined) return;
  const acpFile = cursorAcpConfigPath(home);
  const acpCurrent = await readConfigObject(acpFile);
  const acpNext = mergeCursorAcpConfig(acpCurrent.value, patch);
  if (!acpCurrent.existed && !patch.writeModel) return;
  if (JSON.stringify(acpNext) === JSON.stringify(acpCurrent.value)) return;
  await writeConfigObject(acpFile, acpNext);
}

export async function loadCursorCommands(home: string): Promise<string[]> {
  const current = await readConfigObject(cursorConfigPath(home));
  return readShellCommands(current.value);
}

async function readConfigObject(file: string): Promise<{ value: Record<string, unknown>; existed: boolean }> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid config");
    return { value: parsed as Record<string, unknown>, existed: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { value: {}, existed: false };
    if (error instanceof SyntaxError) throw new Error("invalid config");
    throw error;
  }
}

async function writeConfigObject(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
    await chmod(file, 0o600);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}
