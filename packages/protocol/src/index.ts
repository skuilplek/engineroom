export const AGENTS = ["cursor", "claude", "pi"] as const;

export type AgentId = (typeof AGENTS)[number];

export const USERNAME_RE = /^[a-zA-Z_][a-zA-Z0-9_-]{0,31}$/;

export const CHAT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Settings {
  defaultAgent: AgentId;
  defaultModel: string;
  binaries: Partial<Record<AgentId, string>>;
}

export interface SettingsPatch {
  defaultAgent?: AgentId;
  defaultModel?: string;
  binaries?: Partial<Record<AgentId, string | null>>;
}

export interface ChatMeta {
  id: string;
  title: string;
  agent: AgentId;
  model: string;
  workspace: string;
  agentSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  running?: boolean;
}

export type TranscriptEntry =
  | { kind: "user"; text: string; at: string }
  | { kind: "text"; text: string; at: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      phase: "start" | "done" | "error";
      input?: string;
      output?: string;
      at: string;
    }
  | { kind: "error"; text: string; at: string }
  | { kind: "status"; text: string; at: string };

export interface ChatDetail {
  chat: ChatMeta;
  transcript: TranscriptEntry[];
}

export interface WorkspaceEntry {
  path: string;
  name: string;
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | {
      type: "tool";
      id: string;
      name: string;
      phase: "start" | "done" | "error";
      input?: string;
      output?: string;
    }
  | { type: "status"; text: string }
  | { type: "error"; text: string }
  | { type: "done"; agentSessionId?: string | null };

export type RunnerRequest =
  | { id: string; type: "list_chats" }
  | { id: string; type: "get_chat"; chatId: string }
  | {
      id: string;
      type: "create_chat";
      agent?: AgentId;
      model?: string;
      workspace?: string;
      title?: string;
    }
  | { id: string; type: "get_settings" }
  | { id: string; type: "put_settings"; settings: SettingsPatch }
  | { id: string; type: "list_workspaces" }
  | { id: string; type: "send"; chatId: string; prompt: string }
  | { id: string; type: "cancel"; chatId: string };

export type RunnerResponse =
  | { id: string; type: "event"; event: StreamEvent }
  | { id: string; type: "ok"; result: unknown }
  | { id: string; type: "error"; error: string };

export const DEFAULT_SETTINGS: Settings = {
  defaultAgent: "cursor",
  defaultModel: "",
  binaries: {},
};

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && (AGENTS as readonly string[]).includes(value);
}

export function assertUsername(value: string): string {
  if (!USERNAME_RE.test(value)) throw new Error("invalid username");
  return value;
}

export function assertChatId(value: unknown): string {
  if (typeof value !== "string" || !CHAT_ID_RE.test(value)) {
    throw new Error("invalid chat id");
  }
  return value;
}

export function cleanModel(value: unknown): string {
  if (value == null || value === "") return "";
  if (typeof value !== "string") throw new Error("model must be a string");
  const model = value.trim();
  if (model.length > 200) throw new Error("model is too long");
  if (/[\r\n\0]/.test(model)) throw new Error("model is invalid");
  return model;
}

export function cleanTitle(value: unknown): string {
  if (typeof value !== "string") return "";
  const title = value.replace(/\s+/g, " ").trim();
  return title.length > 120 ? title.slice(0, 120) : title;
}

