import { strip } from "../format.ts";

export type OpenedFile =
  | { kind: "repo"; path: string }
  | { kind: "home"; path: string };

export interface FileRefPart {
  text: string;
  path?: string;
}

const FILE_REF =
  /file:\/\/(?:localhost)?\/[^\s<>"'`]+|(?<![:\w/])\/(?:[\w.+@~-]+\/)+[\w.+@~-]+\.[\w.+@~-]+|(?<![:\w/.])(?:[\w.+@~-]+\/)+[\w.+@~-]+\.[\w.+@~-]+/g;

export function splitFileRefs(text: string): FileRefPart[] {
  const parts: FileRefPart[] = [];
  const re = new RegExp(FILE_REF.source, "g");
  let cursor = 0;
  for (const match of text.matchAll(re)) {
    const start = match.index ?? 0;
    if (start < cursor) continue;
    const found = takeFileToken(match[0]);
    if (!found) continue;
    if (start > cursor) parts.push({ text: text.slice(cursor, start) });
    parts.push({ text: found.display, path: found.path });
    cursor = start + found.display.length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  if (parts.length === 0) parts.push({ text });
  return parts;
}

export function clickableFileToken(raw: string, options?: { allowBare?: boolean }): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 4096 || trimmed.includes("\0") || trimmed.includes("\\")) return null;
  const uri = /^file:\/\/(?:localhost)?(\/[^?#]*)$/i.exec(trimmed);
  if (uri?.[1]) return normalizeAbsolute(safeDecode(uri[1]));
  if (trimmed.startsWith("/")) return normalizeAbsolute(safeDecode(trimmed));
  return normalizeRelative(safeDecode(trimmed.replace(/^\.\//, "")), options?.allowBare === true);
}

export function classifyOpenedPath(workspace: string, raw: string): OpenedFile | null {
  const token = clickableFileToken(raw, { allowBare: true });
  if (!token) return null;
  if (!token.startsWith("/")) return { kind: "repo", path: token };
  const rel = insideWorkspace(workspace, token);
  if (rel) return { kind: "repo", path: rel };
  return { kind: "home", path: token };
}

function takeFileToken(raw: string): { display: string; path: string } | null {
  const cut = raw.search(/[?#]/);
  let display = cut === -1 ? raw : raw.slice(0, cut);
  while (display.length > 0) {
    const path = clickableFileToken(display);
    if (path) return { display, path };
    if (!/[.,:;!?)>\]]$/.test(display)) return null;
    display = display.slice(0, -1);
  }
  return null;
}

function normalizeAbsolute(value: string | null): string | null {
  if (!value || !value.startsWith("/") || value.includes("\0") || value.includes("\\")) return null;
  const parts = value.split("/");
  if (parts.length < 3 || parts.slice(1).some((part) => !part || part === "." || part === "..")) return null;
  const name = parts[parts.length - 1] ?? "";
  if (!hasFileExtension(name)) return null;
  return parts.join("/");
}

function normalizeRelative(value: string | null, allowBare: boolean): string | null {
  if (!value || value.startsWith("/") || value.includes("://") || value.includes("\0") || value.includes("\\")) return null;
  const parts = value.split("/");
  if (parts.length > 64 || parts.some((part) => !part || part === "." || part === ".." || /[<>"'`]/.test(part))) return null;
  if (parts.length < 2 && !allowBare) return null;
  if (parts.slice(0, -1).some((part) => part.includes(".") && !part.startsWith("."))) return null;
  const name = parts[parts.length - 1] ?? "";
  if (!hasFileExtension(name)) return null;
  return parts.join("/");
}

function insideWorkspace(workspace: string, abs: string): string | null {
  const root = strip(workspace.trim());
  if (!root.startsWith("/") || abs === root || !abs.startsWith(`${root}/`)) return null;
  const rel = abs.slice(root.length + 1);
  return normalizeRelative(rel, true);
}

function hasFileExtension(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return false;
  return /^[A-Za-z][\w+-]*$/.test(name.slice(dot + 1));
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
