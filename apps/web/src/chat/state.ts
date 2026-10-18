import type { AgentId, ChatMeta, PermissionOption, PlanEntry, StreamEvent, TranscriptEntry } from "@engineroom/protocol";
import type { AgentMode, AgentModel } from "../socket.ts";

export interface LivePermission {
  requestId: string;
  title?: string;
  options: PermissionOption[];
}

export interface ChatLive {
  entries: TranscriptEntry[];
  seq: number;
  running: boolean;
  title: string;
  agent: AgentId;
  workspace: string;
  mode: string;
  model: string;
  modes: AgentMode[];
  models: AgentModel[];
  permission: LivePermission | null;
  queue: string[];
  shell: string;
  ready: boolean;
}

export function emptyLive(chat?: ChatMeta): ChatLive {
  return {
    entries: [],
    seq: 0,
    running: Boolean(chat?.running),
    title: chat?.title || "New chat",
    agent: chat?.agent || "cursor",
    workspace: chat?.workspace || "",
    mode: chat?.mode || "agent",
    model: chat?.model || "",
    modes: [],
    models: [],
    permission: null,
    queue: [],
    shell: "",
    ready: false,
  };
}

export function applySnapshot(state: ChatLive, snapshot: {
  transcript: TranscriptEntry[];
  seq: number;
  running: boolean;
  chat: ChatMeta;
  modes?: { currentModeId: string; availableModes: AgentMode[] } | null;
  models?: { currentModelId: string; availableModels: AgentModel[] } | null;
}): ChatLive {
  return {
    ...state,
    entries: snapshot.transcript,
    seq: snapshot.seq,
    running: snapshot.running,
    title: snapshot.chat.title,
    agent: snapshot.chat.agent,
    workspace: snapshot.chat.workspace,
    mode: snapshot.modes?.currentModeId || snapshot.chat.mode || state.mode,
    model: snapshot.models?.currentModelId || snapshot.chat.model || state.model,
    modes: snapshot.modes?.availableModes || state.modes,
    models: snapshot.models?.availableModels || state.models,
    shell: shellFrom(snapshot.transcript),
    ready: true,
  };
}

export function applyEvent(state: ChatLive, event: StreamEvent, seq: number): ChatLive {
  if (seq <= state.seq) return state;
  const next = { ...state, seq };
  if (event.type === "user_message") {
    next.entries = [...state.entries, { kind: "user", text: event.text, at: stamp(), seq }];
    next.queue = state.queue.filter((item) => item !== event.text);
    return next;
  }
  if (event.type === "text_delta") {
    next.entries = [...state.entries, { kind: "text", text: event.text, at: stamp(), seq }];
    return next;
  }
  if (event.type === "thinking") {
    next.entries = [...state.entries, { kind: "thinking", text: event.text, at: stamp(), seq }];
    return next;
  }
  if (event.type === "tool") {
    next.entries = [...state.entries, {
      kind: "tool",
      id: event.id,
      name: event.title || event.name,
      phase: event.phase,
      input: event.input,
      output: event.output,
      toolKind: event.toolKind,
      title: event.title,
      content: event.content,
      at: stamp(),
      seq,
    }];
    if (event.output && (event.toolKind === "execute" || event.toolKind === "shell")) next.shell = event.output;
    return next;
  }
  if (event.type === "terminal_output") {
    next.shell = (state.shell + event.data).slice(-16000);
    return next;
  }
  if (event.type === "plan") {
    next.entries = [...state.entries, { kind: "plan", entries: event.entries, at: stamp(), seq }];
    return next;
  }
  if (event.type === "permission_request") {
    next.permission = { requestId: event.requestId, title: event.title, options: event.options };
    return next;
  }
  if (event.type === "permission_resolved") {
    next.permission = state.permission?.requestId === event.requestId ? null : state.permission;
    return next;
  }
  if (event.type === "queued") {
    next.queue = [...state.queue, event.text];
    return next;
  }
  if (event.type === "mode") {
    next.mode = event.modeId;
    return next;
  }
  if (event.type === "title") {
    next.title = event.text;
    return next;
  }
  if (event.type === "turn_start") {
    next.running = true;
    return next;
  }
  if (event.type === "turn_end" || event.type === "done") {
    next.running = false;
    return next;
  }
  if (event.type === "error") {
    next.entries = [...state.entries, { kind: "error", text: event.text, at: stamp(), seq }];
    next.running = false;
    return next;
  }
  if (event.type === "status") {
    next.entries = [...state.entries, { kind: "status", text: event.text, at: stamp(), seq }];
  }
  return next;
}

export function latestPlan(entries: TranscriptEntry[]): PlanEntry[] {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind === "plan") return entry.entries;
  }
  return [];
}

function shellFrom(entries: TranscriptEntry[]): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind === "tool" && entry.output && (entry.toolKind === "execute" || entry.toolKind === "shell")) return entry.output;
  }
  return "";
}

function stamp(): string {
  return new Date().toISOString();
}
