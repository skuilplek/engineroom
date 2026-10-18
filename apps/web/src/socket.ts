import { decodePtyFrame, encodePtyFrame, type ChatMeta, type ListedSession, type StreamEvent, type TranscriptEntry } from "@engineroom/protocol";

export interface AgentMode {
  id: string;
  name: string;
  description?: string;
}

export interface AgentModel {
  modelId: string;
  name: string;
}

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
      scrollback?: string;
    }
  | { type: "event"; chatId: string; seq: number; at: string; event: StreamEvent }
  | { type: "chats_changed" }
  | { type: "pty"; chatId: string; data: Uint8Array }
  | { type: "sessions"; sessions: ListedSession[] }
  | { type: "imported"; chat: ChatMeta }
  | { type: "accepted"; chatId: string; queued: boolean }
  | { type: "pty_open"; chatId: string; attached?: boolean; scrollback?: string }
  | { type: "error"; error: string };

type Listener = (message: ServerMessage) => void;

const listeners = new Set<Listener>();
const watches = new Map<string, number>();
const pending: object[] = [];
let socket: WebSocket | null = null;
let retry = 500;
let started = false;

export function startAgentSocket() {
  if (started && socket && socket.readyState !== WebSocket.CLOSED) return;
  started = true;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/api/ws`);
  ws.binaryType = "arraybuffer";
  socket = ws;
  ws.onopen = () => {
    retry = 500;
    for (const command of pending.splice(0)) ws.send(JSON.stringify(command));
    for (const [chatId, lastSeq] of watches) ws.send(JSON.stringify({ type: "watch", chatId, lastSeq }));
  };
  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      const frame = decodePtyFrame(new Uint8Array(event.data));
      if (frame) emit({ type: "pty", chatId: frame.chatId, data: frame.data });
      return;
    }
    try {
      emit(JSON.parse(String(event.data)) as ServerMessage);
    } catch {
      /* ignore a malformed frame */
    }
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    window.setTimeout(() => startAgentSocket(), retry);
    retry = Math.min(retry * 2, 8000);
  };
}

export function onAgent(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function watchChat(chatId: string, lastSeq: number) {
  watches.set(chatId, lastSeq);
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "watch", chatId, lastSeq }));
}

export function unwatchChat(chatId: string) {
  watches.delete(chatId);
  send({ type: "unwatch", chatId }, false);
}

export function noteSeq(chatId: string, seq: number) {
  const current = watches.get(chatId);
  if (current == null || seq <= current) return;
  watches.set(chatId, seq);
}

export function sendCommand(command: object) {
  send(command, true);
}

export function sendPty(chatId: string, data: string) {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(encodePtyFrame(chatId, new TextEncoder().encode(data)));
}

export function sendPtyResize(chatId: string, cols: number, rows: number) {
  sendCommand({ type: "pty_resize", chatId, cols, rows });
}

function send(command: object, queue: boolean) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(command));
    return;
  }
  if (queue) pending.push(command);
}

function emit(message: ServerMessage) {
  for (const listener of listeners) listener(message);
}
