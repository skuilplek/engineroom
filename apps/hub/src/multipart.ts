import type { IncomingMessage } from "node:http";
import { MAX_TRANSFER_BYTES } from "@engineroom/protocol";

const MAX_UPLOAD_FILES = 20;
const MAX_UPLOAD_BODY = MAX_TRANSFER_BYTES * 4 + 1024 * 1024;

export interface UploadPart {
  filename: string;
  data: Buffer;
}

export interface UploadForm {
  fields: Record<string, string>;
  files: UploadPart[];
}

export async function readUpload(req: IncomingMessage): Promise<UploadForm> {
  const header = req.headers["content-type"];
  const type = Array.isArray(header) ? header[0] : header || "";
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(type);
  if (!type.toLowerCase().includes("multipart/form-data") || !match) throw new Error("invalid upload");
  const boundary = (match[1] || match[2] || "").trim();
  if (!boundary || boundary.length > 200 || /[\r\n]/.test(boundary)) throw new Error("invalid upload");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_UPLOAD_BODY) throw new Error("body is too large");
    chunks.push(buf);
  }
  return parseMultipart(Buffer.concat(chunks), boundary);
}

export function parseMultipart(body: Buffer, boundary: string): UploadForm {
  if (!boundary || boundary.length > 200 || /[\r\n]/.test(boundary)) throw new Error("invalid upload");
  const marker = Buffer.from(`--${boundary}`);
  const headerBreak = Buffer.from("\r\n\r\n");
  const fields: Record<string, string> = {};
  const files: UploadPart[] = [];
  let pos = body.indexOf(marker);
  if (pos < 0) throw new Error("invalid upload");
  while (pos >= 0 && pos < body.length) {
    const after = pos + marker.length;
    if (body[after] === 45 && body[after + 1] === 45) break;
    let headerStart = after;
    if (body[headerStart] === 13 && body[headerStart + 1] === 10) headerStart += 2;
    const sep = body.indexOf(headerBreak, headerStart);
    if (sep < 0) throw new Error("invalid upload");
    const headers = body.subarray(headerStart, sep).toString("latin1");
    const dataStart = sep + headerBreak.length;
    const next = body.indexOf(marker, dataStart);
    if (next < 0) throw new Error("invalid upload");
    let dataEnd = next;
    if (dataEnd >= 2 && body[dataEnd - 2] === 13 && body[dataEnd - 1] === 10) dataEnd -= 2;
    const data = body.subarray(dataStart, dataEnd);
    const disposition = headers
      .split(/\r\n/)
      .find((line) => line.toLowerCase().startsWith("content-disposition:"));
    if (disposition) {
      const filename = dispositionFilename(disposition);
      if (filename != null) {
        if (files.length >= MAX_UPLOAD_FILES) throw new Error("invalid upload");
        if (data.length > MAX_TRANSFER_BYTES) throw new Error("file is too large");
        files.push({ filename, data });
      } else {
        const name = dispositionParam(disposition, "name");
        if (name) {
          if (data.length > 8192) throw new Error("invalid upload");
          fields[name] = data.toString("utf8");
        }
      }
    }
    pos = next;
  }
  return { fields, files };
}

function dispositionFilename(header: string): string | undefined {
  const star = dispositionParam(header, "filename*");
  if (star) {
    const encoded = star.replace(/^UTF-8''/i, "");
    try {
      return decodeURIComponent(encoded);
    } catch {
      throw new Error("invalid file name");
    }
  }
  return dispositionParam(header, "filename");
}

function dispositionParam(header: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const quoted = new RegExp(`${escaped}="([^"]*)"`, "i").exec(header);
  if (quoted) return quoted[1] ?? "";
  const plain = new RegExp(`${escaped}=([^;\\s]+)`, "i").exec(header);
  if (!plain?.[1]) return undefined;
  return plain[1].replace(/^UTF-8''/i, "");
}
