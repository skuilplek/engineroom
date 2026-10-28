import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { CommandBlockStyle, PromptAttachment, RepositoryEntry, StreamEvent } from "@engineroom/protocol";
import { agentLabel, ATTACHED_PROMPT } from "@engineroom/protocol";
import { FilesPaneToggle } from "../files/FilesPaneToggle.tsx";
import { useReportError } from "../errors.tsx";
import { workspaceLabel } from "../format.ts";
import { isMissingChat } from "./missingChat.ts";
import { noteSeq, onAgent, sendCommand, unwatchChat, watchChat } from "../socket.ts";
import { TerminalPanel } from "../terminal/TerminalPanel.tsx";
import { groupTranscript } from "./group.ts";
import { ToolBlock } from "./ToolBlock.tsx";
import { CopyResponse } from "./CopyResponse.tsx";
import { Markdown } from "./Markdown.tsx";
import { Composer } from "./Composer.tsx";
import { attachmentPreview, composerFilesFromSaved, promptText, restorePromptText, uploadPendingAttachments, type ComposerAttachment } from "./attachments.ts";
import { clearDraft, readDraft, useComposerDraft } from "./drafts.ts";
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
  commandBlockStyle = "prompt",
  projectCreate,
  onReposChanged,
  onOpenFile,
}: {
  chatId: string;
  home: string;
  agentCatalog?: { id: string; label: string }[];
  repos: RepositoryEntry[];
  rawTerminal: boolean;
  claimOpening: (id: string) => { prompt: string; attachments: PromptAttachment[] } | null;
  onTitle: (title: string) => void;
  filesOpen?: boolean;
  onToggleFiles?: () => void;
  onWorkspace?: (workspace: string) => void;
  onFilesChanged?: () => void;
  onUnavailable: () => void;
  username: string;
  commandBlockStyle?: CommandBlockStyle;
  projectCreate: boolean;
  onReposChanged?: () => void;
  onOpenFile?: (path: string) => void;
}) {
  const [live, setLive] = useState<ChatLive>(() => emptyLive());
  const { prompt, setPrompt, attachments, setAttachments, clear: clearDraftInput } = useComposerDraft<ComposerAttachment>(`chat:${chatId}`);
  const [sending, setSending] = useState(false);
  const [raw, setRaw] = useState(false);
  const report = useReportError();
  const [shellOpen, setShellOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
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
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    setLive(emptyLive());
    setRaw(false);
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
        report("Chat", message.error);
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
          const opening = claimOpening(chatId);
          if (opening) {
            sendCommand({
              type: "prompt",
              chatId,
              prompt: opening.prompt,
              ...(opening.attachments.length > 0 ? { attachments: opening.attachments } : {}),
            });
          }
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
  }, [chatId, claimOpening, report]);

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

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = promptText(prompt, attachments.length);
    if (!text || raw || sending) return;
    if (attachments.some((item) => item.file && !item.saved) && !live.workspace) {
      report("Send", "Loading chat…");
      return;
    }
    const sentPrompt = prompt;
    setSending(true);
    try {
      const saved = await uploadPendingAttachments(live.workspace, attachments);
      const messageText = promptText(sentPrompt, saved.length);
      const draftKey = `chat:${chatId}`;
      if (!alive.current) {
        if (readDraft<ComposerAttachment>(draftKey).prompt === sentPrompt) clearDraft(draftKey);
      } else {
        setAttachments(composerFilesFromSaved(saved));
        if (readDraft<ComposerAttachment>(draftKey).prompt === sentPrompt) clearDraftInput();
      }
      stick.current = true;
      sendCommand({
        type: "prompt",
        chatId,
        prompt: messageText,
        ...(saved.length > 0 ? { attachments: saved } : {}),
      });
    } catch (err) {
      report("Send", err);
    } finally {
      setSending(false);
    }
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
                if (block.role === "user") return <UserBubble key={index} text={block.text} attachments={block.attachments} />;
                return (
                  <div className="bubble assistant" key={index}>
                    <Markdown text={block.text} streaming={last && live.running} onOpenFile={onOpenFile} />
                    <CopyResponse text={block.text} />
                  </div>
                );
              }
              if (block.kind === "thinking") {
                return (
                  <details className="thinking" key={index} open={last && live.running}>
                    <summary>Thinking</summary>
                    <p>{block.text}</p>
                  </details>
                );
              }
              if (block.kind === "tool") return <ToolBlock key={index} block={block} showRunning style={commandBlockStyle} onOpenFile={onOpenFile} />;
              if (block.kind === "error") return <p className="alert" key={index} role="alert">{block.text}</p>;
              return <p className="status" key={index}>{block.text}</p>;
            })}
            {blocks.length === 0 && (
              <p className="empty">{live.ready ? "Send a prompt to start." : "Loading chat…"}</p>
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
          <Composer
            frame="dock"
            prompt={prompt}
            onPrompt={setPrompt}
            attachments={attachments}
            onAttachments={setAttachments}
            placeholder={live.running ? "Add a follow up" : "Message this chat"}
            username={username}
            disabled={sending || !promptText(prompt, attachments.length)}
            onSubmit={(event) => void submit(event)}
            modes={live.modes.map((item) => ({ id: item.id, name: item.name }))}
            mode={live.mode}
            onMode={(modeId) => sendCommand({ type: "set_mode", chatId, modeId })}
            models={live.models.map((item) => ({ id: item.modelId, name: item.name }))}
            model={live.model}
            onModel={(modelId) => sendCommand({ type: "set_model", chatId, modelId })}
            queue={live.queue}
            onEditQueued={(index) => {
              const item = live.queue[index];
              if (!item) return;
              setPrompt(restorePromptText(item.text, item.attachments.length));
              setAttachments(composerFilesFromSaved(item.attachments));
              sendCommand({ type: "dequeue", chatId, index });
            }}
            onRemoveQueued={(index) => sendCommand({ type: "dequeue", chatId, index })}
            workspace={live.workspace}
            projectCreate={projectCreate}
            switchDisabled={live.running}
            onReposChanged={onReposChanged}
            onBranchChanged={onFilesChanged}
          />
        </>
      )}
    </div>
  );
}

function UserBubble({ text, attachments = [] }: { text: string; attachments?: PromptAttachment[] }) {
  const showText = text !== ATTACHED_PROMPT || attachments.length === 0;
  return (
    <div className="bubble user">
      {attachments.length > 0 && (
        <div className="bubble-files">
          {attachments.map((file) => {
            const preview = attachmentPreview(file.path);
            return preview ? (
              <img key={file.path} src={preview} alt={file.name} />
            ) : (
              <span key={file.path}>{file.name}</span>
            );
          })}
        </div>
      )}
      {showText ? text : null}
    </div>
  );
}
