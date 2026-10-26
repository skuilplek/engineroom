import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readlink, rename, unlink, type FileHandle } from "node:fs/promises";
import type { Socket } from "node:net";
import { userInfo } from "node:os";
import path from "node:path";
import { createDeflateRaw, crc32 } from "node:zlib";
import { listRepositories, resolveRepoWorkspace } from "./store.ts";

const UTF8 = 0x800;
const DATA_DESCRIPTOR = 0x8;
const MAX_ENTRY = 0xffffffff;
const MAX_ENTRIES = 0xffff;

export interface ProjectArchiveJob {
  id: string;
  filename: string;
  status: "creating" | "ready" | "failed";
  error?: string;
  size?: number;
}

interface Job extends ProjectArchiveJob {
  workspace: string;
  path: string;
}

interface Central {
  name: Buffer;
  method: number;
  flags: number;
  time: number;
  date: number;
  crc: number;
  compressed: number;
  uncompressed: number;
  mode: number;
  offset: number;
}

export function archiveStamp(when = new Date()): string {
  const year = when.getFullYear();
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  const hour = String(when.getHours()).padStart(2, "0");
  return `${year}${month}${day}${hour}`;
}

export function archiveFileName(project: string, when = new Date()): string {
  const safe = project
    .replace(/[\\/]+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "")
    .replace(/^[-.]+/, "")
    .slice(0, 80) || "project";
  return `${safe}-${archiveStamp(when)}.zip`;
}

export function archiveUserHash(username = userInfo().username): string {
  return createHash("sha256").update(username).digest("hex");
}

export function archiveDirectory(username = userInfo().username): string {
  const hash = archiveUserHash(username);
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("invalid archive name");
  return `/tmp/${hash}`;
}

export function archivePath(filename: string, username = userInfo().username): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.zip$/.test(filename) || filename.includes("..")) {
    throw new Error("invalid archive name");
  }
  return `${archiveDirectory(username)}/${filename}`;
}

export class ProjectArchives {
  private readonly jobs = new Map<string, Job>();
  private readonly active = new Map<string, string>();
  private readonly pending = new Map<string, Promise<ProjectArchiveJob>>();

  async start(home: string, requested: string): Promise<ProjectArchiveJob> {
    const workspace = await resolveRepoWorkspace(home, requested);
    const running = this.creating(workspace);
    if (running) return view(running);
    const inflight = this.pending.get(workspace);
    if (inflight) return inflight;
    const promise = this.begin(home, workspace);
    this.pending.set(workspace, promise);
    try {
      return await promise;
    } finally {
      if (this.pending.get(workspace) === promise) this.pending.delete(workspace);
    }
  }

  status(archiveId: string): ProjectArchiveJob {
    const job = this.jobs.get(archiveId);
    if (!job) throw new Error("archive not found");
    return view(job);
  }

