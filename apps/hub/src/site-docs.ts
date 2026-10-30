import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isExtensionSlug, isInsidePath, MAX_EXTENSION_DOC_BYTES } from "@engineroom/protocol";

const MAX_SITE_DOCS = 40;
const TITLE_MAX = 80;

export interface SiteDocLink {
  id: string;
  title: string;
}

export function listSiteDocs(root: string): SiteDocLink[] {
  assertRoot(root);
  return readIndex(root);
}

export function readSiteDoc(root: string, id: string): { title: string; markdown: string } {
  assertRoot(root);
  const doc = find(root, id);
  let markdown: string;
  try {
    markdown = parseSiteMarkdown(readFileSync(docFile(root, doc.id)));
  } catch (error) {
    if (isMissing(error)) throw new Error("document not found");
    throw error;
  }
  return { title: doc.title, markdown };
}

export function addSiteDoc(root: string, title: string, data: Buffer): SiteDocLink {
  assertRoot(root);
  const cleanTitle = assertTitle(title);
  const id = siteDocId(cleanTitle);
  const markdown = parseSiteMarkdown(data);
  const docs = readIndex(root);
  if (docs.some((doc) => doc.id === id)) throw new Error("document id is taken");
  if (docs.length >= MAX_SITE_DOCS) throw new Error("too many documents");
  const next = [...docs, { id, title: cleanTitle }];
  writeDoc(root, id, markdown);
  writeIndex(root, next);
  return { id, title: cleanTitle };
}

export function updateSiteDoc(root: string, id: string, title: string, data: Buffer | string): SiteDocLink {
  assertRoot(root);
  const current = find(root, id);
  const cleanTitle = assertTitle(title);
  const markdown = parseSiteMarkdown(data);
  writeDoc(root, current.id, markdown);
  const next = readIndex(root).map((doc) => (doc.id === current.id ? { id: current.id, title: cleanTitle } : doc));
  writeIndex(root, next);
  return { id: current.id, title: cleanTitle };
}

export function removeSiteDoc(root: string, id: string): void {
  assertRoot(root);
  const current = find(root, id);
  writeIndex(root, readIndex(root).filter((doc) => doc.id !== current.id));
  rmSync(docFile(root, current.id), { force: true });
}

export function assertMarkdownName(filename: string): void {
  const base = filename.split(/[/\\]/).pop() || "";
  if (!base.toLowerCase().endsWith(".md") || base.length > 200) throw new Error("invalid document");
}

function find(root: string, id: string): SiteDocLink {
  if (!isExtensionSlug(id)) throw new Error("invalid document");
  const doc = readIndex(root).find((item) => item.id === id);
  if (!doc) throw new Error("document not found");
  return doc;
}

function siteDocId(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  if (!isExtensionSlug(slug)) throw new Error("invalid document title");
  return slug;
}

function assertTitle(value: string): string {
  const title = value.trim();
  if (!title || title.length > TITLE_MAX || /[\u0000-\u001f]/.test(title)) throw new Error("invalid document title");
  return title;
}

function parseSiteMarkdown(data: Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  if (buf.length > MAX_EXTENSION_DOC_BYTES) throw new Error("document is too large");
  if (buf.includes(0)) throw new Error("invalid document");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new Error("invalid document");
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

function assertRoot(root: string) {
  if (!root) throw new Error("documents are not configured");
}

function indexPath(root: string): string {
  return path.join(path.resolve(root), "site-docs.json");
}

function docFile(root: string, id: string): string {
  const dir = path.resolve(root, "site-docs");
  const file = path.resolve(dir, `${id}.md`);
  if (!isInsidePath(dir, file)) throw new Error("invalid document");
  return file;
}

function readIndex(root: string): SiteDocLink[] {
  try {
    const parsed = JSON.parse(readFileSync(indexPath(root), "utf8")) as { docs?: unknown };
    if (!Array.isArray(parsed.docs)) return [];
    const docs: SiteDocLink[] = [];
    for (const item of parsed.docs) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      if (!isExtensionSlug(record.id) || typeof record.title !== "string") continue;
      try {
        const title = assertTitle(record.title);
        if (docs.some((doc) => doc.id === record.id)) continue;
        docs.push({ id: record.id, title });
      } catch {
        continue;
      }
    }
    return docs;
  } catch (error) {
    if (isMissing(error)) return [];
    return [];
  }
}

function writeDoc(root: string, id: string, markdown: string) {
  const file = docFile(root, id);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  writeAtomic(file, markdown);
}

function writeIndex(root: string, docs: SiteDocLink[]) {
  writeAtomic(indexPath(root), `${JSON.stringify({ docs }, null, 2)}\n`);
}

function writeAtomic(file: string, data: string) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, data, { mode: 0o644 });
  renameSync(tmp, file);
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT";
}
