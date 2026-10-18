import { spawn, spawnSync } from "node:child_process";
import { assertUsername, loginAllowed } from "@engineroom/protocol";

export interface LinuxUser {
  username: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
  groups: string[];
}

const USER_CACHE_TTL_MS = 5_000;
const userCache = new Map<string, { user: LinuxUser | null; expires: number }>();

export function invalidateUserCache(username?: string) {
  if (username) userCache.delete(username);
  else userCache.clear();
}

export function lookupUser(username: string): LinuxUser | null {
  try {
    assertUsername(username);
  } catch {
    return null;
  }
  const now = Date.now();
  const cached = userCache.get(username);
  if (cached && cached.expires > now) return cached.user;
  const passwd = spawnSync("getent", ["passwd", username], { encoding: "utf8" });
  if (passwd.status !== 0 || !passwd.stdout.trim()) {
    userCache.set(username, { user: null, expires: now + USER_CACHE_TTL_MS });
    return null;
  }
  const [name, , uid, gid, , home, shell] = passwd.stdout.trim().split(":");
  if (!name || !home || !shell) return null;
  const groups = spawnSync("id", ["-Gn", username], { encoding: "utf8" });
  const list = groups.status === 0 ? groups.stdout.trim().split(/\s+/).filter(Boolean) : [];
  const user: LinuxUser = {
    username: name,
    uid: Number(uid),
    gid: Number(gid),
    home,
    shell,
    groups: list,
  };
  userCache.set(username, { user, expires: now + USER_CACHE_TTL_MS });
  return user;
}

export function userMayLogin(user: LinuxUser | null): user is LinuxUser {
  return !!user && loginAllowed(user);
}

export function pamAuthenticate(username: string, password: string, helper: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn(helper, [], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 10_000);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-500);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(true);
      else if (code === 1) resolve(false);
      else reject(new Error(stderr.trim() || "pam helper rejected the request"));
    });
    child.stdin?.write(frame(username));
    child.stdin?.write(frame(password));
    child.stdin?.end();
  });
}

function frame(value: string): Buffer {
  const body = Buffer.from(value);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
