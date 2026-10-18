import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { RepositoryEntry } from "@engineroom/protocol";
import { agentLabel } from "@engineroom/protocol";
import { workspaceLabel } from "../format.ts";
import { noteSeq, onAgent, sendCommand, watchChat } from "../socket.ts";
import { TerminalPanel } from "../terminal/TerminalPanel.tsx";
import { DiffView } from "./Diff.tsx";
import { groupTranscript, presentTool } from "./group.ts";
import { Markdown } from "./Markdown.tsx";
import { applyEvent, applySnapshot, emptyLive, latestPlan, type ChatLive } from "./state.ts";

export function ChatView({
  chatId,
  home,
  repos,
  rawTerminal,
  claimOpening,
  onTitle,
}: {
  chatId: string;
  home: string;
  repos: RepositoryEntry[];
  rawTerminal: boolean;
  claimOpening: (id: string) => string | null;
  onTitle: (title: string) => void;
}) {
  const [live, setLive] = useState<ChatLive>(() => emptyLive());
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [raw, setRaw] = useState(false);
  const [shellOpen, setShellOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const opened = useRef(false);
  const titleRef = useRef(onTitle);
  titleRef.current = onTitle;

  useEffect(() => {
    setLive(emptyLive());
    setRaw(false);
    setError("");
    opened.current = false;
    watchChat(chatId, 0);
    const stop = onAgent((message) => {
      if (message.type === "error") {
        setError(message.error);
        return;
      }
      if (message.type === "snapshot" && message.chatId === chatId) {
        setLive((current) => applySnapshot(current, message));
        noteSeq(chatId, message.seq);
        titleRef.current(message.chat.title);
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
      }
    });
    return () => stop();
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
    <>
      <header className="topbar">
        <div>
          <h2>{live.title}</h2>
          <p className="muted">{agentLabel(live.agent)} · {workspaceLabel(live.workspace || home, home, repos)}</p>
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
            {blocks.length === 0 && <p className="empty">{live.ready ? "Send a prompt to start." : "Loading chat…"}</p>}
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
              value={prompt}
              placeholder={live.running ? "Queue a follow-up" : "Message this chat"}
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
    </>
  );
}
