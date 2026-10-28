import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { assertBranchName, assertGitUrl, parseGitEmail, parseGitName, type GitIdentity, type GitStatus } from "@engineroom/protocol";
import { enableRepository, listRepositories } from "./store.ts";
import { isGitRepository, resolveWorkspace } from "./workspace.ts";

const NETWORK_MS = 120_000;

export async function gitStatus(home: string, requested: string): Promise<GitStatus> {
  const workspace = await resolveComposerWorkspace(home, requested);
  if (!(await isGitRepository(workspace))) return { repo: false, branch: "", branches: [], remote: "" };
  const current = (await runGit(["branch", "--show-current"], workspace)).trim();
  const branch = current || "HEAD";
  const listed = await runGit(["for-each-ref", "--format=%(refname:short)", "refs/heads"], workspace);
  const branches = listed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      try {
        assertBranchName(line);
        return true;
      } catch {
        return false;
      }
    })
    .slice(0, 200);
  if (branch !== "HEAD" && !branches.includes(branch)) branches.unshift(branch);
  return { repo: true, branch, branches, remote: await originUrl(workspace) };
}

export async function gitInitWorkspace(home: string, requested: string): Promise<GitStatus> {
  const workspace = await resolveComposerWorkspace(home, requested);
  if (await isGitRepository(workspace)) throw new Error("repository already exists");
  await runGit(["init", "-b", "main"], workspace);
  if (!(await isGitRepository(workspace))) throw new Error("git init failed");
  await enableRepository(home, workspace);
  return gitStatus(home, workspace);
}

export async function gitSwitch(home: string, requested: string, branch: string): Promise<GitStatus> {
  const name = assertBranchName(branch);
  const workspace = await resolveComposerWorkspace(home, requested);
  if (!(await isGitRepository(workspace))) throw new Error("not a git repository");
  const current = await gitStatus(home, workspace);
  if (!current.branches.includes(name)) throw new Error("invalid branch");
  if (current.branch !== name) await runGit(["switch", "--", name], workspace);
  return gitStatus(home, workspace);
}

export async function gitSetRemote(home: string, requested: string, url: string): Promise<GitStatus> {
  const remote = assertGitUrl(url);
  const workspace = await requireRepository(home, requested);
  const current = await originUrl(workspace);
  if (current) await runGit(["remote", "set-url", "origin", remote], workspace);
  else await runGit(["remote", "add", "origin", remote], workspace);
  return gitStatus(home, workspace);
}

export async function gitCreateBranch(home: string, requested: string, branch: string): Promise<GitStatus> {
  const name = assertBranchName(branch);
  const workspace = await requireRepository(home, requested);
  const current = await gitStatus(home, workspace);
  requireBranch(current);
  if (current.branches.includes(name)) throw new Error("branch already exists");
  await runGit(["switch", "-c", name], workspace);
  return gitStatus(home, workspace);
}

export async function gitPull(home: string, requested: string): Promise<GitStatus> {
  const workspace = await requireRepository(home, requested);
  const current = await gitStatus(home, workspace);
  const branch = requireBranch(current);
  if (!current.remote) throw new Error("no remote");
  await runGit(["pull", "--ff-only", "--no-rebase", "origin", branch], workspace, NETWORK_MS);
  return gitStatus(home, workspace);
}

export async function gitPush(home: string, requested: string): Promise<GitStatus> {
  const workspace = await requireRepository(home, requested);
  const current = await gitStatus(home, workspace);
  const branch = requireBranch(current);
  if (!current.remote) throw new Error("no remote");
  await runGit(["push", "-u", "origin", `HEAD:refs/heads/${branch}`], workspace, NETWORK_MS);
  return gitStatus(home, workspace);
}

async function requireRepository(home: string, requested: string): Promise<string> {
  const workspace = await resolveComposerWorkspace(home, requested);
  if (!(await isGitRepository(workspace))) throw new Error("not a git repository");
  return workspace;
}

function requireBranch(status: GitStatus): string {
  if (!status.branch || status.branch === "HEAD") throw new Error("checkout a branch first");
  return assertBranchName(status.branch);
}

async function originUrl(workspace: string): Promise<string> {
  try {
    return (await runGit(["remote", "get-url", "origin"], workspace)).trim();
  } catch {
    return "";
  }
}

async function resolveComposerWorkspace(home: string, requested: string): Promise<string> {
  const homeReal = await realpath(home);
  const workspace = await resolveWorkspace(home, requested);
  if (workspace === homeReal) return workspace;
  const repos = await listRepositories(home);
  if (!repos.some((entry) => entry.enabled && entry.path === workspace)) {
    throw new Error("repository is not enabled");
  }
  return workspace;
}

export async function readGitIdentity(home: string): Promise<GitIdentity> {
  return {
    name: await readGlobalKey(home, "user.name"),
    email: await readGlobalKey(home, "user.email"),
  };
}

export async function writeGitIdentity(home: string, name: string, email: string): Promise<GitIdentity> {
  const identity = { name: parseGitName(name), email: parseGitEmail(email) };
  await writeGlobalKey(home, "user.name", identity.name);
  await writeGlobalKey(home, "user.email", identity.email);
  return readGitIdentity(home);
}

async function readGlobalKey(home: string, key: "user.name" | "user.email"): Promise<string> {
  const result = await runGitHome(home, ["config", "--global", "--get", key]);
  const value = result.stdout.replace(/[\r\n]+$/, "");
  if (result.code === 0) return value;
  if (result.code === 1 && value === "") return "";
  throw new Error(result.stderr.trim() || "git config failed");
}

async function writeGlobalKey(home: string, key: "user.name" | "user.email", value: string): Promise<void> {
  const result = await runGitHome(home, ["config", "--global", key, value]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || "git config failed");
}

function runGitHome(home: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      ["-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never", ...args],
      {
        cwd: home,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          HOME: home,
          PATH: process.env.PATH || "/usr/bin:/bin",
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_COUNT: "0",
        },
      },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-10_000);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-500);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function runGit(args: string[], cwd: string, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      HOME: process.env.HOME,
      PATH: process.env.PATH || "/usr/bin:/bin",
      USER: process.env.USER,
      LOGNAME: process.env.LOGNAME,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "0",
    };
    if (process.env.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
    const child = spawn(
      "git",
      [
        "-c", "protocol.file.allow=never",
        "-c", "protocol.ext.allow=never",
        "-c", "alias.pull=",
        "-c", "alias.push=",
        "-c", "alias.fetch=",
        ...args,
      ],
      {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env,
      },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-100_000);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-500);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || "git failed"));
    });
  });
}
