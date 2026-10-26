import type { ToolContent, TranscriptEntry } from "@engineroom/protocol";

export type Block =
  | { kind: "text"; role: "user" | "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id: string; name: string; phase: string; input?: string; output?: string; toolKind?: string; content?: ToolContent[] }
  | { kind: "error"; text: string }
  | { kind: "status"; text: string };

export function groupTranscript(entries: TranscriptEntry[]): Block[] {
  const blocks: Block[] = [];
  for (const entry of entries) {
    if (entry.kind === "user") {
      blocks.push({ kind: "text", role: "user", text: entry.text });
      continue;
    }
    if (entry.kind === "text") {
      const last = blocks.at(-1);
      if (last?.kind === "text" && last.role === "assistant") last.text += entry.text;
      else blocks.push({ kind: "text", role: "assistant", text: entry.text });
      continue;
    }
    if (entry.kind === "thinking") {
      const last = blocks.at(-1);
      if (last?.kind === "thinking") last.text += entry.text;
      else blocks.push({ kind: "thinking", text: entry.text });
      continue;
    }
    if (entry.kind === "tool") {
      const prior = [...blocks].reverse().find((block) => block.kind === "tool" && block.id === entry.id);
      if (prior && prior.kind === "tool") {
        prior.phase = entry.phase;
        if (entry.name && entry.name !== "tool") prior.name = entry.name;
        if (entry.input) prior.input = entry.input;
        if (entry.output) prior.output = entry.output;
        if (entry.toolKind) prior.toolKind = entry.toolKind;
        if (entry.content?.length) prior.content = entry.content;
      } else {
        blocks.push({
          kind: "tool",
          id: entry.id,
          name: entry.title || entry.name,
          phase: entry.phase,
          input: entry.input,
          output: entry.output,
          toolKind: entry.toolKind,
          content: entry.content,
        });
      }
      continue;
    }
    if (entry.kind === "plan") continue;
    if (entry.kind === "error") blocks.push({ kind: "error", text: entry.text });
    else blocks.push({ kind: "status", text: entry.text });
  }
  return blocks;
}

const TERMINAL_KINDS = new Set(["execute", "shell"]);
const TERMINAL_NAMES = new Set(["bash", "sh", "shell", "zsh", "fish", "terminal", "execute", "cmd"]);

export function isTerminalTool(block: { name: string; toolKind?: string }): boolean {
  const kind = block.toolKind?.trim().toLowerCase() ?? "";
  if (TERMINAL_KINDS.has(kind)) return true;
  return TERMINAL_NAMES.has(block.name.trim().toLowerCase());
}

export function presentTool(block: { name: string; phase: string; input?: string; output?: string }): { title: string; body: string; command: string } {
  const command = terminalCommand(block.input);
  const action = readableField(block.input, ["command", "cmd", "globPattern", "glob_pattern", "pattern", "path", "file_path", "query", "url", "targetDirectory", "target_directory"]);
  const body = readableOutput(block.output);
  const title = action ? `${block.name} · ${action}` : `${block.name} · ${block.phase}`;
  return { title: title.length > 180 ? `${title.slice(0, 179)}…` : title, body, command };
}

function terminalCommand(value?: string): string {
  const record = parseRecord(value);
  if (!record) return clipView(value?.trim() ?? "");
  for (const key of ["command", "cmd"]) {
    if (typeof record[key] === "string" && record[key]) return clipView(record[key] as string);
  }
  return "";
}

function readableOutput(value?: string): string {
  const record = parseRecord(value);
  if (!record) return value?.trim() ?? "";
  const inner = unwrapRecord(record);
  for (const key of ["stdout", "interleavedOutput", "content", "error"]) {
    if (typeof inner[key] === "string" && inner[key]) return clipView(inner[key] as string);
  }
  if (Array.isArray(inner.files)) return clipView(inner.files.map(String).join("\n"));
  return clipView(value?.trim() ?? "");
}

function readableField(value: string | undefined, keys: string[]): string {
  const record = parseRecord(value);
  if (!record) {
    const line = value?.split("\n")[0]?.trim() ?? "";
    return line.length > 160 ? `${line.slice(0, 159)}…` : line;
  }
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key]) return record[key] as string;
  }
  return "";
}

function parseRecord(value?: string): Record<string, unknown> | null {
  if (!value || !value.trim().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function unwrapRecord(record: Record<string, unknown>): Record<string, unknown> {
  const nested = record.success ?? record.error ?? record.result ?? record.value;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) return unwrapRecord(nested as Record<string, unknown>);
  return record;
}

function clipView(text: string): string {
  return text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text;
}
