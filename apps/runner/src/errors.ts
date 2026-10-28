import { randomUUID } from "node:crypto";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_ACTION_ERRORS, type ActionError } from "@engineroom/protocol";
import { dataRoot, ensureRoot } from "./store.ts";

const FILE = "errors.jsonl";

let chain: Promise<unknown> = Promise.resolve();

function withLock<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

export function listActionErrors(home: string): Promise<ActionError[]> {
  return withLock(() => readErrors(home));
}

export function appendActionError(home: string, action: string, message: string): Promise<ActionError> {
  return withLock(async () => {
    await ensureRoot(home);
    const entry: ActionError = {
      id: randomUUID(),
      at: new Date().toISOString(),
      action,
      message,
    };
    const next = [entry, ...(await readErrors(home))].slice(0, MAX_ACTION_ERRORS);
    await writeErrors(home, next);
    return entry;
  });
}

export function deleteActionError(home: string, id: string): Promise<void> {
  return withLock(async () => {
    const current = await readErrors(home);
    await writeErrors(home, current.filter((item) => item.id !== id));
  });
}

export function clearActionErrors(home: string): Promise<void> {
  return withLock(async () => {
    await ensureRoot(home);
    await rm(errorFile(home), { force: true });
  });
}

function errorFile(home: string): string {
  return path.join(dataRoot(home), FILE);
}

async function readErrors(home: string): Promise<ActionError[]> {
  let text = "";
  try {
    text = await readFile(errorFile(home), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries: ActionError[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parsed = parseStored(line);
    if (parsed) entries.push(parsed);
  }
  return entries;
}

function parseStored(line: string): ActionError | null {
  try {
    const value = JSON.parse(line) as Partial<ActionError>;
    if (!value || typeof value.id !== "string" || typeof value.at !== "string") return null;
    if (typeof value.action !== "string" || typeof value.message !== "string") return null;
    if (!value.id || !value.action || !value.message) return null;
    return { id: value.id, at: value.at, action: value.action, message: value.message };
  } catch {
    return null;
  }
}

async function writeErrors(home: string, entries: ActionError[]): Promise<void> {
  const file = errorFile(home);
  if (entries.length === 0) {
    await rm(file, { force: true });
    return;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600 });
  await rename(tmp, file);
  await chmod(file, 0o600);
}
