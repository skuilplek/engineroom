import { spawn } from "node:child_process";

const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const INTERFACE = /^[A-Za-z][A-Za-z0-9._-]{0,14}$/;

export function normalizeHostname(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid hostname");
  let name = value.trim().toLowerCase();
  if (name.endsWith(".local")) name = name.slice(0, -".local".length);
  if (name === "localhost" || !HOSTNAME.test(name)) throw new Error("invalid hostname");
  return name;
}

export function cleanInterface(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid interface");
  const iface = value.trim();
  if (!INTERFACE.test(iface)) throw new Error("invalid interface");
  return iface;
}

export function cleanSsid(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid network");
  const ssid = value.trim();
  if (!ssid || ssid.startsWith("-") || Buffer.byteLength(ssid) > 32) throw new Error("invalid network");
  if (/[\u0000-\u001f\u007f]/.test(ssid)) throw new Error("invalid network");
  return ssid;
}

export function cleanWifiPassword(value: unknown): string {
  if (value == null) return "";
  if (typeof value !== "string") throw new Error("invalid password");
  if (value.length === 0) return "";
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("invalid password");
  if (/^[0-9A-Fa-f]{64}$/.test(value)) return value;
  if (value.length < 8 || value.length > 63) throw new Error("invalid password");
  return value;
}

export function runNetworkCtl(ctl: string, args: string[], stdin = "", timeoutMs = 20_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn("sudo", ["-n", "--", ctl, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
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
      if (code !== 0) {
        reject(new Error(stderr.trim() || "network command failed"));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("network command failed"));
      }
    });
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
  });
}
