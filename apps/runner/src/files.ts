import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertRepoRelativePath,
  DEFAULT_FILE_VISIBILITY,
  isInsidePath,
  type FileVisibility,
  type RepoChangeEntry,
  type RepoChangeStatus,
  type RepoFileContent,
  type RepoFileEntry,
  type RepoFilesResult,
} from "@engineroom/protocol";
import { resolveRepoWorkspace } from "./store.ts";

const MAX_FILES = 5000;
const MAX_DEPTH = 16;
const MAX_PREVIEW_BYTES = 256 * 1024;
const BINARY_SAMPLE_BYTES = 8 * 1024;

export async function listRepositoryFiles(
  home: string,
  workspace: string,
  visibility: FileVisibility = DEFAULT_FILE_VISIBILITY,
): Promise<RepoFilesResult> {
  const repoReal = await resolveRepoWorkspace(home, workspace);
  const files: RepoFileEntry[] = [];

  async function walk(dir: string, relDir: string, depth: number) {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const candidates: Array<{ name: string; relPath: string; fullPath: string; isDir: boolean }> = [];
    for (const entry of entries) {
      const name = entry.name;
      if (name === ".git") {
        if (!visibility.showGitDir) continue;
      } else if (name.startsWith(".")) {
        if (!visibility.showHidden) continue;
      }
      const relPath = relDir ? `${relDir}/${name}` : name;
      const fullPath = path.join(dir, name);
      let resolved: string;
      try {
        resolved = await realpath(fullPath);
      } catch {
        continue;
      }
      if (!isInsidePath(repoReal, resolved) || resolved === repoReal) continue;
      let info;
      try {
        info = await stat(resolved);
      } catch {
        continue;
      }
      if (!info.isDirectory() && !info.isFile()) continue;
      candidates.push({
        name,
        relPath,
        fullPath: resolved,
        isDir: info.isDirectory(),
      });
    }

    let ignored = new Set<string>();
    if (!visibility.showGitignored && candidates.length > 0) {
      const nonGit = candidates.filter((item) => item.relPath !== ".git" && !item.relPath.startsWith(".git/"));
      if (nonGit.length > 0) {
        ignored = await checkGitIgnored(
          repoReal,
          nonGit.map((item) => item.relPath),
        );
      }
    }

    const visible = candidates.filter((item) => !ignored.has(item.relPath));
    visible.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (const item of visible) {
      if (files.length >= MAX_FILES) break;
      if (item.isDir) {
        files.push({ path: item.relPath, name: item.name, kind: "dir" });
        await walk(item.fullPath, item.relPath, depth + 1);
      } else {
        let size: number | undefined;
        try {
          const info = await stat(item.fullPath);
          size = info.size;
        } catch {
          size = undefined;
        }
        files.push({
          path: item.relPath,
          name: item.name,
          kind: "file",
          ...(size != null ? { size } : {}),
        });
      }
    }
  }

  await walk(repoReal, "", 0);
  const statusInfo = await readGitStatus(repoReal, visibility);

  return {
    workspace: repoReal,
    branch: statusInfo.branch,
    files,
    changes: statusInfo.changes,
  };
}

