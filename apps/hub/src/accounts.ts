import { spawn, spawnSync } from "node:child_process";
import { assertUsername } from "@engineroom/protocol";
import { lookupUser } from "./auth.ts";

export interface Account {
  username: string;
  home: string;
  uid: number;
}

export function listAccounts(group = "engineroom-users"): Account[] {
  const result = spawnSync("getent", ["group", group], { encoding: "utf8" });
  if (result.status !== 0) return [];
  const members = (result.stdout.trim().split(":")[3] || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const accounts: Account[] = [];
  for (const name of members) {
    const user = lookupUser(name);
    if (!user) continue;
    accounts.push({ username: user.username, home: user.home, uid: user.uid });
  }
  accounts.sort((a, b) => a.username.localeCompare(b.username));
  return accounts;
}

export function cleanPassword(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("password is empty");
  if (value.length > 200) throw new Error("password is too long");
  if (/[\r\n\0]/.test(value)) throw new Error("password is invalid");
  return value;
}

export function runAdminCtl(
  ctl: string,
  action: "add" | "revoke" | "passwd" | "remove",
  username: string,
  password = "",
): Promise<void> {
  assertUsername(username);
  return new Promise((resolve, reject) => {
    const child = spawn("sudo", ["-n", "--", ctl, action, username], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
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
      else reject(new Error(stderr.trim() || "admin command failed"));
    });
    if (action === "add" || action === "passwd") child.stdin.write(`${password}\n`);
    child.stdin.end();
  });
}
