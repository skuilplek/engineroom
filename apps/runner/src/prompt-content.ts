import { attachmentListText, type PromptAttachment } from "@engineroom/protocol";

export interface LoadedPromptAttachment extends PromptAttachment {
  uri: string;
  data?: string;
}

export type AgentContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string; uri: string }
  | { type: "resource_link"; uri: string; name: string; mimeType: string; size: number };

const VISION_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function isVisionMime(mimeType: string): boolean {
  return VISION_MIME.has(mimeType);
}

export function agentContentBlocks(
  shown: string,
  files: readonly LoadedPromptAttachment[],
  includeImages: boolean,
): AgentContentBlock[] {
  const blocks: AgentContentBlock[] = [{ type: "text", text: attachmentListText(shown, files) }];
  for (const file of files) {
    blocks.push({
      type: "resource_link",
      uri: file.uri,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
    });
    if (includeImages && file.data && isVisionMime(file.mimeType)) {
      blocks.push({ type: "image", data: file.data, mimeType: file.mimeType, uri: file.uri });
    }
  }
  return blocks;
}
