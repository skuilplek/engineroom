import { DiffView } from "./Diff.tsx";
import { isTerminalTool, presentTool, type Block } from "./group.ts";

type ToolBlockData = Extract<Block, { kind: "tool" }>;

const GENERIC_TERMINAL_NAMES = new Set(["bash", "sh", "shell", "zsh", "fish", "terminal", "execute", "cmd", "tool"]);

export function ToolBlock({ block, showRunning = false }: { block: ToolBlockData; showRunning?: boolean }) {
  const shown = presentTool(block);
  const diff = block.content?.find((item) => item.type === "diff");
  const diffView = diff && diff.type === "diff"
    ? <DiffView path={diff.path} oldText={diff.oldText} newText={diff.newText} />
    : null;
  const notes = (block.content ?? [])
    .filter((item) => item.type === "text" && item.text && !shown.body.includes(item.text))
    .map((item) => item.type === "text" ? item.text : "")
    .join("\n\n");
  const body = [shown.body, notes].filter(Boolean).join("\n\n");
  const output = body
    ? <pre>{body}</pre>
    : showRunning && block.phase === "start"
      ? <pre className="pulse">running…</pre>
      : null;
  const named = block.name.trim().toLowerCase();
  const command = isTerminalTool(block)
    ? shown.command || (GENERIC_TERMINAL_NAMES.has(named) ? "" : block.name)
    : shown.title;
  const breakAt = command.indexOf("\n");
  const commandLine = (breakAt === -1 ? command : command.slice(0, breakAt)).trim();
  const commandRest = breakAt === -1 ? "" : command.slice(breakAt + 1).replace(/^\r?\n/, "").trimEnd();
  const hasBody = Boolean(commandRest || diffView || output);

  return (
    <details className="tool tool-terminal">
      <summary>
        <span className="tool-terminal-bar">
          <span className="tool-terminal-lights" aria-hidden="true">
            <span className="tool-terminal-light close" />
            <span className="tool-terminal-light minimize" />
            <span className="tool-terminal-light zoom" />
          </span>
          <span className="tool-terminal-title">terminal</span>
        </span>
        {commandLine ? (
          <span className="tool-terminal-preview" title={commandLine}>
            <span className="tool-terminal-prompt">$ </span>{commandLine}
          </span>
        ) : null}
      </summary>
      {hasBody ? (
        <div className="tool-terminal-body">
          {commandRest ? <pre className="tool-terminal-command">{commandRest}</pre> : null}
          {diffView}
          {output}
        </div>
      ) : null}
    </details>
  );
}
