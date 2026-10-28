import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AgentId, AgentOptionChoice, ChatMeta, PromptAttachment } from "@engineroom/protocol";
import { agentLabel } from "@engineroom/protocol";
import { createChat, getSettings, type Session } from "../api.ts";
import { PiSetupNotice } from "../settings/PiSetup.tsx";
import { FilesPaneToggle } from "../files/FilesPaneToggle.tsx";
import { message, strip } from "../format.ts";
import { composerFilesFromSaved, promptText, uploadPendingAttachments, type ComposerAttachment } from "./attachments.ts";
import { clearDraft, readDraft, useComposerDraft } from "./drafts.ts";
import { Composer } from "./Composer.tsx";
import { startProjectDownload, useProjectDownload } from "./projectDownload.ts";
import { RepoManage } from "./RepoManage.tsx";

export function StartView({
  agents,
  agentCatalog,
  options,
  workspace,
  targetLabel,
  onStarted,
  filesOpen,
  onToggleFiles,
  username,
  piSetup = false,
  onSession,
  projectCreate,
  projectDownloads,
  archived,
  onArchive,
  onDelete,
  onReposChanged,
  onBranchChanged,
}: {
  agents: AgentId[];
  agentCatalog?: { id: string; label: string }[];
  options: Partial<Record<AgentId, { modes: AgentOptionChoice[]; models: AgentOptionChoice[] }>>;
  workspace: string;
  targetLabel: string;
  onStarted: (chat: ChatMeta, prompt: string, attachments: PromptAttachment[]) => void;
  filesOpen?: boolean;
  onToggleFiles?: () => void;
  username: string;
  piSetup?: boolean;
  onSession?: (session: Session) => void;
  projectCreate: boolean;
  projectDownloads: boolean;
  archived: boolean;
  onArchive: () => Promise<void>;
  onDelete: (name: string) => Promise<void>;
  onReposChanged?: () => void;
  onBranchChanged?: () => void;
}) {
  const alive = useRef(true);
  const [agent, setAgent] = useState<AgentId | "">(agents[0] || "");
  const [mode, setMode] = useState(() => options[agents[0] || ""]?.modes?.[0]?.id || "");
  const [model, setModel] = useState(() => options[agents[0] || ""]?.models?.[0]?.id || "");
  const { prompt, setPrompt, attachments, setAttachments, clear: clearDraftInput } = useComposerDraft<ComposerAttachment>(`start:${workspace}`);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<"archive" | "delete" | "">("");
  const [actionError, setActionError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const download = useProjectDownload();
  const downloadHere = Boolean(download && strip(download.workspace) === strip(workspace));
  const creatingZip = Boolean(downloadHere && download?.phase === "creating");
  const [repoTick, setRepoTick] = useState(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (agents.length === 0) {
      setAgent("");
      setMode("");
      setModel("");
      return;
    }
    getSettings().then((next) => {
      const chosen = agents.includes(next.defaultAgent) ? next.defaultAgent : agents[0];
      if (!chosen) return;
      const modes = options[chosen]?.modes ?? [];
      const models = options[chosen]?.models ?? [];
      setAgent(chosen);
      setMode(modes[0]?.id || "");
      setModel(models.some((item) => item.id === next.defaultModel) ? next.defaultModel : models[0]?.id || "");
    }).catch((err) => setError(message(err)));
  }, [agents, options]);

  const modes = options[agent]?.modes ?? [];
  const models = options[agent]?.models ?? [];

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = promptText(prompt, attachments.length);
    if (!text || busy || !agent) return;
    const sentPrompt = prompt;
    setBusy(true);
    setError("");
    try {
      const saved = await uploadPendingAttachments(workspace, attachments);
      const messageText = promptText(sentPrompt, saved.length);
      const draftKey = `start:${workspace}`;
      if (alive.current) setAttachments(composerFilesFromSaved(saved));
      const chat = await createChat({
        agent,
        mode: modes.length > 0 ? mode : "",
        model: models.length > 0 ? model : "",
        workspace,
      });
      if (readDraft<ComposerAttachment>(draftKey).prompt === sentPrompt) {
        if (alive.current) clearDraftInput();
        else clearDraft(draftKey);
      }
      onStarted(chat, messageText, saved);
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }

  async function archiveProject() {
    if (action) return;
    setAction("archive");
    setActionError("");
    try {
      await onArchive();
    } catch (err) {
      setActionError(message(err));
    } finally {
      setAction("");
    }
  }

  async function removeProject() {
    if (action || typed !== targetLabel) return;
    setAction("delete");
    setActionError("");
    try {
      await onDelete(typed);
    } catch (err) {
      setActionError(message(err));
      setAction("");
    }
  }

  function chooseAgent(next: AgentId) {
    const availableModes = options[next]?.modes ?? [];
    const available = options[next]?.models ?? [];
    setAgent(next);
    setMode(availableModes.some((item) => item.id === mode) ? mode : availableModes[0]?.id || "");
    setModel(available.some((item) => item.id === model) ? model : available[0]?.id || "");
  }

  return (
    <div className="start">
      {onToggleFiles && !filesOpen && (
        <div className="start-topbar">
          <FilesPaneToggle filesOpen={filesOpen} onToggle={onToggleFiles} />
        </div>
      )}
      <h1>Let's Start Building!</h1>
      <Composer
        frame="launch"
        prompt={prompt}
        onPrompt={setPrompt}
        attachments={attachments}
        onAttachments={setAttachments}
        placeholder="What do you want to build?"
        username={username}
        disabled={busy || !agent || !promptText(prompt, attachments.length)}
        onSubmit={(event) => void submit(event)}
        modes={modes}
        mode={mode}
        onMode={setMode}
        models={models}
        model={model}
        onModel={setModel}
        workspace={workspace}
        projectCreate={projectCreate}
        onReposChanged={() => {
          setRepoTick((value) => value + 1);
          onReposChanged?.();
        }}
        onBranchChanged={() => {
          setRepoTick((value) => value + 1);
          onBranchChanged?.();
        }}
        error={error}
      >
        {agents.length === 0 && <p className="muted">No agents available</p>}
        {piSetup && onSession && <PiSetupNotice onReady={onSession} />}
        {agents.length > 1 && (
          <select aria-label="Agent" value={agent} onChange={(event) => chooseAgent(event.target.value as AgentId)}>
            {agents.map((item) => <option key={item} value={item}>{agentLabel(item, agentCatalog)}</option>)}
          </select>
        )}
      </Composer>
      <p className="context-line">{targetLabel}</p>
      <div className="download-project">
        {creatingZip && <p className="zip-progress" role="status">..creating project zip file..</p>}
        {downloadHere && download?.phase === "failed" && <p className="alert" role="alert">{download.error}</p>}
        {actionError && !confirming && <p className="alert" role="alert">{actionError}</p>}
        <div className="project-actions">
          {projectDownloads && !creatingZip && (
            <button className="primary" type="button" onClick={() => void startProjectDownload(workspace, targetLabel)}>
              Download project
            </button>
          )}
          <button className="ghost" type="button" disabled={action !== ""} onClick={() => void archiveProject()}>
            {archived ? "Unarchive" : "Archive"}
          </button>
          <button
            className="danger"
            type="button"
            disabled={action !== ""}
            onClick={() => {
              setTyped("");
              setActionError("");
              setConfirming(true);
            }}
          >
            Delete
          </button>
        </div>
        {projectCreate && (
          <RepoManage
            workspace={workspace}
            refreshToken={repoTick}
            onBranchChanged={onBranchChanged}
          />
        )}
      </div>
      {confirming && (
        <div className="modal-backdrop">
          <div className="confirm-dialog" role="dialog" aria-labelledby="delete-project-title" aria-modal="true">
            <h2 id="delete-project-title">Delete this project</h2>
            <p className="muted">Type <span className="folder-name">{targetLabel}</span> to delete this project. This removes the project folder and its chats.</p>
            <label>
              Project folder name
              <input
                value={typed}
                autoFocus
                onChange={(event) => setTyped(event.target.value)}
                disabled={action === "delete"}
              />
            </label>
            {actionError && <p className="alert" role="alert">{actionError}</p>}
            <div className="confirm-actions">
              <button type="button" onClick={() => setConfirming(false)} disabled={action === "delete"}>Cancel</button>
              <button className="danger" type="button" disabled={typed !== targetLabel || action === "delete"} onClick={() => void removeProject()}>
                {action === "delete" ? "Deleting…" : "Delete project"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
