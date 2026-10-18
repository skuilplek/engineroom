import type { PlanEntry, StreamEvent, ToolContent, TranscriptEntry } from "@engineroom/protocol";
import { appendTranscript } from "./store.ts";

export class TranscriptWriter {
  private pending = new Map<string, { kind: "text" | "thinking"; text: string; seq: number; at: string; timer: NodeJS.Timeout }>();

  constructor(privateHome: string) {
    this.home = privateHome;
  }

  private readonly home: string;

  async record(chatId: string, event: StreamEvent, seq: number): Promise<void> {
    if (event.type === "text_delta" || event.type === "thinking") {
      const kind = event.type === "text_delta" ? "text" : "thinking";
      await this.flushKind(chatId, kind === "text" ? "thinking" : "text");
      const key = `${chatId}:${kind}`;
      const current = this.pending.get(key);
      const at = new Date().toISOString();
      if (current) {
        current.text += event.text;
        current.seq = seq;
        current.at = at;
        clearTimeout(current.timer);
        current.timer = this.timer(key);
        return;
      }
      this.pending.set(key, { kind, text: event.text, seq, at, timer: this.timer(key) });
      return;
    }
    if (event.type === "tool" || event.type === "plan" || event.type === "error" || event.type === "user_message" || event.type === "turn_end" || event.type === "done") {
      await this.flush(chatId);
    }
    const entry = toEntry(event, seq);
    if (entry) await appendTranscript(this.home, chatId, entry);
  }

  async flush(chatId: string): Promise<void> {
    await this.flushKind(chatId, "text");
    await this.flushKind(chatId, "thinking");
  }

  async flushAll(): Promise<void> {
    const keys = [...this.pending.keys()];
    for (const key of keys) await this.flushKey(key);
  }

  private async flushKind(chatId: string, kind: "text" | "thinking") {
    await this.flushKey(`${chatId}:${kind}`);
  }

  private async flushKey(key: string) {
    const current = this.pending.get(key);
    if (!current) return;
    clearTimeout(current.timer);
    this.pending.delete(key);
    const chatId = key.slice(0, key.lastIndexOf(":"));
    const entry: TranscriptEntry =
      current.kind === "text"
        ? { kind: "text", text: current.text, at: current.at, seq: current.seq }
        : { kind: "thinking", text: current.text, at: current.at, seq: current.seq };
    await appendTranscript(this.home, chatId, entry);
  }

  private timer(key: string): NodeJS.Timeout {
    const timer = setTimeout(() => {
      void this.flushKey(key).catch(() => undefined);
    }, 500);
    timer.unref?.();
    return timer;
  }
}

function toEntry(event: StreamEvent, seq: number): TranscriptEntry | null {
  const at = new Date().toISOString();
  if (event.type === "user_message") return { kind: "user", text: event.text, at, seq };
  if (event.type === "tool") {
    return {
      kind: "tool",
      id: event.id,
      name: event.title || event.name,
      phase: event.phase,
      input: event.input,
      output: event.output,
      toolKind: event.toolKind,
      title: event.title,
      content: event.content,
      at,
      seq,
    };
  }
  if (event.type === "error") return { kind: "error", text: event.text, at, seq };
  if (event.type === "status") return { kind: "status", text: event.text, at, seq };
  if (event.type === "plan") return { kind: "plan", entries: event.entries satisfies PlanEntry[], at, seq };
  return null;
}

export function toolContentOf(value: unknown): ToolContent[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const items: ToolContent[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") items.push({ type: "text", text: block.text });
    else if (block.type === "diff" && typeof block.path === "string") {
      items.push({
        type: "diff",
        path: block.path,
        oldText: typeof block.oldText === "string" ? block.oldText : undefined,
        newText: typeof block.newText === "string" ? block.newText : undefined,
      });
    } else if (block.type === "terminal" && typeof block.terminalId === "string") {
      items.push({ type: "terminal", terminalId: block.terminalId });
    }
  }
  return items.length ? items : undefined;
}
