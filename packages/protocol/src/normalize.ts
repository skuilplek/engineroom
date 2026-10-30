import type { AgentId, StreamEvent } from "./index.ts";

export interface CliParser {
  readonly sessionId: string | null;
  push(value: unknown): StreamEvent[];
  finish(): StreamEvent[];
}

export function createCliParser(agent: AgentId, knownSessionId: string | null): CliParser {
  let sessionId = knownSessionId;
  const locked = knownSessionId != null && knownSessionId !== "";
  let accumulated = "";
  let sawText = false;
  let toolSeq = 0;
  const piRun: PiRun = { pendingError: "", shownError: "" };

  function noteSession(value: unknown) {
    if (locked) return;
    if (typeof value === "string" && value.trim() && !sessionId) sessionId = value.trim();
  }

  function textFromAssistant(text: string): StreamEvent[] {
    if (!text) return [];
    if (text.startsWith(accumulated)) {
      const suffix = text.slice(accumulated.length);
      accumulated = text;
      if (!suffix) return [];
      sawText = true;
      return [{ type: "text_delta", text: suffix }];
    }
    accumulated += text;
    sawText = true;
    return [{ type: "text_delta", text }];
  }

  function resetText() {
    accumulated = "";
  }

  return {
    get sessionId() {
      return sessionId;
    },
    finish(): StreamEvent[] {
      return takePiError(piRun);
    },
    push(value: unknown): StreamEvent[] {
      if (!value || typeof value !== "object") return [];
      const msg = value as Record<string, unknown>;
      noteSession(msg.session_id);
      if (agent === "pi") return pushPi(msg, noteSession, () => `tool-${++toolSeq}`, piRun);
      if (msg.type === "assistant") {
        return pushAssistantMessage(msg.message, textFromAssistant, () => {
          toolSeq += 1;
          return `tool-${toolSeq}`;
        });
      }
      if (msg.type === "user") return pushToolResults(msg.message);
      if (msg.type === "thinking") {
        if (msg.subtype === "completed") return [];
        const text = typeof msg.text === "string" ? msg.text : "";
        if (!text) return [];
        return [{ type: "thinking", text }];
      }
      if (msg.type === "retry" || msg.type === "connection") {
        const subtype = typeof msg.subtype === "string" ? msg.subtype : "";
        return [{ type: "status", text: subtype ? `${msg.type} · ${subtype}` : String(msg.type) }];
      }
      if (msg.type === "tool_call") {
        resetText();
        return pushCursorTool(msg, () => {
          toolSeq += 1;
          return `tool-${toolSeq}`;
        });
      }
      if (msg.type === "system" && msg.subtype === "init") {
        const model = typeof msg.model === "string" ? msg.model : "";
        return [{ type: "status", text: model ? `Connected · ${model}` : "Connected" }];
      }
      if (msg.type === "result") {
        resetText();
        noteSession(msg.session_id);
        const failed = msg.is_error === true || (msg.subtype && msg.subtype !== "success");
        const events: StreamEvent[] = [];
        if (failed) {
          const detail =
            typeof msg.result === "string" && msg.result.trim()
              ? msg.result.trim()
              : `agent failed (${String(msg.subtype ?? "error")})`;
          events.push({ type: "error", text: detail.slice(0, 4000) });
        } else if (!sawText && typeof msg.result === "string" && msg.result) {
          events.push({ type: "text_delta", text: msg.result });
        }
        events.push({ type: "done", agentSessionId: sessionId });
        return events;
      }
      if (msg.type === "error") {
        const text = stringField(msg, "message") || stringField(msg, "error") || "agent error";
        return [{ type: "error", text }];
      }
      return [];
    },
  };
}

function pushAssistantMessage(
  message: unknown,
  textFromAssistant: (text: string) => StreamEvent[],
  nextId: () => string,
): StreamEvent[] {
  const content = contentBlocks(message);
  const events: StreamEvent[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      events.push(...textFromAssistant(block.text));
    } else if (block.type === "tool_use") {
      const id = typeof block.id === "string" ? block.id : nextId();
      const name = typeof block.name === "string" ? block.name : "tool";
      events.push({
        type: "tool",
        id,
        name,
        phase: "start",
        input: summarizeInput(block.input),
      });
    }
  }
  return events;
}

