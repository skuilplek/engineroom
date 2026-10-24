import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { RepositoryEntry, StreamEvent } from "@engineroom/protocol";
import { agentLabel } from "@engineroom/protocol";
import { FilesPaneToggle } from "../files/FilesPaneToggle.tsx";
import { workspaceLabel } from "../format.ts";
import { isMissingChat } from "./missingChat.ts";
import { noteSeq, onAgent, sendCommand, unwatchChat, watchChat } from "../socket.ts";
import { TerminalPanel } from "../terminal/TerminalPanel.tsx";
import { DiffView } from "./Diff.tsx";
import { groupTranscript, presentTool } from "./group.ts";
import { Markdown } from "./Markdown.tsx";
import { usePromptHeight } from "./promptHeight.ts";
import { applyEvent, applySnapshot, emptyLive, latestPlan, type ChatLive } from "./state.ts";

export function ChatView({
  chatId,
  home,
  agentCatalog,
  repos,
  rawTerminal,
  claimOpening,
  onTitle,
  filesOpen,
  onToggleFiles,
  onWorkspace,
  onFilesChanged,
  onUnavailable,
  username,
}: {
  chatId: string;
  home: string;
  agentCatalog?: { id: string; label: string }[];
  repos: RepositoryEntry[];
  rawTerminal: boolean;
  claimOpening: (id: string) => string | null;
  onTitle: (title: string) => void;
  filesOpen?: boolean;
  onToggleFiles?: () => void;
  onWorkspace?: (workspace: string) => void;
  onFilesChanged?: () => void;
  onUnavailable: () => void;
  username: string;
}) {
  const [live, setLive] = useState<ChatLive>(() => emptyLive());
  const promptHeight = usePromptHeight(username);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [raw, setRaw] = useState(false);
  const [shellOpen, setShellOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const opened = useRef(false);
  const sawSnapshot = useRef(false);
  const queued = useRef<Array<{ event: StreamEvent; seq: number }>>([]);
  const titleRef = useRef(onTitle);
  titleRef.current = onTitle;
  const workspaceRef = useRef(onWorkspace);
  workspaceRef.current = onWorkspace;
  const filesChangedRef = useRef(onFilesChanged);
  filesChangedRef.current = onFilesChanged;
  const unavailableRef = useRef(onUnavailable);
  unavailableRef.current = onUnavailable;

  useEffect(() => {
    setLive(emptyLive());
    setRaw(false);
    setError("");
    opened.current = false;
    sawSnapshot.current = false;
    queued.current = [];
    watchChat(chatId, 0);
    const stop = onAgent((message) => {
      if (message.type === "error") {
        if (!sawSnapshot.current && isMissingChat(message.error)) {
          unavailableRef.current();
          return;
        }
        setError(message.error);
        return;
      }
      if (message.type === "event" && message.chatId === chatId && !sawSnapshot.current) {
        queued.current.push({ event: message.event, seq: message.seq });
        return;
      }
      if (message.type === "snapshot" && message.chatId === chatId) {
        sawSnapshot.current = true;
        const pending = queued.current.splice(0);
        setLive((current) => {
          let next = applySnapshot(current, message);
          for (const item of pending) next = applyEvent(next, item.event, item.seq);
          return next;
        });
        noteSeq(chatId, message.seq);
        titleRef.current(message.chat.title);
        if (message.chat.workspace) workspaceRef.current?.(message.chat.workspace);
        for (const item of pending) {
          noteSeq(chatId, item.seq);
          if (item.event.type === "title") titleRef.current(item.event.text);
        }
        if (!opened.current) {
          opened.current = true;
          const text = claimOpening(chatId);
          if (text) sendCommand({ type: "prompt", chatId, prompt: text });
        }
        return;
      }
      if (message.type === "event" && message.chatId === chatId) {
        setLive((current) => applyEvent(current, message.event, message.seq));
        noteSeq(chatId, message.seq);
        if (message.event.type === "title") titleRef.current(message.event.text);
        if (
          message.event.type === "turn_end" ||
          message.event.type === "done" ||
          (message.event.type === "tool" && message.event.phase === "done")
        ) {
          filesChangedRef.current?.();
        }
      }
    });
    return () => {
      stop();
      unwatchChat(chatId);
    };
  }, [chatId, claimOpening]);

  const blocks = useMemo(() => groupTranscript(live.entries), [live.entries]);
  const plan = useMemo(() => latestPlan(live.entries), [live.entries]);

  useEffect(() => {
    const node = scroller.current;
    if (!node || !stick.current) return;
    node.scrollTop = node.scrollHeight;
  }, [blocks, live.shell, live.running]);

  function onScroll() {
    const node = scroller.current;
    if (!node) return;
    stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || raw) return;
    setPrompt("");
    setError("");
    stick.current = true;
    sendCommand({ type: "prompt", chatId, prompt: text });
  }

  function choose(optionId: string) {
    if (!live.permission) return;
    sendCommand({ type: "permission_response", chatId, requestId: live.permission.requestId, optionId });
    setLive((current) => ({ ...current, permission: null }));
  }

  return (
    <div className="chat">
      <header className="topbar">
        <div>
          <h2>{live.title}</h2>
          <p className="muted">{agentLabel(live.agent, agentCatalog)} · {workspaceLabel(live.workspace || home, home, repos)}</p>
        </div>
        <div className="row">
          {live.running && (
            <button className="danger" type="button" onClick={() => sendCommand({ type: "cancel", chatId })}>Stop</button>
          )}
          {rawTerminal && (
            <button className="ghost" type="button" disabled={live.running} onClick={() => setRaw((value) => !value)}>
              {raw ? "Chat" : "Terminal"}
            </button>
          )}
          <FilesPaneToggle filesOpen={filesOpen} onToggle={onToggleFiles} />
        </div>
      </header>
      {raw ? (
        <TerminalPanel chatId={chatId} />
      ) : (
        <>
          {plan.length > 0 && (
            <ol className="plan">
              {plan.map((entry, index) => (
                <li key={index} className={entry.status === "completed" ? "done" : ""}>
                  <span>{entry.status === "completed" ? "✓" : entry.status === "in_progress" ? "•" : "○"}</span>
                  {entry.content}
                </li>
              ))}
            </ol>
          )}
          <div className="transcript" ref={scroller} onScroll={onScroll}>
            {blocks.map((block, index) => {
              const last = index === blocks.length - 1;
              if (block.kind === "text") {
                if (block.role === "user") return <div className="bubble user" key={index}>{block.text}</div>;
                return <div className="bubble assistant" key={index}><Markdown text={block.text} streaming={last && live.running} /></div>;
              }
              if (block.kind === "thinking") {
                return (
                  <details className="thinking" key={index} open={last && live.running}>
                    <summary>Thinking</summary>
                    <p>{block.text}</p>
                  </details>
                );
              }
              if (block.kind === "tool") {
                const shown = presentTool(block);
                const diff = block.content?.find((item) => item.type === "diff");
                return (
                  <div className="tool" key={index}>
                    <div>{shown.title}</div>
                    {diff && diff.type === "diff" ? <DiffView path={diff.path} oldText={diff.oldText} newText={diff.newText} /> : null}
                    {shown.body ? <pre>{shown.body}</pre> : block.phase === "start" ? <pre className="pulse">running…</pre> : null}
                  </div>
                );
              }
              if (block.kind === "error") return <p className="alert" key={index} role="alert">{block.text}</p>;
              return <p className="status" key={index}>{block.text}</p>;
            })}
            {blocks.length === 0 && (
              <p className="empty">{error || (live.ready ? "Send a prompt to start." : "Loading chat…")}</p>
            )}
          </div>
          {live.shell && (
            <section className={shellOpen ? "shell-log open" : "shell-log"}>
              <button type="button" onClick={() => setShellOpen((value) => !value)}>Shell</button>
              {shellOpen && <pre>{live.shell}</pre>}
            </section>
          )}
          {live.permission && (
            <div className="permission">
              <p>{live.permission.title || "Allow this action?"}</p>
              <div className="row">
                {live.permission.options.map((option) => (
                  <button className={option.kind.startsWith("reject") ? "danger" : "primary"} key={option.optionId} type="button" onClick={() => choose(option.optionId)}>
                    {option.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          {live.queue.length > 0 && <p className="queue">{live.queue.length} queued</p>}
          <form className="composer" onSubmit={submit}>
            <textarea
              style={promptHeight.style}
              value={prompt}
              placeholder={live.running ? "Queue a follow-up" : "Message this chat"}
              onPointerDown={promptHeight.onPointerDown}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <div className="composer-tools">
              {live.modes.length > 0 && (
                <select aria-label="Mode" value={live.mode} onChange={(event) => sendCommand({ type: "set_mode", chatId, modeId: event.target.value })}>
                  {live.modes.map((mode) => <option key={mode.id} value={mode.id}>{mode.name}</option>)}
                </select>
              )}
              {live.models.length > 0 && (
                <select aria-label="Model" value={live.model} onChange={(event) => sendCommand({ type: "set_model", chatId, modelId: event.target.value })}>
                  {live.models.map((model) => <option key={model.modelId} value={model.modelId}>{model.name}</option>)}
                </select>
              )}
              <button className="primary" type="submit" disabled={!prompt.trim()}>Send</button>
            </div>
            {error && <p className="alert" role="alert">{error}</p>}
          </form>
        </>
      )}
    </div>
  );
}