export async function readRepositoryFile(
  home: string,
  workspace: string,
  rawPath: string,
  visibility: FileVisibility = DEFAULT_FILE_VISIBILITY,
): Promise<RepoFileContent> {
  const repoReal = await resolveRepoWorkspace(home, workspace);
  const relPath = assertRepoRelativePath(rawPath);
  if (!isPathAllowedByVisibility(relPath, visibility)) {
    throw new Error("file is hidden by policy");
  }
  if (!visibility.showGitignored && relPath !== ".git" && !relPath.startsWith(".git/")) {
    const ignored = await checkGitIgnored(repoReal, [relPath]);
    if (ignored.has(relPath)) throw new Error("file is hidden by policy");
  }

  const candidate = path.resolve(repoReal, relPath);
  if (!isInsidePath(repoReal, candidate) || candidate === repoReal) {
    throw new Error("invalid file path");
  }

  let existsOnDisk = true;
  let resolved = candidate;
  try {
    resolved = await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      existsOnDisk = false;
      const parentDir = path.dirname(candidate);
      let parentReal: string;
      try {
        parentReal = await realpath(parentDir);
      } catch {
        throw new Error("file not found");
      }
      if (!isInsidePath(repoReal, parentReal)) {
        throw new Error("invalid file path");
      }
    } else {
      throw error;
    }
  }

  if (existsOnDisk && (!isInsidePath(repoReal, resolved) || resolved === repoReal)) {
    throw new Error("invalid file path");
  }

  let content = "";
  let binary = false;
  let truncated = false;
  let size = 0;

  if (existsOnDisk) {
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error("not a regular file");
    size = info.size;
    const toRead = Math.min(size, MAX_PREVIEW_BYTES);
    const handle = await open(resolved, "r");
    try {
      const buf = Buffer.alloc(toRead);
      const { bytesRead } = await handle.read(buf, 0, toRead, 0);
      const slice = buf.subarray(0, bytesRead);
      if (isBinaryBuffer(slice)) {
        binary = true;
      } else {
        content = slice.toString("utf8");
        truncated = size > MAX_PREVIEW_BYTES;
      }
    } finally {
      await handle.close();
    }
  }

  const oldContent = await readHeadContent(repoReal, relPath, existsOnDisk ? content : undefined, binary);
  if (!existsOnDisk && oldContent == null) {
    throw new Error("file not found");
  }

  return {
    path: relPath,
    content,
    ...(oldContent != null ? { oldContent } : {}),
    binary,
    truncated,
    size,
  };
}

function isGitInternalPath(relPath: string): boolean {
  return relPath === ".git" || relPath.startsWith(".git/") || relPath.split("/").includes(".git");
}

async function assertEditablePath(
  repoReal: string,
  rawPath: string,
  visibility: FileVisibility,
): Promise<{ relPath: string; candidate: string }> {
  const relPath = assertRepoRelativePath(rawPath);
  if (isGitInternalPath(relPath)) {
    throw new Error("cannot modify .git directory");
  }
  if (!isPathAllowedByVisibility(relPath, visibility)) {
    throw new Error("file is hidden by policy");
  }
  if (!visibility.showGitignored) {
    const ignored = await checkGitIgnored(repoReal, [relPath]);
    if (ignored.has(relPath)) throw new Error("file is hidden by policy");
  }
  const candidate = path.resolve(repoReal, relPath);
  if (!isInsidePath(repoReal, candidate) || candidate === repoReal) {
    throw new Error("invalid file path");
  }
  return { relPath, candidate };
}

