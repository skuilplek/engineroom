import { decodeBrowserFrame, decodePtyFrame, encodePtyFrame, type AgentMode, type AgentModel, type BrowserStatus, type ChatMeta, type ListedSession, type PermissionOption, type QueuedPrompt, type StreamEvent, type TranscriptEntry } from "@engineroom/protocol";
import { notifySessionExpired } from "./sessionExpired.ts";

export type { AgentMode, AgentModel };

export type ServerMessage =
  | {
      type: "snapshot";
      chatId: string;
      transcript: TranscriptEntry[];
      seq: number;
      running: boolean;
      chat: ChatMeta;
      modes?: { currentModeId: string; availableModes: AgentMode[] } | null;
      models?: { currentModelId: string; availableModels: AgentModel[] } | null;
      permission?: { requestId: string; title?: string; options: PermissionOption[] } | null;
      queue?: QueuedPrompt[];
      queueSeq?: number;
      scrollback?: string;
    }
  | { type: "event"; chatId: string; seq: number; at: string; event: StreamEvent; turn?: number }
  | { type: "chats_changed" }
  | { type: "pty"; chatId: string; data: Uint8Array }
  | { type: "browser_frame"; chatId: string; data: string }
  | ({ type: "browser_status"; chatId: string } & BrowserStatus)
  | { type: "browser_activity"; chatId: string }
  | { type: "sessions"; sessions: ListedSession[] }
  | { type: "imported"; chat: ChatMeta }
  | { type: "accepted"; chatId: string; queued: boolean }
  | { type: "pty_open"; chatId: string; attached?: boolean; scrollback?: string }
  | { type: "error"; error: string; chatId?: string; command?: string };

type Listener = (message: ServerMessage) => void;

const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;

export interface AgentTransport {
  readyState: number;
  binaryType: string;
  send(data: string | Uint8Array): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event?: { code?: number }) => void) | null;
}

export class AgentSocket {
  private transport: AgentTransport | null = null;
  private retry = 500;
  private generation = 0;
  private live = false;
  private readonly watches = new Map<string, number>();
  private readonly pending: object[] = [];
  private readonly listeners = new Set<Listener>();
  private readonly connect: (url: string) => AgentTransport;
  private readonly url: () => string;
  private readonly later: (fn: () => void, ms: number) => void;

  constructor(connect: (url: string) => AgentTransport, url: () => string, later: (fn: () => void, ms: number) => void) {
    this.connect = connect;
    this.url = url;
    this.later = later;
  }

  start() {
    if (this.live && this.transport && this.transport.readyState !== SOCKET_CLOSED) return;
    this.live = true;
    const generation = this.generation;
    const ws = this.connect(this.url());
    ws.binaryType = "arraybuffer";
    this.transport = ws;
    ws.onopen = () => {
      if (generation !== this.generation || this.transport !== ws) return;
      this.retry = 500;
      for (const command of this.pending.splice(0)) ws.send(JSON.stringify(command));
      for (const [chatId, lastSeq] of this.watches) ws.send(JSON.stringify({ type: "watch", chatId, lastSeq }));
    };
    ws.onmessage = (event) => {
      if (generation !== this.generation || this.transport !== ws) return;
      if (event.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(event.data);
        const page = decodeBrowserFrame(bytes);
        if (page) {
          this.emit({ type: "browser_frame", chatId: page.chatId, data: bytesToBase64(page.data) });
          return;
        }
        const frame = decodePtyFrame(bytes);
        if (frame) this.emit({ type: "pty", chatId: frame.chatId, data: frame.data });
        return;
      }
      try {
        this.emit(JSON.parse(String(event.data)) as ServerMessage);
      } catch {
        /* ignore a malformed frame */
      }
    };
    ws.onclose = (event) => {
      if (generation !== this.generation) return;
      if (this.transport === ws) this.transport = null;
      if (!this.live) return;
      if (event?.code === 4401) {
        this.live = false;
        this.retry = 500;
        notifySessionExpired();
        return;
      }
      const wait = this.retry;
      this.retry = Math.min(this.retry * 2, 8000);
      this.later(() => {
        if (generation !== this.generation || !this.live) return;
        this.start();
      }, wait);
    };
  }

  stop() {
    this.live = false;
    this.generation += 1;
    this.watches.clear();
    this.pending.length = 0;
    this.retry = 500;
    const current = this.transport;
    this.transport = null;
    if (current && current.readyState !== SOCKET_CLOSED) current.close();
  }

  onAgent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  watchChat(chatId: string, lastSeq: number) {
    this.watches.set(chatId, lastSeq);
    if (this.transport?.readyState === SOCKET_OPEN) {
      this.transport.send(JSON.stringify({ type: "watch", chatId, lastSeq }));
    }
  }

  unwatchChat(chatId: string) {
    this.watches.delete(chatId);
    this.send({ type: "unwatch", chatId }, false);
  }

  noteSeq(chatId: string, seq: number) {
    const current = this.watches.get(chatId);
    if (current == null || seq <= current) return;
    this.watches.set(chatId, seq);
  }

  sendCommand(command: object) {
    this.send(command, true);
  }

  sendPty(chatId: string, data: string) {
    if (this.transport?.readyState !== SOCKET_OPEN) return;
    this.transport.send(encodePtyFrame(chatId, new TextEncoder().encode(data)));
  }

  private send(command: object, queue: boolean) {
    if (this.transport?.readyState === SOCKET_OPEN) {
      this.transport.send(JSON.stringify(command));
      return;
    }
    if (queue) this.pending.push(command);
  }

  private emit(message: ServerMessage) {
    for (const listener of this.listeners) listener(message);
  }
}

interface BrowserGlobals {
  location: { protocol: string; host: string };
  window: { setTimeout: (fn: () => void, ms: number) => unknown };
  WebSocket: new (url: string) => AgentTransport;
}

function browserGlobals(): BrowserGlobals {
  return globalThis as unknown as BrowserGlobals;
}

const browserSocket = new AgentSocket(
  (url) => {
    const ws = new (browserGlobals().WebSocket)(url);
    ws.binaryType = "arraybuffer";
    return ws;
  },
  () => {
    const loc = browserGlobals().location;
    const proto = loc.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${loc.host}/api/ws`;
  },
  (fn, ms) => {
    browserGlobals().window.setTimeout(fn, ms);
  },
);

export function startAgentSocket() {
  browserSocket.start();
}

export function stopAgentSocket() {
  browserSocket.stop();
}

export function onAgent(listener: Listener): () => void {
  return browserSocket.onAgent(listener);
}

export function watchChat(chatId: string, lastSeq: number) {
  browserSocket.watchChat(chatId, lastSeq);
}

export function unwatchChat(chatId: string) {
  browserSocket.unwatchChat(chatId);
}

export function noteSeq(chatId: string, seq: number) {
  browserSocket.noteSeq(chatId, seq);
}

export function sendCommand(command: object) {
  browserSocket.sendCommand(command);
}

function bytesToBase64(data: Uint8Array): string {
  let binary = "";
  const size = 0x8000;
  for (let index = 0; index < data.length; index += size) {
    binary += String.fromCharCode(...data.subarray(index, index + size));
  }
  return btoa(binary);
}

export function sendPty(chatId: string, data: string) {
  browserSocket.sendPty(chatId, data);
}

export function sendPtyResize(chatId: string, cols: number, rows: number) {
  sendCommand({ type: "pty_resize", chatId, cols, rows });
}
