import { detectSyntaxLanguage, highlightCodeLines, type SyntaxToken } from "../files/syntax.ts";
import { FileTokenButton } from "./LinkedText.tsx";

export function DiffView({
  path,
  oldText = "",
  newText = "",
  onOpenFile,
}: {
  path: string;
  oldText?: string;
  newText?: string;
  onOpenFile?: (path: string) => void;
}) {
  const language = detectSyntaxLanguage(path);
  const rows = numberedDiff(lineDiff(oldText, newText));
  const digits = Math.max(1, String(rows.reduce((max, row) => Math.max(max, row.line ?? 0), 0)).length);
  return (
    <div className="diff">
      <div className="diff-path">
        <FileTokenButton token={path} onOpenFile={onOpenFile} allowBare>
          {path}
        </FileTokenButton>
      </div>
      <pre><div className="diff-rows">
        {rows.map((row, index) => (
          <div className={`diff-line ${row.kind}`} key={index}>
            <span className="diff-gutter" style={{ gridTemplateColumns: `${digits}ch 1ch` }} aria-hidden="true">
              <span className="diff-num">{row.line ?? "\u00a0"}</span>
              <span className="diff-mark">{row.kind === "add" ? "+" : row.kind === "del" ? "−" : "\u00a0"}</span>
            </span>
            {row.kind !== "same" && <span className="diff-sr">{row.kind === "add" ? "Added line " : "Removed line "}</span>}
            <span className="diff-text">{renderTokens(lineTokens(row.text, language))}</span>
          </div>
        ))}
      </div></pre>
    </div>
  );
}

function lineTokens(text: string, language: ReturnType<typeof detectSyntaxLanguage>): SyntaxToken[] {
  if (!text) return [];
  return highlightCodeLines(text, language)[0] ?? [];
}

function renderTokens(tokens: SyntaxToken[]) {
  if (tokens.length === 0) return "\u00a0";
  return tokens.map((token, index) => (
    <span className={`tok-${token.kind}`} key={index}>{token.text}</span>
  ));
}

function numberedDiff(rows: { kind: "same" | "add" | "del"; text: string }[]) {
  let next = 1;
  return rows.map((row) => {
    if (row.kind === "del") return { ...row, line: null as number | null };
    const line = next;
    next += 1;
    return { ...row, line };
  });
}

function lineDiff(oldText: string, newText: string): { kind: "same" | "add" | "del"; text: string }[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const rows: { kind: "same" | "add" | "del"; text: string }[] = [];
  const seen = new Map<string, number>();
  for (const line of newLines) seen.set(line, (seen.get(line) ?? 0) + 1);
  const used = new Map<string, number>();
  for (const line of oldLines) {
    const available = seen.get(line) ?? 0;
    const taken = used.get(line) ?? 0;
    if (taken < available) {
      used.set(line, taken + 1);
      rows.push({ kind: "same", text: line });
    } else rows.push({ kind: "del", text: line });
  }
  const emitted = new Map<string, number>();
  const sameCount = new Map<string, number>();
  for (const row of rows) {
    if (row.kind === "same") sameCount.set(row.text, (sameCount.get(row.text) ?? 0) + 1);
  }
  const rebuilt: { kind: "same" | "add" | "del"; text: string }[] = [];
  let oldIndex = 0;
  for (const line of newLines) {
    while (oldIndex < rows.length && rows[oldIndex]?.kind === "del") {
      rebuilt.push(rows[oldIndex]!);
      oldIndex += 1;
    }
    const already = emitted.get(line) ?? 0;
    if (already < (sameCount.get(line) ?? 0)) {
      rebuilt.push({ kind: "same", text: line });
      emitted.set(line, already + 1);
      while (oldIndex < rows.length && !(rows[oldIndex]?.kind === "same" && rows[oldIndex]?.text === line)) oldIndex += 1;
      oldIndex += 1;
    } else rebuilt.push({ kind: "add", text: line });
  }
  while (oldIndex < rows.length) {
    rebuilt.push(rows[oldIndex]!);
    oldIndex += 1;
  }
  return rebuilt.slice(0, 400);
}