export async function writeRepositoryFile(
  home: string,
  workspace: string,
  rawPath: string,
  content: string,
  visibility: FileVisibility = DEFAULT_FILE_VISIBILITY,
): Promise<RepoFileContent> {
  if (Buffer.byteLength(content, "utf8") > MAX_PREVIEW_BYTES) {
    throw new Error("file is too large");
  }
  const repoReal = await resolveRepoWorkspace(home, workspace);
  const { relPath, candidate } = await assertEditablePath(repoReal, rawPath, visibility);

  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("file not found");
    }
    throw error;
  }
  if (!isInsidePath(repoReal, resolved) || resolved === repoReal) {
    throw new Error("invalid file path");
  }

  const info = await stat(resolved);
  if (!info.isFile()) throw new Error("not a regular file");

  const sampleLen = Math.min(info.size, BINARY_SAMPLE_BYTES);
  if (sampleLen > 0) {
    const handle = await open(resolved, "r");
    try {
      const sample = Buffer.alloc(sampleLen);
      const { bytesRead } = await handle.read(sample, 0, sampleLen, 0);
      if (isBinaryBuffer(sample.subarray(0, bytesRead))) {
        throw new Error("cannot edit binary file");
      }
    } finally {
      await handle.close();
    }
  }

  const tmp = `${resolved}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, content, { mode: info.mode & 0o777 || 0o644 });
    await rename(tmp, resolved);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }

  return readRepositoryFile(home, workspace, relPath, visibility);
}

export async function createRepositoryEntry(
  home: string,
  workspace: string,
  rawPath: string,
  kind: "file" | "dir",
  content = "",
  visibility: FileVisibility = DEFAULT_FILE_VISIBILITY,
): Promise<{ path: string; kind: "file" | "dir" }> {
  if (Buffer.byteLength(content, "utf8") > MAX_PREVIEW_BYTES) {
    throw new Error("file is too large");
  }
  const repoReal = await resolveRepoWorkspace(home, workspace);
  const { relPath, candidate } = await assertEditablePath(repoReal, rawPath, visibility);

  try {
    await lstat(candidate);
    throw new Error("path already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const parentDir = path.dirname(candidate);
  await mkdir(parentDir, { recursive: true });
  const parentReal = await realpath(parentDir);
  if (!isInsidePath(repoReal, parentReal)) {
    throw new Error("invalid file path");
  }

  if (kind === "dir") {
    await mkdir(candidate);
  } else {
    await writeFile(candidate, content, { flag: "wx", mode: 0o644 });
  }

  return { path: relPath, kind };
}

export async function renameRepositoryEntry(
  home: string,
  workspace: string,
  oldRawPath: string,
  newRawPath: string,
  visibility: FileVisibility = DEFAULT_FILE_VISIBILITY,
): Promise<{ path: string; newPath: string }> {
  const repoReal = await resolveRepoWorkspace(home, workspace);
  const src = await assertEditablePath(repoReal, oldRawPath, visibility);
  const dst = await assertEditablePath(repoReal, newRawPath, visibility);
  if (src.relPath === dst.relPath) {
    return { path: src.relPath, newPath: dst.relPath };
  }

  let srcReal: string;
  try {
    srcReal = await realpath(src.candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("file not found");
    }
    throw error;
  }
  if (!isInsidePath(repoReal, srcReal) || srcReal === repoReal) {
    throw new Error("invalid file path");
  }

  try {
    await lstat(dst.candidate);
    throw new Error("destination already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const dstParent = path.dirname(dst.candidate);
  await mkdir(dstParent, { recursive: true });
  const dstParentReal = await realpath(dstParent);
  if (!isInsidePath(repoReal, dstParentReal)) {
    throw new Error("invalid file path");
  }

  await rename(src.candidate, dst.candidate);
  return { path: src.relPath, newPath: dst.relPath };
}

export async function deleteRepositoryEntry(
  home: string,
  workspace: string,
  rawPath: string,
  visibility: FileVisibility = DEFAULT_FILE_VISIBILITY,
): Promise<{ path: string }> {
  const repoReal = await resolveRepoWorkspace(home, workspace);
  const { relPath, candidate } = await assertEditablePath(repoReal, rawPath, visibility);

  let targetReal: string;
  try {
    targetReal = await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("file not found");
    }
    throw error;
  }
  if (!isInsidePath(repoReal, targetReal) || targetReal === repoReal) {
    throw new Error("invalid file path");
  }

  await rm(candidate, { recursive: true, force: false });
  return { path: relPath };
}

export function isPathAllowedByVisibility(relPath: string, visibility: FileVisibility): boolean {
  const segments = relPath.split("/").filter(Boolean);
  for (const segment of segments) {
    if (segment === ".git") {
      if (!visibility.showGitDir) return false;
    } else if (segment.startsWith(".")) {
      if (!visibility.showHidden) return false;
    }
  }
  return true;
}

function isBinaryBuffer(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, BINARY_SAMPLE_BYTES));
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] === 0) return true;
  }
  return false;
}

async function checkGitIgnored(repoReal: string, relPaths: string[]): Promise<Set<string>> {
  if (relPaths.length === 0) return new Set();
  const input = `${relPaths.join("\0")}\0`;
  const out = await runGit(repoReal, ["check-ignore", "-z", "--stdin"], input);
  if (!out) return new Set();
  const ignored = new Set<string>();
  for (const part of out.toString("utf8").split("\0")) {
    if (part) ignored.add(part);
  }
  return ignored;
}

async function readGitStatus(
  repoReal: string,
  visibility: FileVisibility,
): Promise<{ branch: string; changes: RepoChangeEntry[] }> {
  const out = await runGit(repoReal, [
    "status",
    "--porcelain=v1",
    "-z",
    "-uall",
    "--branch",
    ...(visibility.showGitignored ? ["--ignored=matching"] : []),
  ]);
  if (!out) return { branch: "", changes: [] };

  const tokens = out.toString("utf8").split("\0");
  let branch = "";
  const rawChanges: RepoChangeEntry[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    if (token.startsWith("## ")) {
      branch = parseBranchHeader(token.slice(3));
      continue;
    }
    if (token.length < 4) continue;
    const x = token[0] || " ";
    const y = token[1] || " ";
    const filePath = token.slice(3);
    if ((x === "R" || x === "C") && i + 1 < tokens.length) {
      i += 1;
    }
    if (x === "!" && y === "!") continue;
    let cleanPath: string;
    try {
      cleanPath = assertRepoRelativePath(filePath);
    } catch {
      continue;
    }
    if (!isPathAllowedByVisibility(cleanPath, visibility)) continue;
    const candidate = path.resolve(repoReal, cleanPath);
    if (!isInsidePath(repoReal, candidate) || candidate === repoReal) continue;
    try {
      const resolved = await realpath(candidate);
      if (!isInsidePath(repoReal, resolved) || resolved === repoReal) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
    }
    const status = classifyStatus(x, y);
    rawChanges.push({
      path: cleanPath,
      status,
      staged: x !== " " && x !== "?" && x !== "!",
      unstaged: y !== " " && y !== "!",
    });
  }

  let changes = rawChanges;
  if (!visibility.showGitignored && rawChanges.length > 0) {
    const ignored = await checkGitIgnored(
      repoReal,
      rawChanges.map((item) => item.path),
    );
    changes = rawChanges.filter((item) => !ignored.has(item.path));
  }

  changes.sort((a, b) => a.path.localeCompare(b.path));
  return { branch, changes };
}

function parseBranchHeader(header: string): string {
  const trimmed = header.trim();
  if (trimmed.startsWith("No commits yet on ")) return trimmed.slice("No commits yet on ".length).trim();
  if (trimmed.startsWith("Initial commit on ")) return trimmed.slice("Initial commit on ".length).trim();
  if (trimmed.startsWith("HEAD (no branch)")) return "HEAD";
  const dots = trimmed.indexOf("...");
  const space = trimmed.indexOf(" ");
  if (dots >= 0) return trimmed.slice(0, dots);
  if (space >= 0) return trimmed.slice(0, space);
  return trimmed;
}

function classifyStatus(x: string, y: string): RepoChangeStatus {
  if (x === "?" || y === "?") return "?";
  if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) return "U";
  if (x === "D" || y === "D") return "D";
  if (x === "A" || y === "A") return "A";
  if (x === "R" || y === "R") return "R";
  return "M";
}

async function readHeadContent(
  repoReal: string,
  relPath: string,
  currentContent: string | undefined,
  currentBinary: boolean,
): Promise<string | undefined> {
  if (currentBinary) return undefined;
  const out = await runGit(repoReal, ["show", `HEAD:${relPath}`], undefined, MAX_PREVIEW_BYTES + 1024);
  if (!out) return undefined;
  if (isBinaryBuffer(out)) return undefined;
  const headText = out.subarray(0, MAX_PREVIEW_BYTES).toString("utf8");
  if (currentContent !== undefined && headText === currentContent) return undefined;
  return headText;
}

function runGit(
  cwd: string,
  args: string[],
  stdinText?: string,
  maxBytes = 2 * 1024 * 1024,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (result: Buffer | null) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, 5000);

    child.stdout.on("data", (chunk: Buffer) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (total < maxBytes) {
        const remaining = maxBytes - total;
        chunks.push(buf.subarray(0, remaining));
      }
      total += buf.length;
    });

    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      // git check-ignore exits with 0 when at least one path is ignored, 1 when none are ignored
      if (args[0] === "check-ignore" && (code === 0 || code === 1)) {
        finish(Buffer.concat(chunks));
        return;
      }
      if (code !== 0) {
        finish(null);
        return;
      }
      finish(Buffer.concat(chunks));
    });

    if (stdinText != null) {
      child.stdin.end(stdinText);
    } else {
      child.stdin.end();
    }
  });
}