function pushToolResults(message: unknown): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const block of contentBlocks(message)) {
    if (block.type !== "tool_result") continue;
    const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "tool";
    const output = toolResultText(block.content ?? block.output);
    const failed = block.is_error === true;
    events.push({
      type: "tool",
      id,
      name: "tool",
      phase: failed ? "error" : "done",
      output,
    });
  }
  return events;
}

function pushCursorTool(msg: Record<string, unknown>, nextId: () => string): StreamEvent[] {
  const id = typeof msg.call_id === "string" ? msg.call_id : nextId();
  const summary = summarizeToolCall(msg.tool_call);
  const phase = msg.subtype === "completed" ? "done" : msg.subtype === "error" ? "error" : "start";
  return [
    {
      type: "tool",
      id,
      name: summary.name,
      phase,
      input: phase === "start" ? summary.input : undefined,
      output: phase === "start" ? undefined : summary.output,
    },
  ];
}

interface PiRun {
  pendingError: string;
  shownError: string;
}

function pushPi(
  msg: Record<string, unknown>,
  noteSession: (value: unknown) => void,
  nextId: () => string,
  run: PiRun,
): StreamEvent[] {
  noteSession(msg.session_id ?? msg.sessionId ?? (msg.type === "session" ? msg.id : undefined));
  const update = msg.assistantMessageEvent;
  if (msg.type === "message_update" && update && typeof update === "object") {
    const event = update as Record<string, unknown>;
    if (event.type === "text_delta" && typeof event.delta === "string") {
      return [{ type: "text_delta", text: event.delta }];
    }
    if (event.type === "thinking_delta" && typeof event.delta === "string" && event.delta) {
      return [{ type: "thinking", text: event.delta }];
    }
    if (event.type === "error") {
      notePiFailure(run, event);
      return [];
    }
    if (event.type === "toolcall_start") {
      const id = typeof event.id === "string" ? event.id : nextId();
      const name = typeof event.toolName === "string" ? event.toolName : "tool";
      return [{ type: "tool", id, name, phase: "start" }];
    }
    if (event.type === "toolcall_end") {
      const call = (event.toolCall ?? {}) as Record<string, unknown>;
      const id = typeof call.id === "string" ? call.id : nextId();
      const name = typeof call.name === "string" ? call.name : "tool";
      return [
        {
          type: "tool",
          id,
          name,
          phase: "start",
          input: summarizeInput(call.arguments ?? call.args),
        },
      ];
    }
  }
  if (msg.type === "message_end") {
    notePiAssistant(run, msg.message);
    return [];
  }
  if (msg.type === "tool_execution_start" || msg.type === "tool_execution_end") {
    const id = typeof msg.toolCallId === "string" ? msg.toolCallId : nextId();
    const name = typeof msg.toolName === "string" ? msg.toolName : "tool";
    if (msg.type === "tool_execution_start") {
      return [{ type: "tool", id, name, phase: "start", input: summarizeInput(msg.args) }];
    }
    return [
      {
        type: "tool",
        id,
        name,
        phase: msg.isError === true ? "error" : "done",
        output: toolResultText(msg.result),
      },
    ];
  }
  if (msg.type === "turn_end") {
    notePiAssistant(run, msg.message);
    return [];
  }
  if (msg.type === "agent_end") {
    notePiMessages(run, msg.messages);
    if (msg.willRetry === true) return [];
    return takePiError(run);
  }
  if (msg.type === "agent_settled") return [...takePiError(run), { type: "done", agentSessionId: null }];
  if (msg.type === "auto_retry_start") {
    const detail = stringField(msg, "errorMessage");
    return [{ type: "status", text: detail ? `Retrying · ${detail}` : "Retrying" }];
  }
  if (msg.type === "auto_retry_end") {
    if (msg.success !== false) return [];
    rememberPiError(run, stringField(msg, "finalError"));
    return takePiError(run);
  }
  if (msg.type === "compaction_start") {
    const reason = stringField(msg, "reason");
    return [{ type: "status", text: reason ? `Compacting · ${reason}` : "Compacting" }];
  }
  if (msg.type === "error") {
    return [{ type: "error", text: stringField(msg, "message") || stringField(msg, "error") || "agent error" }];
  }
  return [];
}

function notePiFailure(run: PiRun, event: Record<string, unknown>) {
  if (typeof event.error === "string") rememberPiError(run, event.error);
  else notePiAssistant(run, event.error);
  rememberPiError(run, stringField(event, "errorMessage"));
}