  async sendDownload(socket: Socket, requestId: string, archiveId: string): Promise<void> {
    const job = this.jobs.get(archiveId);
    if (!job) throw new Error("archive not found");
    if (job.status === "failed") throw new Error(job.error || "could not create the zip");
    if (job.status !== "ready" || job.size == null) throw new Error("archive is not ready");
    const handle = await open(job.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let sentHeader = false;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== job.size) throw new Error("archive is not ready");
      const header = Buffer.from(`${JSON.stringify({
        id: requestId,
        type: "ok",
        result: { filename: job.filename, size: job.size },
      })}\n`);
      await writeSocket(socket, header);
      sentHeader = true;
      const buf = Buffer.alloc(64 * 1024);
      let position = 0;
      while (position < job.size) {
        const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, job.size - position), position);
        if (bytesRead <= 0) throw new Error("archive ended early");
        await writeSocket(socket, Buffer.from(buf.subarray(0, bytesRead)));
        position += bytesRead;
      }
      socket.end();
    } catch (error) {
      if (sentHeader) {
        socket.destroy();
        return;
      }
      throw error;
    } finally {
      await handle.close();
    }
  }

  private creating(workspace: string): Job | undefined {
    const id = this.active.get(workspace);
    if (!id) return undefined;
    const job = this.jobs.get(id);
    if (job?.status === "creating") return job;
    return undefined;
  }

  private async begin(home: string, workspace: string): Promise<ProjectArchiveJob> {
    const running = this.creating(workspace);
    if (running) return view(running);
    const repos = await listRepositories(home);
    const entry = repos.find((item) => item.path === workspace && item.enabled);
    if (!entry) throw new Error("repository is not enabled");
    const again = this.creating(workspace);
    if (again) return view(again);
    const filename = archiveFileName(entry.name || path.basename(workspace));
    const job: Job = {
      id: randomUUID(),
      workspace,
      filename,
      path: archivePath(filename),
      status: "creating",
    };
    for (const [id, existing] of this.jobs) {
      if (existing.workspace === workspace && existing.status !== "creating") this.jobs.delete(id);
    }
    this.jobs.set(job.id, job);
    this.active.set(workspace, job.id);
    void this.run(job);
    return view(job);
  }

  private async run(job: Job): Promise<void> {
    const directory = archiveDirectory();
    const tmp = path.join(directory, `engineroom-${randomUUID()}.zip.partial`);
    let handle: FileHandle | undefined;
    try {
      await ensureArchiveDirectory(directory);
      handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await writeProjectZip(job.workspace, handle);
      await handle.close();
      handle = undefined;
      await placeArchive(tmp, job.path);
      const info = await lstat(job.path);
      job.size = info.size;
      job.status = "ready";
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : "could not create the zip";
      if (handle) await handle.close().catch(() => undefined);
      await unlink(tmp).catch(() => undefined);
    } finally {
      if (this.active.get(job.workspace) === job.id) this.active.delete(job.workspace);
    }
  }
}

async function ensureArchiveDirectory(dir: string): Promise<void> {
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(dir);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (info.isSymbolicLink() || !info.isDirectory() || uid == null || info.uid !== uid) {
    throw new Error("archive directory is not available");
  }
  await chmod(dir, 0o700);
}

async function placeArchive(tempPath: string, destPath: string): Promise<void> {
  let existing: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    existing = await lstat(destPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing) {
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    // lstat does not follow a symlink, and rename replaces the final path instead of writing through it.
    if (uid == null || !existing.isFile() || existing.uid !== uid) throw new Error("archive path is not a regular file");
    await unlink(destPath);
  }
  await rename(tempPath, destPath);
  await chmod(destPath, 0o600);
}

async function writeProjectZip(root: string, handle: FileHandle): Promise<void> {
  const sink = new Sink(handle);
  const entries: Central[] = [];
  await walk(root, "", sink, entries);
  const directoryAt = sink.offset;
  for (const entry of entries) await sink.write(centralHeader(entry));
  const directorySize = sink.offset - directoryAt;
  if (entries.length > MAX_ENTRIES || directorySize > MAX_ENTRY || directoryAt > MAX_ENTRY) {
    throw new Error("archive is too large");
  }
  await sink.write(endOfDirectory(entries.length, directorySize, directoryAt));
}

async function walk(dir: string, prefix: string, sink: Sink, entries: Central[]): Promise<void> {
  const listed = await readdir(dir, { withFileTypes: true });
  listed.sort((left, right) => left.name.localeCompare(right.name));
  for (const item of listed) {
    if (!item.name || item.name === "." || item.name === ".." || item.name.includes("/") || item.name.includes("\0")) continue;
    const full = path.join(dir, item.name);
    const rel = prefix ? `${prefix}/${item.name}` : item.name;
    const st = await lstat(full);
    if (st.isSymbolicLink()) {
      const target = await readlink(full);
      await writeStored(sink, entries, rel, Buffer.from(target), st.mode, st.mtime);
      continue;
    }
    if (st.isDirectory()) {
      await writeStored(sink, entries, `${rel}/`, Buffer.alloc(0), st.mode, st.mtime);
      await walk(full, rel, sink, entries);
      continue;
    }
    if (!st.isFile()) continue;
    if (st.size === 0) await writeStored(sink, entries, rel, Buffer.alloc(0), st.mode, st.mtime);
    else await writeDeflated(sink, entries, rel, full, st.mode, st.mtime);
  }
}

