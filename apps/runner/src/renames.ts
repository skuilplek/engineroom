import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataRoot, ensureRoot } from "./store.ts";

const FILE = "renames.json";
const MAX_RENAMES = 200;
const MAX_HOPS = 10;

export interface RenameRecord {
  /** Repository the rename happened in, as a real path. */
  workspace: string;
  from: string;
  to: string;
  at: string;
}

let chain: Promise<unknown> = Promise.resolve();

function withLock<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

/** Renames in this repository, newest first, so the latest name wins. */
export function listRenames(home: string, workspace: string): Promise<RenameRecord[]> {
  return withLock(async () => (await readRenames(home)).filter((entry) => entry.workspace === workspace));
}

/** Remembers a rename so paths written before it still open the file. */
export function recordRename(home: string, workspace: string, from: string, to: string): Promise<void> {
  return withLock(async () => {
    await ensureRoot(home);
    const entry: RenameRecord = { workspace, from, to, at: new Date().toISOString() };
    const kept = (await readRenames(home)).filter((item) => !(item.workspace === workspace && item.from === from));
    const file = path.join(dataRoot(home), FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ renames: [entry, ...kept].slice(0, MAX_RENAMES) }, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(tmp, file);
    await chmod(file, 0o600);
  });
}

/**
 * Paths this one was renamed to, newest first, following a chain such as
 * a → b → c. A renamed folder carries the paths below it.
 */
export function followRenames(records: RenameRecord[], relPath: string): string[] {
  const hops: string[] = [];
  let current = relPath;
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const match = records.find((entry) => current === entry.from || current.startsWith(`${entry.from}/`));
    if (!match) break;
    current = `${match.to}${current.slice(match.from.length)}`;
    hops.push(current);
  }
  return hops;
}

async function readRenames(home: string): Promise<RenameRecord[]> {
  let text = "";
  try {
    text = await readFile(path.join(dataRoot(home), FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    const parsed = JSON.parse(text) as { renames?: unknown };
    if (!Array.isArray(parsed.renames)) return [];
    return parsed.renames.flatMap((value) => {
      const entry = value as Partial<RenameRecord>;
      if (typeof entry?.workspace !== "string" || typeof entry.from !== "string" || typeof entry.to !== "string") {
        return [];
      }
      if (!entry.workspace || !entry.from || !entry.to) return [];
      return [
        {
          workspace: entry.workspace,
          from: entry.from,
          to: entry.to,
          at: typeof entry.at === "string" ? entry.at : "",
        },
      ];
    });
  } catch {
    return [];
  }
}
