import { ATTACHED_PROMPT, MAX_PROMPT_ATTACHMENT_BYTES, MAX_PROMPT_ATTACHMENTS, type PromptAttachment } from "@engineroom/protocol";
import { uploadPromptAttachment } from "../api.ts";

export interface ComposerAttachment {
  key: string;
  name: string;
  mimeType: string;
  size: number;
  file?: File;
  saved?: PromptAttachment;
  previewUrl?: string;
}

const previews = new Map<string, string>();

export function attachmentPreview(path: string): string | undefined {
  return previews.get(path);
}

export function rememberAttachmentPreview(path: string, url: string) {
  previews.set(path, url);
}

export function composerFilesFromSaved(items: PromptAttachment[]): ComposerAttachment[] {
  return items.map((saved) => ({
    key: saved.path,
    name: saved.name,
    mimeType: saved.mimeType,
    size: saved.size,
    saved,
    previewUrl: attachmentPreview(saved.path),
  }));
}

export function addComposerFiles(
  existing: ComposerAttachment[],
  incoming: FileList | File[],
): { attachments: ComposerAttachment[]; error: string } {
  const next = [...existing];
  let error = "";
  for (const raw of incoming) {
    const file = namedFile(raw);
    if (file.size > MAX_PROMPT_ATTACHMENT_BYTES) {
      error = "Files must be 10MB or smaller.";
      continue;
    }
    if (next.length >= MAX_PROMPT_ATTACHMENTS) {
      error = "You can attach up to 8 files.";
      break;
    }
    const mimeType = file.type || "application/octet-stream";
    next.push({
      key: newKey(),
      name: file.name,
      mimeType,
      size: file.size,
      file,
      previewUrl: isPreviewImage(mimeType) ? URL.createObjectURL(file) : undefined,
    });
  }
  return { attachments: next, error };
}

export function removeComposerFile(existing: ComposerAttachment[], key: string): ComposerAttachment[] {
  const item = existing.find((entry) => entry.key === key);
  if (item?.previewUrl && !item.saved && !remembered(item.previewUrl)) URL.revokeObjectURL(item.previewUrl);
  return existing.filter((entry) => entry.key !== key);
}

export async function uploadPendingAttachments(
  workspace: string,
  items: ComposerAttachment[],
): Promise<PromptAttachment[]> {
  const saved: PromptAttachment[] = [];
  for (const item of items) {
    if (item.saved) {
      saved.push(item.saved);
      continue;
    }
    if (!item.file) throw new Error("attachment is missing");
    const uploaded = await uploadPromptAttachment(workspace, item.file);
    if (item.previewUrl) rememberAttachmentPreview(uploaded.path, item.previewUrl);
    item.saved = uploaded;
    item.file = undefined;
    saved.push(uploaded);
  }
  return saved;
}

export function promptText(text: string, attachmentCount: number): string {
  const trimmed = text.trim();
  if (trimmed) return trimmed;
  return attachmentCount > 0 ? ATTACHED_PROMPT : "";
}

export function restorePromptText(text: string, attachmentCount: number): string {
  if (attachmentCount > 0 && text === ATTACHED_PROMPT) return "";
  return text;
}

function namedFile(file: File): File {
  if (file.name.trim()) return file;
  return new File([file], `pasted${extensionFor(file.type)}`, { type: file.type });
}

function extensionFor(mimeType: string): string {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/gif") return ".gif";
  if (mimeType === "image/webp") return ".webp";
  return ".bin";
}

function isPreviewImage(mimeType: string): boolean {
  return mimeType === "image/png" || mimeType === "image/jpeg" || mimeType === "image/gif" || mimeType === "image/webp";
}

function newKey(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function remembered(url: string): boolean {
  for (const stored of previews.values()) {
    if (stored === url) return true;
  }
  return false;
}
