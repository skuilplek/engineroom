import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function makeRepo(): Promise<{ home: string; repo: string }> {
  const home = await mkdtemp(path.join(tmpdir(), "er-renames-"));
  const repo = path.join(home, "Sites", "proj");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repo });
  return { home, repo };
}

test("a path written before a rename still opens the file", async () => {
  const { renameRepositoryEntry, readRepositoryFile } = await import("../apps/runner/src/files.ts");
  const { home, repo } = await makeRepo();
  try {
    await writeFile(path.join(repo, "src", "index.ts"), "export const x = 1;\n");
    await renameRepositoryEntry(home, repo, "src/index.ts", "src/main.ts");

    const viaOldPath = await readRepositoryFile(home, repo, "src/index.ts");
    assert.equal(viaOldPath.path, "src/main.ts");
    assert.equal(viaOldPath.content, "export const x = 1;\n");

    // The new name reads the same file.
    const viaNewPath = await readRepositoryFile(home, repo, "src/main.ts");
    assert.equal(viaNewPath.content, "export const x = 1;\n");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a renamed folder carries the paths below it", async () => {
  const { renameRepositoryEntry, readRepositoryFile } = await import("../apps/runner/src/files.ts");
  const { home, repo } = await makeRepo();
  try {
    await writeFile(path.join(repo, "src", "index.ts"), "export const x = 1;\n");
    await renameRepositoryEntry(home, repo, "src", "lib");

    const viaOldPath = await readRepositoryFile(home, repo, "src/index.ts");
    assert.equal(viaOldPath.path, "lib/index.ts");
    assert.equal(viaOldPath.content, "export const x = 1;\n");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("renames chain, so the first name follows to the last one", async () => {
  const { renameRepositoryEntry, readRepositoryFile } = await import("../apps/runner/src/files.ts");
  const { home, repo } = await makeRepo();
  try {
    await writeFile(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
    await renameRepositoryEntry(home, repo, "src/a.ts", "src/b.ts");
    await renameRepositoryEntry(home, repo, "src/b.ts", "src/c.ts");

    assert.equal((await readRepositoryFile(home, repo, "src/a.ts")).path, "src/c.ts");
    assert.equal((await readRepositoryFile(home, repo, "src/b.ts")).path, "src/c.ts");
    assert.equal((await readRepositoryFile(home, repo, "src/c.ts")).content, "export const a = 1;\n");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a file that exists at the old path is never redirected", async () => {
  const { renameRepositoryEntry, readRepositoryFile } = await import("../apps/runner/src/files.ts");
  const { home, repo } = await makeRepo();
  try {
    await writeFile(path.join(repo, "src", "index.ts"), "export const first = 1;\n");
    await renameRepositoryEntry(home, repo, "src/index.ts", "src/main.ts");
    await writeFile(path.join(repo, "src", "index.ts"), "export const second = 2;\n");

    const fresh = await readRepositoryFile(home, repo, "src/index.ts");
    assert.equal(fresh.path, "src/index.ts");
    assert.equal(fresh.content, "export const second = 2;\n");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a path that was never renamed is still reported as missing", async () => {
  const { renameRepositoryEntry, readRepositoryFile } = await import("../apps/runner/src/files.ts");
  const { home, repo } = await makeRepo();
  try {
    await writeFile(path.join(repo, "src", "index.ts"), "export const x = 1;\n");
    await renameRepositoryEntry(home, repo, "src/index.ts", "src/main.ts");
    await assert.rejects(() => readRepositoryFile(home, repo, "src/missing.ts"), /file not found/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("renames are stored newest first and only for their own repository", async () => {
  const { listRenames, recordRename, followRenames } = await import("../apps/runner/src/renames.ts");
  const { home, repo } = await makeRepo();
  const other = path.join(home, "Sites", "other");
  await mkdir(other, { recursive: true });
  try {
    await recordRename(home, repo, "src/a.ts", "src/b.ts");
    await recordRename(home, repo, "src/b.ts", "src/c.ts");
    await recordRename(home, other, "docs/x.md", "docs/y.md");

    const records = await listRenames(home, repo);
    assert.deepEqual(
      records.map((entry) => [entry.from, entry.to]),
      [
        ["src/b.ts", "src/c.ts"],
        ["src/a.ts", "src/b.ts"],
      ],
    );
    assert.equal((await listRenames(home, other)).length, 1);
    assert.deepEqual(followRenames(records, "src/a.ts"), ["src/b.ts", "src/c.ts"]);
    assert.deepEqual(followRenames(records, "src/other.ts"), []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
