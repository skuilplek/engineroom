import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { assertGitUrl } from "@engineroom/protocol";

function gitEnv(): NodeJS.ProcessEnv {
  return {
    HOME: process.env.HOME,
    PATH: process.env.PATH || "/usr/bin:/bin",
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "0",
  };
}

function runGit(args: string[], fallback: string, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      ["-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never", ...args],
      {
        cwd,
        stdio: ["ignore", "ignore", "pipe"],
        env: gitEnv(),
      },
    );
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-500);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || fallback));
    });
  });
}

export async function gitClone(url: string, dest: string): Promise<void> {
  assertGitUrl(url);
  await mkdir(path.dirname(dest), { recursive: true });
  await runGit(["clone", "--", url, dest], "clone failed");
}

export async function gitInit(dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  await runGit(["init", "-b", "main"], "git init failed", dest);
}
