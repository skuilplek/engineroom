import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { agentBinary, isBuiltinAgent, type AgentId, type PermissionPolicy } from "@engineroom/protocol";
import { envKeyBlocked, readEnvFileSync } from "./envfile.ts";

const PATH_MARKER = "__ENGINEROOM_PATH__";
const loginDirs = new Map<string, string[]>();

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
  const prefix = [`${home}/.local/bin`, `${home}/bin`, ...rememberedLoginDirs(home), "/usr/local/bin", "/usr/bin", "/bin"];
  const current = (base.PATH || "").split(":").filter(Boolean);
  env.PATH = [...new Set([...prefix, ...current])].join(":");
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

export function rememberedLoginDirs(home: string): string[] {
  return loginDirs.get(home) ?? [];
}

// Installers add the agent to the account's shell startup files. The runner's
// own PATH is only the service default, so a login has to read the shell's PATH
// before it can see those commands. The directories are kept for later launches.
export async function refreshLoginCommandDirs(home: string, base: NodeJS.ProcessEnv): Promise<string[]> {
  const dirs = await probeLoginPath(home, base);
  loginDirs.set(home, dirs);
  return dirs;
}

export function parseLoginPath(stdout: string): string[] {
  const index = stdout.lastIndexOf(PATH_MARKER);
  if (index < 0) return [];
  const raw = stdout.slice(index + PATH_MARKER.length).split(/[\r\n]/, 1)[0] ?? "";
  return dedupeDirs(raw.split(":"));
}

function dedupeDirs(parts: string[]): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const part of parts) {
    const dir = part.trim();
    if (!dir.startsWith("/") || /[\0\r\n]/.test(dir)) continue;
    if (seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }
  return dirs;
}

function loginShell(shell: string | undefined): { file: string; base: string } | null {
  if (!shell || !/^\/[A-Za-z0-9._+/-]+$/.test(shell)) return null;
  const base = shell.split("/").pop() || "";
  if (base !== "bash" && base !== "zsh" && base !== "sh" && base !== "fish") return null;
  return { file: shell, base };
}

async function probeLoginPath(home: string, base: NodeJS.ProcessEnv): Promise<string[]> {
  const shell = loginShell(base.SHELL) ?? loginShell("/bin/bash");
  if (!shell) return rememberedLoginDirs(home);
  const command = `printf '\\n${PATH_MARKER}%s' "$PATH"`;
  const argSets = shell.base === "fish"
    ? [["-l", "-c", command], ["-c", command]]
    : [["-ilc", command], ["-ic", command]];
  const probed = await Promise.all(argSets.map((args) => runPathProbe(home, base, shell.file, args)));
  const dirs = dedupeDirs(probed.flat());
  return dirs.length > 0 ? dirs : rememberedLoginDirs(home);
}

function runPathProbe(home: string, base: NodeJS.ProcessEnv, shell: string, args: string[]): Promise<string[]> {
  return new Promise((resolve) => {
    let stdout = "";
    let child: ChildProcess;
    try {
      child = spawn(shell, args, {
        cwd: home,
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
        env: {
          HOME: home,
          USER: base.USER || "",
          LOGNAME: base.LOGNAME || base.USER || "",
          SHELL: shell,
          TERM: "dumb",
          PATH: "/usr/local/bin:/usr/bin:/bin",
          LANG: base.LANG || "C.UTF-8",
        },
      });
    } catch {
      resolve([]);
      return;
    }
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < 1024 * 1024) stdout += chunk;
    });
    const finish = () => resolve(parseLoginPath(stdout));
    child.once("error", finish);
    child.once("close", finish);
  });
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

export function binaryNames(agent: AgentId, catalog: readonly { id: string; binary: string }[] = []): string[] {
  if (isBuiltinAgent(agent)) return [agentBinary(agent)];
  const custom = catalog.find((item) => item.id === agent);
  return [custom?.binary ?? agent];
}

export function cursorArgs(
  workspace: string,
  sessionId: string,
  model: string,
  prompt: string,
  permission: PermissionPolicy = "allow",
): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
  ];
  if (permission !== "ask") args.push("--force");
  args.push(
    "--trust",
    "--workspace",
    workspace,
    "--resume",
    sessionId,
  );
  if (model) args.push("--model", model);
  args.push("--", prompt);
  return args;
}

export function claudeArgs(
  model: string,
  sessionId: string | null,
  prompt: string,
  permission: PermissionPolicy = "allow",
): string[] {
  const mode =
    permission === "allow"
      ? "bypassPermissions"
      : permission === "edits"
        ? "acceptEdits"
        : "default";
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    mode,
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
