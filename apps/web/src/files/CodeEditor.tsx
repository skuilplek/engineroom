import { useEffect, useMemo, useRef, type KeyboardEvent, type UIEvent } from "react";
import { detectSyntaxLanguage, highlightCodeLines } from "./syntax.ts";

interface RevealTarget {
  path: string;
  line: number;
  column: number;
  key: number;
}

export function CodeEditor({
  filePath,
  value,
  readOnly,
  reveal = null,
  onChange,
  onSave,
}: {
  filePath: string;
  value: string;
  readOnly: boolean;
  reveal?: RevealTarget | null;
  onChange?: (next: string) => void;
  onSave?: () => void;
}) {
  const viewerRef = useRef<HTMLDivElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const language = useMemo(() => detectSyntaxLanguage(filePath), [filePath]);
  const tokenLines = useMemo(() => highlightCodeLines(value, language), [value, language]);

  useEffect(() => {
    if (!reveal) return;
    const line = Math.max(1, Math.min(reveal.line, tokenLines.length));
    if (readOnly) {
      const element = viewerRef.current?.querySelector<HTMLElement>(`[data-line="${line}"]`);
      element?.scrollIntoView({ block: "center" });
      return;
    }
    const textarea = textareaRef.current;
    if (!textarea) return;
    const linesBefore = value.split("\n");
    let start = 0;
    for (let i = 0; i < line - 1; i += 1) start += (linesBefore[i]?.length ?? 0) + 1;
    const lineText = linesBefore[line - 1] ?? "";
    const column = Math.max(0, Math.min(reveal.column - 1, lineText.length));
    const caret = start + column;
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(caret, caret);
    const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight) || 18.75;
    textarea.scrollTop = Math.max(0, (line - 1) * lineHeight - textarea.clientHeight / 2);
    if (preRef.current) {
      preRef.current.scrollTop = textarea.scrollTop;
      preRef.current.scrollLeft = textarea.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = textarea.scrollTop;
  }, [reveal, readOnly, filePath]);

  function syncScroll(event: UIEvent<HTMLTextAreaElement>) {
    const target = event.currentTarget;
    if (preRef.current) {
      preRef.current.scrollTop = target.scrollTop;
      preRef.current.scrollLeft = target.scrollLeft;
    }
    if (gutterRef.current) {
      gutterRef.current.scrollTop = target.scrollTop;
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (!readOnly && onSave) onSave();
      return;
    }
    if (readOnly || !onChange) return;

    const el = event.currentTarget;
    const start = el.selectionStart;
    const end = el.selectionEnd;

    if (event.key === "Tab") {
      event.preventDefault();
      if (event.shiftKey) {
        const lineStart = value.lastIndexOf("\n", start - 1) + 1;
        if (value.startsWith("  ", lineStart)) {
          const next = value.slice(0, lineStart) + value.slice(lineStart + 2);
          onChange(next);
          requestAnimationFrame(() => {
            el.selectionStart = Math.max(lineStart, start - 2);
            el.selectionEnd = Math.max(lineStart, end - 2);
          });
        }
      } else {
        const next = `${value.slice(0, start)}  ${value.slice(end)}`;
        onChange(next);
        requestAnimationFrame(() => {
          el.selectionStart = start + 2;
          el.selectionEnd = start + 2;
        });
      }
      return;
    }

    if (event.key === "Enter") {
      const lineStart = value.lastIndexOf("\n", start - 1) + 1;
      const currentLine = value.slice(lineStart, start);
      const indentMatch = currentLine.match(/^[ \t]+/);
      if (indentMatch) {
        event.preventDefault();
        const indent = indentMatch[0];
        const next = `${value.slice(0, start)}\n${indent}${value.slice(end)}`;
        onChange(next);
        const cursor = start + 1 + indent.length;
        requestAnimationFrame(() => {
          el.selectionStart = cursor;
          el.selectionEnd = cursor;
        });
      }
    }
  }

  if (readOnly) {
    return (
      <div className="code-viewer" role="region" aria-label={`Contents of ${filePath}`} ref={viewerRef}>
        <pre className="file-code">
          {tokenLines.map((tokens, index) => (
            <div
              className={reveal?.line === index + 1 ? "file-code-line revealed" : "file-code-line"}
              data-line={index + 1}
              key={index}
            >
              <span className="file-line-num">{index + 1}</span>
              <span className="file-line-text">
                {tokens.length === 0
                  ? "\n"
                  : tokens.map((token, tIndex) => (
                      <span className={`tok-${token.kind}`} key={tIndex}>
                        {token.text}
                      </span>
                    ))}
              </span>
            </div>
          ))}
        </pre>
      </div>
    );
  }

  return (
    <div className="code-editor-shell">
      <div className="code-editor-gutter" ref={gutterRef} aria-hidden="true">
        {tokenLines.map((_, index) => (
          <div className="code-gutter-line" key={index}>
            {index + 1}
          </div>
        ))}
      </div>
      <div className="code-editor-stage">
        <pre className="code-editor-highlight" ref={preRef} aria-hidden="true">
          {tokenLines.map((tokens, index) => (
            <div
              className={reveal?.line === index + 1 ? "code-highlight-line revealed" : "code-highlight-line"}
              key={index}
            >
              <span className="code-highlight-num">{index + 1}</span>
              <span className="code-highlight-text">
                {tokens.length === 0
                  ? " "
                  : tokens.map((token, tIndex) => (
                      <span className={`tok-${token.kind}`} key={tIndex}>
                        {token.text}
                      </span>
                    ))}
              </span>
            </div>
          ))}
        </pre>
        <textarea
          ref={textareaRef}
          className="code-editor-input"
          value={value}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          aria-label={`Edit ${filePath}`}
          onScroll={syncScroll}
          onKeyDown={handleKeyDown}
          onChange={(event) => onChange?.(event.target.value)}
        />
      </div>
    </div>
  );
}
