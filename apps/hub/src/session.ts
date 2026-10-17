import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertUsername } from "@engineroom/protocol";

export const COOKIE_NAME = "engineroom_session";
export const SESSION_TTL_SEC = 12 * 60 * 60;

export function loadSecret(file: string): Buffer {
  try {
    const existing = readFileSync(file);
    if (existing.length >= 16) return existing;
  } catch {
    /* create one below */
  }
  const secret = randomBytes(32);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export function signSession(username: string, secret: Buffer, now = Date.now()): string {
  const body = Buffer.from(
    JSON.stringify({ u: username, exp: Math.floor(now / 1000) + SESSION_TTL_SEC }),
  ).toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function readSession(token: string | undefined, secret: Buffer, now = Date.now()): string | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const left = Buffer.from(mac);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { u?: unknown; exp?: unknown };
    if (typeof payload.u !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp * 1000 <= now) return null;
    return assertUsername(payload.u);
  } catch {
    return null;
  }
}

export function sessionCookie(token: string, secure: boolean, maxAge = SESSION_TTL_SEC): string {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(secure: boolean): string {
  return sessionCookie("", secure, 0);
}

export function cookieValue(header: string | undefined, name = COOKIE_NAME): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}
