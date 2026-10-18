import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import type { AgentId } from "@engineroom/protocol";
import { envKeyBlocked, readEnvFileSync } from "./envfile.ts";

export function childEnv(base: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const keep = [
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TMPDIR",
    "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "SSH_AUTH_SOCK",
  ];
  for (const key of keep) {
    if (base[key]) env[key] = base[key];
  }
  for (const [key, value] of Object.entries(base)) {
    if (value == null) continue;
    if (
      key.endsWith("_API_KEY") ||
      key.startsWith("CURSOR_") ||
      key.startsWith("ANTHROPIC_") ||
      key.startsWith("CLAUDE_") ||
      key.startsWith("OPENAI_") ||
      key.startsWith("PI_")
    ) {
      env[key] = value;
    }
  }
  const prefix = [`${home}/.local/bin`, `${home}/bin`, "/usr/local/bin", "/usr/bin", "/bin"];
  const current = (base.PATH || "").split(":").filter(Boolean);
  env.PATH = [...prefix, ...current].join(":");
  env.HOME = home;
  env.TERM = "dumb";
  env.NO_COLOR = "1";
  for (const entry of readEnvFileSync(home)) {
    if (!envKeyBlocked(entry.key)) env[entry.key] = entry.value;
  }
  env.HOME = home;
  delete env.LISTEN_FDS;
  delete env.LISTEN_PID;
  delete env.LISTEN_FDNAMES;
  return env;
}

export async function resolveBinary(
  override: string | undefined,
  names: string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  if (override) {
    if (!path.isAbsolute(override)) throw new Error("binary override must be an absolute path");
    await access(override, constants.X_OK);
    return override;
  }
  const dirs = (env.PATH || "").split(":").filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        await access(full, constants.X_OK);
        return full;
      } catch {
        continue;
      }
    }
  }
  throw new Error(`could not find ${names.join(" or ")} on PATH`);
}

export function binaryNames(agent: AgentId): string[] {
  if (agent === "cursor") return ["agent"];
  if (agent === "claude") return ["claude"];
  return ["pi"];
}

export function cursorArgs(workspace: string, sessionId: string, model: string, prompt: string): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--force",
    "--trust",
    "--workspace",
    workspace,
    "--resume",
    sessionId,
  ];
  if (model) args.push("--model", model);
  args.push("--", prompt);
  return args;
}

export function claudeArgs(model: string, sessionId: string | null, prompt: string): string[] {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    "bypassPermissions",
  ];
  if (model) args.push("--model", model);
  if (sessionId) args.push("--resume", sessionId);
  return args;
}

export function piArgs(sessionId: string, model: string, prompt: string): string[] {
  const args = ["--mode", "json", "--session-id", sessionId];
  if (model) args.push("--model", model);
  args.push("--", prompt);
  return args;
}

export function parseCliId(stdout: string): string {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const uuid = [...lines].reverse().find((line) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(line),
  );
  if (uuid) return uuid;
  const last = lines.at(-1);
  if (last && /^[A-Za-z0-9._:-]{8,128}$/.test(last)) return last;
  throw new Error("agent did not return a session id");
}

export interface CliResult {
  code: number | null;
  stderr: string;
}

export function runCli(options: {
  binary: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  onLine: (line: string) => void;
}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(options.binary, options.args, {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stderr = "";
    let stdoutBuf = "";
    let settled = false;
    const finish = (result: CliResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const stop = () => {
      const pid = child.pid;
      if (!pid) return;
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          /* already gone */
        }
      }
      setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }, 2000).unref();
    };

    if (options.signal.aborted) stop();
    else options.signal.addEventListener("abort", stop, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      let index = stdoutBuf.indexOf("\n");
      while (index >= 0) {
        const line = stdoutBuf.slice(0, index);
        stdoutBuf = stdoutBuf.slice(index + 1);
        if (line.trim()) options.onLine(line);
        index = stdoutBuf.indexOf("\n");
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on("close", (code) => {
      if (stdoutBuf.trim()) options.onLine(stdoutBuf);
      finish({ code, stderr });
    });
  });
}

export function runCapture(options: {
  binary: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = "";
  return runCli({
    ...options,
    onLine: (line) => {
      stdout += `${line}\n`;
    },
  }).then((result) => ({ ...result, stdout }));
}
