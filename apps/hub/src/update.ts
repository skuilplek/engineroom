import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const UPDATE_LOG_LIMIT = 400_000;

export interface UpdateState {
  status: "idle" | "running" | "ok" | "failed";
  log: string;
}

export async function readUpdateState(statusFile: string, logFile: string): Promise<UpdateState> {
  let status: UpdateState["status"] = "idle";
  try {
    const first = (await readFile(statusFile, "utf8")).split("\n")[0]?.trim() ?? "";
    if (first === "running" || first === "ok" || first === "failed") status = first;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  let log = "";
  try {
    log = await readFile(logFile, "utf8");
  } catch (error) {
    if (!missing(error)) throw error;
  }
  if (log.length > UPDATE_LOG_LIMIT) log = `…\n${log.slice(-UPDATE_LOG_LIMIT)}`;
  return { status, log };
}

export function runUpdateCtl(ctl: string, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("sudo", ["-n", "--", ctl], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
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
      else reject(new Error(stderr.trim() || "update command failed"));
    });
  });
}

function missing(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT";
}