async function writeStored(
  sink: Sink,
  entries: Central[],
  name: string,
  data: Buffer,
  mode: number,
  when: Date,
): Promise<void> {
  const encoded = encodeName(name);
  const fields = dosFields(when);
  const crc = data.length === 0 ? 0 : crc32(data) >>> 0;
  const offset = sink.offset;
  await sink.write(localHeader(encoded, 0, UTF8, fields, crc, data.length, data.length));
  if (data.length > 0) await sink.write(data);
  entries.push({
    name: encoded,
    method: 0,
    flags: UTF8,
    time: fields.time,
    date: fields.date,
    crc,
    compressed: data.length,
    uncompressed: data.length,
    mode,
    offset,
  });
}

async function writeDeflated(
  sink: Sink,
  entries: Central[],
  name: string,
  filePath: string,
  mode: number,
  when: Date,
): Promise<void> {
  const encoded = encodeName(name);
  const fields = dosFields(when);
  const offset = sink.offset;
  await sink.write(localHeader(encoded, 8, UTF8 | DATA_DESCRIPTOR, fields, 0, 0, 0));
  const compressed = await deflateFile(filePath, sink);
  await sink.write(dataDescriptor(compressed.crc, compressed.compressed, compressed.uncompressed));
  entries.push({
    name: encoded,
    method: 8,
    flags: UTF8 | DATA_DESCRIPTOR,
    time: fields.time,
    date: fields.date,
    crc: compressed.crc,
    compressed: compressed.compressed,
    uncompressed: compressed.uncompressed,
    mode,
    offset,
  });
}

async function deflateFile(filePath: string, sink: Sink): Promise<{ crc: number; compressed: number; uncompressed: number }> {
  const input = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const deflate = createDeflateRaw();
  let crc = 0;
  let uncompressed = 0;
  let compressed = 0;
  let pending: Promise<void> = Promise.resolve();
  let failed: Error | undefined;
  const fail = (error: unknown) => {
    if (failed) return;
    failed = error instanceof Error ? error : new Error("could not write the archive");
    deflate.destroy();
  };
  const done = new Promise<void>((resolve, reject) => {
    deflate.once("end", () => resolve());
    deflate.once("error", (error: unknown) => reject(error instanceof Error ? error : failed ?? new Error("could not write the archive")));
  });
  deflate.on("data", (chunk: Buffer) => {
    compressed += chunk.length;
    if (compressed > MAX_ENTRY) {
      fail(new Error("archive is too large"));
      return;
    }
    const copy = Buffer.from(chunk);
    pending = pending.then(() => sink.write(copy)).catch(fail);
  });
  try {
    const buf = Buffer.alloc(64 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await input.read(buf, 0, buf.length, position);
      if (bytesRead <= 0) break;
      const slice = Buffer.from(buf.subarray(0, bytesRead));
      crc = crc32(slice, crc) >>> 0;
      uncompressed += bytesRead;
      if (uncompressed > MAX_ENTRY) throw new Error("archive is too large");
      if (!deflate.write(slice)) await Promise.race([once(deflate, "drain"), done]);
      if (failed) throw failed;
      position += bytesRead;
    }
    deflate.end();
    await done;
    await pending;
    if (failed) throw failed;
  } finally {
    await input.close();
  }
  return { crc, compressed, uncompressed };
}

function encodeName(name: string): Buffer {
  const bare = name.endsWith("/") ? name.slice(0, -1) : name;
  if (!bare || bare.startsWith("/") || bare.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("invalid archive path");
  }
  const encoded = Buffer.from(name, "utf8");
  if (encoded.length > 60_000) throw new Error("invalid archive path");
  return encoded;
}

function dosFields(when: Date): { time: number; date: number } {
  const year = Math.max(1980, Math.min(2107, when.getFullYear()));
  return {
    time: ((when.getHours() & 31) << 11) | ((when.getMinutes() & 63) << 5) | (Math.floor(when.getSeconds() / 2) & 31),
    date: ((year - 1980) << 9) | (((when.getMonth() + 1) & 15) << 5) | (when.getDate() & 31),
  };
}

