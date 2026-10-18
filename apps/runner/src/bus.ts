import type { ChatEvent, StreamEvent } from "@engineroom/protocol";

export type PushMessage =
  | ({ id: "push"; type: "chat_event" } & ChatEvent)
  | { id: "push"; type: "chats_changed" }
  | { id: "push"; type: "pty"; chatId: string; data: string };

export interface BusSink {
  send(message: PushMessage): void;
}

export class ChatBus {
  private seq = new Map<string, number>();
  private ring = new Map<string, ChatEvent[]>();
  private running = new Set<string>();
  private sinks = new Set<BusSink>();

  private readonly cap: number;

  constructor(cap = 2000) {
    this.cap = cap;
  }

  init(chatId: string, seq: number) {
    if (!this.seq.has(chatId)) this.seq.set(chatId, seq);
  }

  current(chatId: string): number {
    return this.seq.get(chatId) ?? 0;
  }

  publish(chatId: string, event: StreamEvent, at = new Date().toISOString()): ChatEvent {
    const seq = this.current(chatId) + 1;
    this.seq.set(chatId, seq);
    const item: ChatEvent = { chatId, seq, at, event };
    const ring = this.ring.get(chatId) ?? [];
    ring.push(item);
    if (ring.length > this.cap) ring.splice(0, ring.length - this.cap);
    this.ring.set(chatId, ring);
    const message: PushMessage = { id: "push", type: "chat_event", ...item };
    for (const sink of this.sinks) sink.send(message);
    return item;
  }

  since(chatId: string, seq: number): ChatEvent[] {
    return (this.ring.get(chatId) ?? []).filter((item) => item.seq > seq);
  }

  setRunning(chatId: string, running: boolean) {
    const before = this.running.has(chatId);
    if (running) this.running.add(chatId);
    else this.running.delete(chatId);
    if (before !== this.running.has(chatId)) this.changed();
  }

  isRunning(chatId: string): boolean {
    return this.running.has(chatId);
  }

  changed() {
    const message: PushMessage = { id: "push", type: "chats_changed" };
    for (const sink of this.sinks) sink.send(message);
  }

  pty(chatId: string, data: string) {
    const message: PushMessage = { id: "push", type: "pty", chatId, data };
    for (const sink of this.sinks) sink.send(message);
  }

  add(sink: BusSink): () => void {
    this.sinks.add(sink);
    return () => {
      this.sinks.delete(sink);
    };
  }
}