export function titleFromPrompt(prompt: string): string {
  const line = prompt.replace(/\s+/g, " ").trim();
  if (!line) return "New chat";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

export function loginAllowed(
  user: { uid: number; shell: string; groups: string[] },
  group = "engineroom-users",
): boolean {
  if (!Number.isInteger(user.uid) || user.uid < 1000) return false;
  const base = user.shell.split("/").pop() || "";
  if (base === "nologin" || base === "false" || base === "sync") return false;
  return user.groups.includes(group);
}

export function isInsidePath(root: string, target: string): boolean {
  const rel = relativePosix(root, target);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

function relativePosix(root: string, target: string): string {
  const from = root.endsWith("/") ? root.slice(0, -1) : root;
  const to = target.endsWith("/") ? target.slice(0, -1) : target;
  if (from === to) return "";
  if (to.startsWith(`${from}/`)) return to.slice(from.length + 1);
  return `../${to}`;
}

export function socketPathForUser(dir: string, username: string): string {
  assertUsername(username);
  const root = stripSlash(dir);
  if (!root.startsWith("/")) throw new Error("socket directory must be absolute");
  return `${root}/${username}.sock`;
}

function stripSlash(dir: string): string {
  return dir.length > 1 && dir.endsWith("/") ? dir.slice(0, -1) : dir;
}

export function parseRunnerRequest(value: unknown): RunnerRequest {
  if (!value || typeof value !== "object") throw new Error("invalid request");
  const body = value as Record<string, unknown>;
  if (typeof body.id !== "string" || body.id.length < 1 || body.id.length > 80) {
    throw new Error("invalid request id");
  }
  switch (body.type) {
    case "list_chats":
    case "get_settings":
    case "list_workspaces":
      return { id: body.id, type: body.type };
    case "get_chat":
    case "cancel":
      return { id: body.id, type: body.type, chatId: assertChatId(body.chatId) };
    case "create_chat": {
      const agent = body.agent == null ? undefined : body.agent;
      if (agent != null && !isAgentId(agent)) throw new Error("invalid agent");
      return {
        id: body.id,
        type: "create_chat",
        agent,
        model: body.model == null ? undefined : cleanModel(body.model),
        workspace: optionalString(body.workspace, "workspace", 4096),
        title: body.title == null ? undefined : cleanTitle(body.title),
      };
    }
    case "put_settings":
      return { id: body.id, type: "put_settings", settings: parseSettingsPatch(body.settings) };
    case "send": {
      const prompt = optionalString(body.prompt, "prompt", 100_000);
      if (!prompt?.trim()) throw new Error("prompt is empty");
      return { id: body.id, type: "send", chatId: assertChatId(body.chatId), prompt };
    }
    default:
      throw new Error("unknown request");
  }
}

function optionalString(value: unknown, label: string, max: number): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (value.length > max) throw new Error(`${label} is too long`);
  return value;
}

export function parseSettingsPatch(value: unknown): SettingsPatch {
  if (!value || typeof value !== "object") throw new Error("invalid settings");
  const body = value as Record<string, unknown>;
  const patch: SettingsPatch = {};
  if (body.defaultAgent != null) {
    if (!isAgentId(body.defaultAgent)) throw new Error("invalid agent");
    patch.defaultAgent = body.defaultAgent;
  }
  if (body.defaultModel != null) patch.defaultModel = cleanModel(body.defaultModel);
  if (body.binaries != null) {
    if (typeof body.binaries !== "object") throw new Error("invalid binaries");
    const binaries: SettingsPatch["binaries"] = {};
    for (const agent of AGENTS) {
      const raw = (body.binaries as Record<string, unknown>)[agent];
      if (raw == null || raw === "") {
        binaries[agent] = null;
        continue;
      }
      if (typeof raw !== "string" || !raw.startsWith("/") || raw.length > 4096) {
        throw new Error(`${agent} binary must be an absolute path`);
      }
      if (raw.includes("\0") || raw.includes("\n")) throw new Error("invalid binary path");
      binaries[agent] = raw;
    }
    patch.binaries = binaries;
  }
  return patch;
}

export function applySettings(current: Settings, patch: SettingsPatch): Settings {
  const next: Settings = {
    defaultAgent: patch.defaultAgent ?? current.defaultAgent,
    defaultModel: patch.defaultModel ?? current.defaultModel,
    binaries: { ...current.binaries },
  };
  if (patch.binaries) {
    for (const agent of AGENTS) {
      if (!(agent in patch.binaries)) continue;
      const value = patch.binaries[agent];
      if (value == null || value === "") delete next.binaries[agent];
      else next.binaries[agent] = value;
    }
  }
  return next;
}

export function clip(text: string, max = 4000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…`;
}

export { createCliParser, type CliParser } from "./normalize.ts";