function notePiAssistant(run: PiRun, message: unknown) {
  if (!message || typeof message !== "object") return;
  const record = message as Record<string, unknown>;
  if (record.role != null && record.role !== "assistant") return;
  if (record.stopReason === "error") {
    rememberPiError(run, stringField(record, "errorMessage"));
    return;
  }
  if (typeof record.stopReason === "string" && record.stopReason) clearPiError(run);
}

function notePiMessages(run: PiRun, messages: unknown) {
  if (!Array.isArray(messages)) return;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index];
    if (!item || typeof item !== "object" || (item as Record<string, unknown>).role !== "assistant") continue;
    notePiAssistant(run, item);
    return;
  }
}

function rememberPiError(run: PiRun, text: string) {
  const trimmed = text.trim();
  if (!trimmed) return;
  const clipped = trimmed.length > 4000 ? trimmed.slice(0, 4000) : trimmed;
  if (clipped === run.shownError) return;
  run.pendingError = clipped;
}

function clearPiError(run: PiRun) {
  run.pendingError = "";
  run.shownError = "";
}

function takePiError(run: PiRun): StreamEvent[] {
  if (!run.pendingError) return [];
  const text = run.pendingError;
  run.pendingError = "";
  run.shownError = text;
  return [{ type: "error", text }];
}

function contentBlocks(message: unknown): Record<string, unknown>[] {
  if (!message || typeof message !== "object") return [];
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  return content.filter((item) => item && typeof item === "object") as Record<string, unknown>[];
}

function toolResultText(value: unknown): string {
  if (typeof value === "string") return clipText(value);
  if (Array.isArray(value)) {
    const parts = value.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && typeof (item as Record<string, unknown>).text === "string") {
        return (item as Record<string, unknown>).text as string;
      }
      return "";
    });
    return clipText(parts.filter(Boolean).join("\n"));
  }
  if (value && typeof value === "object") {
    const record = unwrapToolPayload(value as Record<string, unknown>);
    if (typeof record.stdout === "string" && record.stdout) return clipText(record.stdout);
    if (typeof record.interleavedOutput === "string" && record.interleavedOutput) return clipText(record.interleavedOutput);
    if (typeof record.content === "string" && record.content) return clipText(record.content);
    if (typeof record.error === "string" && record.error) return clipText(record.error);
    return clipText(JSON.stringify(record));
  }
  return "";
}

export function summarizeToolCall(value: unknown): { name: string; input: string; output: string } {
  if (!value || typeof value !== "object") return { name: "tool", input: "", output: "" };
  const record = value as Record<string, unknown>;
  const directName = stringField(record, "name") || stringField(record, "toolName");
  const toolCase = record.tool && typeof record.tool === "object" ? (record.tool as Record<string, unknown>).case : undefined;
  const key = Object.keys(record).find((item) => item.endsWith("ToolCall") || item.endsWith("toolCall"));
  const nested = key && record[key] && typeof record[key] === "object" ? (record[key] as Record<string, unknown>) : undefined;
  const caseValue =
    toolCase && typeof toolCase === "string"
      ? ((record.tool as Record<string, unknown>).value as Record<string, unknown> | undefined)
      : undefined;
  const body = nested || caseValue || record;
  const name = directName || (typeof toolCase === "string" ? prettyTool(toolCase) : key ? prettyTool(key) : "tool");
  const args = body.args ?? body.arguments ?? body.input ?? body.params;
  const result = body.result ?? record.result;
  return {
    name,
    input: summarizeInput(args),
    output: toolResultText(result),
  };
}

function prettyTool(name: string): string {
  return name.replace(/ToolCall$/, "").replace(/[_-]+/g, " ").trim() || "tool";
}

export function summarizeInput(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return clipText(value);
  if (typeof value !== "object") return clipText(String(value));
  const record = value as Record<string, unknown>;
  for (const key of ["command", "cmd", "file_path", "path", "targetDirectory", "target_directory", "globPattern", "glob_pattern", "pattern", "query", "url", "description"]) {
    if (typeof record[key] === "string" && record[key]) return clipText(record[key] as string);
  }
  return clipText(JSON.stringify(value));
}

function stringField(record: Record<string, unknown>, key: string): string {
  return typeof record[key] === "string" ? (record[key] as string) : "";
}

function unwrapToolPayload(record: Record<string, unknown>): Record<string, unknown> {
  const nested = record.success ?? record.error ?? record.result ?? record.value;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) return unwrapToolPayload(nested as Record<string, unknown>);
  return record;
}

function clipText(text: string): string {
  return text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text;
}