function localHeader(
  name: Buffer,
  method: number,
  flags: number,
  fields: { time: number; date: number },
  crc: number,
  compressed: number,
  uncompressed: number,
): Buffer {
  const buf = Buffer.alloc(30 + name.length);
  buf.writeUInt32LE(0x04034b50, 0);
  buf.writeUInt16LE(20, 4);
  buf.writeUInt16LE(flags, 6);
  buf.writeUInt16LE(method, 8);
  buf.writeUInt16LE(fields.time, 10);
  buf.writeUInt16LE(fields.date, 12);
  buf.writeUInt32LE(crc >>> 0, 14);
  buf.writeUInt32LE(compressed >>> 0, 18);
  buf.writeUInt32LE(uncompressed >>> 0, 22);
  buf.writeUInt16LE(name.length, 26);
  buf.writeUInt16LE(0, 28);
  name.copy(buf, 30);
  return buf;
}

function dataDescriptor(crc: number, compressed: number, uncompressed: number): Buffer {
  const buf = Buffer.alloc(16);
  buf.writeUInt32LE(0x08074b50, 0);
  buf.writeUInt32LE(crc >>> 0, 4);
  buf.writeUInt32LE(compressed >>> 0, 8);
  buf.writeUInt32LE(uncompressed >>> 0, 12);
  return buf;
}

function centralHeader(entry: Central): Buffer {
  const buf = Buffer.alloc(46 + entry.name.length);
  const external = ((entry.mode & 0xffff) * 0x10000) >>> 0;
  buf.writeUInt32LE(0x02014b50, 0);
  buf.writeUInt16LE(0x0314, 4);
  buf.writeUInt16LE(20, 6);
  buf.writeUInt16LE(entry.flags, 8);
  buf.writeUInt16LE(entry.method, 10);
  buf.writeUInt16LE(entry.time, 12);
  buf.writeUInt16LE(entry.date, 14);
  buf.writeUInt32LE(entry.crc >>> 0, 16);
  buf.writeUInt32LE(entry.compressed >>> 0, 20);
  buf.writeUInt32LE(entry.uncompressed >>> 0, 24);
  buf.writeUInt16LE(entry.name.length, 28);
  buf.writeUInt16LE(0, 30);
  buf.writeUInt16LE(0, 32);
  buf.writeUInt16LE(0, 34);
  buf.writeUInt16LE(0, 36);
  buf.writeUInt32LE(external, 38);
  buf.writeUInt32LE(entry.offset >>> 0, 42);
  entry.name.copy(buf, 46);
  return buf;
}

function endOfDirectory(count: number, size: number, offset: number): Buffer {
  const buf = Buffer.alloc(22);
  buf.writeUInt32LE(0x06054b50, 0);
  buf.writeUInt16LE(0, 4);
  buf.writeUInt16LE(0, 6);
  buf.writeUInt16LE(count, 8);
  buf.writeUInt16LE(count, 10);
  buf.writeUInt32LE(size >>> 0, 12);
  buf.writeUInt32LE(offset >>> 0, 16);
  buf.writeUInt16LE(0, 20);
  return buf;
}

class Sink {
  offset = 0;
  private readonly handle: FileHandle;

  constructor(handle: FileHandle) {
    this.handle = handle;
  }

  async write(data: Buffer): Promise<void> {
    let off = 0;
    while (off < data.length) {
      const { bytesWritten } = await this.handle.write(data, off, data.length - off, this.offset);
      if (bytesWritten <= 0) throw new Error("could not write the archive");
      off += bytesWritten;
      this.offset += bytesWritten;
      if (this.offset > MAX_ENTRY) throw new Error("archive is too large");
    }
  }
}

function view(job: Job): ProjectArchiveJob {
  return {
    id: job.id,
    filename: job.filename,
    status: job.status,
    ...(job.error ? { error: job.error } : {}),
    ...(job.size != null ? { size: job.size } : {}),
  };
}

function writeSocket(socket: Socket, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}
