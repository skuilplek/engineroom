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
  const output = outputText(body.rawOutput) || outputText(body.content) || locationText(body.locations);
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
  const text = visibleText(value);
  return text ? clip(text) : "";
}

function visibleText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(visibleText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string" && record.text) return record.text;
  if (typeof record.interleavedOutput === "string" && record.interleavedOutput) return record.interleavedOutput;
  if (typeof record.stdout === "string" || typeof record.stderr === "string") {
    const combined = [record.stdout, record.stderr].filter((part) => typeof part === "string" && part).join("");
    if (combined) return combined;
  }
  if (typeof record.output === "string" && record.output) return record.output;
  if (typeof record.content === "string" && record.content) return record.content;
  if (typeof record.path === "string" && (record.type === "resource_link" || record.type === "location")) return record.path;
  const nested = record.content ?? record.success ?? record.result ?? record.error ?? record.value;
  if (nested != null && nested !== value) return visibleText(nested);
  return "";
}

function locationText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => (item && typeof item === "object" && typeof (item as { path?: unknown }).path === "string" ? (item as { path: string }).path : ""))
    .filter(Boolean)
    .join("\n");
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
