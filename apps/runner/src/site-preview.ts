import { constants } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import type { Socket } from "node:net";
import path from "node:path";
import { isInsidePath, PREVIEW_NEEDS_SERVER } from "@engineroom/protocol";
import { repositoryDirectory } from "./store.ts";

// Preview files are read as the account that owns them, from inside its own
// repository folder. Nothing outside that folder is reachable, whatever the
// URL says, and dot segments stay hidden so .ssh, .engineroom, and .git are
// not published along with a site.
const MAX_PREVIEW_BYTES = 256 * 1024 * 1024;

const SERVED_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
  ".zip": "application/zip",
};

// A browser downloads these instead of running them, and a site preview has no
// interpreter behind it. Refusing them plainly is better than serving source
// that looks like it should have executed.
const SERVER_SIDE = new Set([".php", ".phtml", ".phar", ".cgi", ".fcgi", ".pl", ".py", ".rb", ".sh"]);

// Names of the folders directly under the account's repository folder. The
// preview index lists these so a folder without git still appears, and it
// returns the folder name because each account picks its own.
export async function listSiteDirectories(home: string): Promise<{ directory: string; projects: string[] }> {
  const directory = await repositoryDirectory(home);
  const sitesRoot = path.resolve(home, directory);
  let entries;
  try {
    entries = await readdir(sitesRoot, { withFileTypes: true });
  } catch {
    return { directory, projects: [] };
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const real = await realpath(path.join(sitesRoot, entry.name)).catch(() => null);
    if (!real) continue;
    const info = await stat(real).catch(() => null);
    if (!info?.isDirectory()) continue;
    if (!isInsidePath(await realpath(sitesRoot).catch(() => sitesRoot), real)) continue;
    names.push(entry.name);
  }
  return { directory, projects: names.sort((a, b) => a.localeCompare(b)) };
}

export interface SiteFile {
  handle: Awaited<ReturnType<typeof open>>;
  size: number;
  type: string;
  etag: string;
  modified: Date;
  // True when the request named a folder and index.html answered for it. The
  // preview server redirects those to a trailing slash so relative links work.
  directory: boolean;
}

export async function openSiteFile(home: string, sitePath: string): Promise<SiteFile> {
  const directory = await repositoryDirectory(home);
  const sitesRoot = path.resolve(home, directory);
  const requested = path.resolve(sitesRoot, sitePath);
  if (!isInsidePath(sitesRoot, requested) || requested === sitesRoot) throw new Error("not found");
  // Every segment is checked before the filesystem is touched. The resolved
  // path is checked again below, so a symlink pointing outside the folder or a
  // path through a hidden directory gets the same answer.
  for (const part of path.relative(sitesRoot, requested).split(path.sep)) {
    if (!part || part === "." || part === ".." || part.startsWith(".")) throw new Error("not found");
  }

  let info = await stat(requested).catch(() => null);
  let file = requested;
  let servesIndex = false;
  if (info?.isDirectory()) {
    servesIndex = true;
    file = path.join(requested, "index.html");
    info = await stat(file).catch(() => null);
    if (!info?.isFile()) {
      // A .htm file is the same page under another name, so accept it before
      // giving up on the folder.
      const htm = path.join(requested, "index.htm");
      const htmInfo = await stat(htm).catch(() => null);
      if (htmInfo?.isFile()) {
        file = htm;
        info = htmInfo;
      }
    }
    if (!info?.isFile()) {
      // A PHP (or CGI, or Python) project is not broken, it just cannot be
      // previewed. Naming the entry point is more use than "not found", which
      // reads as though the project were missing.
      const entry = await serverEntry(requested);
      if (entry) throw new Error(`${PREVIEW_NEEDS_SERVER}${entry}`);
    }
  }
  if (!info?.isFile()) throw new Error("not found");
  if (info.size > MAX_PREVIEW_BYTES) throw new Error("file is too large");

  const real = await realpath(file);
  const sitesReal = await realpath(sitesRoot).catch(() => sitesRoot);
  if (!isInsidePath(sitesReal, real) || real === sitesReal) throw new Error("not found");
  for (const part of path.relative(sitesReal, real).split(path.sep)) {
    if (!part || part === "." || part === ".." || part.startsWith(".")) throw new Error("not found");
  }

  const extension = path.extname(real).toLowerCase();
  if (SERVER_SIDE.has(extension)) throw new Error("server-side scripts are not run in a preview");

  const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error("not found");
    return {
      handle,
      size: opened.size,
      type: SERVED_TYPES[extension] || "application/octet-stream",
      etag: `"${opened.size.toString(16)}-${Math.floor(opened.mtimeMs).toString(16)}"`,
      modified: opened.mtime,
      directory: servesIndex,
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

// The server-side entry point of a folder, if it has one. Only the name is
// returned: the file is never opened, since a preview cannot run it anyway.
async function serverEntry(directory: string): Promise<string | null> {
  for (const name of ["index.php", "index.cgi", "index.pl", "index.py", "index.rb", "index.sh"]) {
    const info = await stat(path.join(directory, name)).catch(() => null);
    if (info?.isFile()) return name;
  }
  return null;
}

export async function sendSiteFile(socket: Socket, requestId: string, file: SiteFile): Promise<void> {
  const header = Buffer.from(`${JSON.stringify({
    id: requestId,
    type: "ok",
    result: {
      size: file.size,
      type: file.type,
      etag: file.etag,
      modified: file.modified.toUTCString(),
      directory: file.directory,
    },
  })}\n`);
  // Once the description is out the hub may stop reading at any moment: a 304
  // for a page the browser already has, a HEAD, or a folder redirect. All of
  // those close the socket, so a failed write after the header is an ordinary
  // end rather than an error worth reporting.
  let sentHeader = false;
  try {
    await writeSocket(socket, header);
    sentHeader = true;
    const buf = Buffer.alloc(128 * 1024);
    let position = 0;
    while (position < file.size) {
      const { bytesRead } = await file.handle.read(buf, 0, Math.min(buf.length, file.size - position), position);
      if (bytesRead <= 0) break;
      await writeSocket(socket, Buffer.from(buf.subarray(0, bytesRead)));
      position += bytesRead;
    }
    if (socket.writable) socket.end();
  } catch (error) {
    if (!sentHeader) throw error;
    socket.destroy();
  } finally {
    await file.handle.close().catch(() => undefined);
  }
}

function writeSocket(socket: Socket, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}
