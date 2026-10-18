import { summarizeInput, type PlanEntry, type StreamEvent, type ToolContent } from "@engineroom/protocol";
import { toolContentOf } from "../persist.ts";

export function mapUpdate(update: unknown): StreamEvent[] {
  if (!update || typeof update !== "object") return [];
  const body = update as Record<string, unknown>;
  switch (body.sessionUpdate) {
    case "agent_message_chunk": {
      const text = textOf(body.content);
      return text ? [{ type: "text_delta", text }] : [];
    }
    case "agent_thought_chunk": {
      const text = textOf(body.content ?? body);
      return text ? [{ type: "thinking", text }] : [];
    }
    case "user_message_chunk": {
      const text = textOf(body.content);
      return text ? [{ type: "user_message", text }] : [];
    }
    case "tool_call":
      return [toolEvent(body, "start")];
    case "tool_call_update":
      return [toolEvent(body, phaseOf(body.status))];
    case "plan":
      return [{ type: "plan", entries: planEntries(body.entries) }];
    case "current_mode_update": {
      const modeId = typeof body.currentModeId === "string" ? body.currentModeId : "";
      return modeId ? [{ type: "mode", modeId }] : [];
    }
    case "session_info_update": {
      const text = typeof body.title === "string" ? body.title.trim() : "";
      return text ? [{ type: "title", text }] : [];
    }
    default:
      return [];
  }
}

function toolEvent(body: Record<string, unknown>, phase: "start" | "done" | "error"): StreamEvent {
  const id = typeof body.toolCallId === "string" ? body.toolCallId : "tool";
  const title = typeof body.title === "string" ? body.title : "";
  const toolKind = typeof body.kind === "string" ? body.kind : "";
  const name = title || toolKind || "tool";
  const locations = Array.isArray(body.locations)
    ? body.locations
        .map((item) => (item && typeof item === "object" && typeof (item as { path?: unknown }).path === "string" ? (item as { path: string }).path : ""))
        .filter(Boolean)
    : undefined;
  const output = outputText(body.rawOutput);
  const content = toolContentOf(body) ?? toolContentOf(body.rawOutput) ?? diffContent(body.rawOutput);
  return {
    type: "tool",
    id,
    name,
    phase,
    input: phase === "start" ? summarizeInput(body.rawInput) : undefined,
    output: phase === "start" ? undefined : output,
    toolKind: toolKind || undefined,
    title: title || undefined,
    status: typeof body.status === "string" ? body.status : undefined,
    locations,
    content,
  };
}

function phaseOf(status: unknown): "start" | "done" | "error" {
  if (status === "completed") return "done";
  if (status === "failed") return "error";
  return "start";
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => textOf(item)).join("");
  if (!value || typeof value !== "object") return "";
  const record = value as { text?: unknown; content?: unknown };
  if (typeof record.text === "string") return record.text;
  if (record.content != null && record.content !== value) return textOf(record.content);
  return "";
}

function outputText(value: unknown): string {
  if (typeof value === "string") return clip(value);
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.content === "string") return clip(record.content);
  if (typeof record.stdout === "string") return clip(record.stdout);
  if (typeof record.output === "string") return clip(record.output);
  const nested = record.success ?? record.result ?? record.error;
  if (nested && nested !== value) return outputText(nested);
  return "";
}

function diffContent(value: unknown): ToolContent[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.path === "string" && (typeof record.oldText === "string" || typeof record.newText === "string" || typeof record.diff === "string")) {
    return [{
      type: "diff",
      path: record.path,
      oldText: typeof record.oldText === "string" ? record.oldText : undefined,
      newText: typeof record.newText === "string" ? record.newText : typeof record.diff === "string" ? record.diff : undefined,
    }];
  }
  return undefined;
}

function planEntries(value: unknown): PlanEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const entry = item as Record<string, unknown>;
      return {
        content: typeof entry.content === "string" ? entry.content : "",
        status: typeof entry.status === "string" ? entry.status : "pending",
        priority: typeof entry.priority === "string" ? entry.priority : undefined,
      };
    })
    .filter((entry) => entry.content);
}

function clip(text: string): string {
  return text.length > 8000 ? `${text.slice(0, 8000)}\n…` : text;
}
