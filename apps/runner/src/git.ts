import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { assertBranchName, type GitStatus } from "@engineroom/protocol";
import { enableRepository, listRepositories } from "./store.ts";
import { isGitRepository, resolveWorkspace } from "./workspace.ts";

export async function gitStatus(home: string, requested: string): Promise<GitStatus> {
  const workspace = await resolveComposerWorkspace(home, requested);
  if (!(await isGitRepository(workspace))) return { repo: false, branch: "", branches: [] };
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
  return { repo: true, branch, branches };
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

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      ["-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never", ...args],
      {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          HOME: process.env.HOME,
          PATH: process.env.PATH || "/usr/bin:/bin",
          USER: process.env.USER,
          LOGNAME: process.env.LOGNAME,
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_COUNT: "0",
        },
      },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 30_000);
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
