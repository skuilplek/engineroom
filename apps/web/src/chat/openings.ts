import type { PromptAttachment } from "@engineroom/protocol";

export interface Opening {
  prompt: string;
  attachments: PromptAttachment[];
  workspace?: string;
}

/**
 * The first prompt for a newly created chat is held here until that chat has a
 * snapshot and can send it. A single slot loses the prompt when someone opens
 * another chat before the first snapshot arrives.
 */
export class OpeningQueue {
  private readonly entries = new Map<string, Opening>();

  set(chatId: string, opening: Opening) {
    this.entries.set(chatId, opening);
  }

  claim(chatId: string): Opening | null {
    const opening = this.entries.get(chatId);
    if (!opening) return null;
    this.entries.delete(chatId);
    return opening;
  }

  forget(chatId: string) {
    this.entries.delete(chatId);
  }

  forgetWorkspace(workspace: string) {
    for (const [chatId, opening] of this.entries) {
      if (opening.workspace === workspace) this.entries.delete(chatId);
    }
  }

  clear() {
    this.entries.clear();
  }
}
