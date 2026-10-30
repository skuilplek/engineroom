import { useRef, useState, useEffect, type DragEvent, type FormEvent, type ReactNode } from "react";
import { displayModelName, type GitStatus, type QueuedPrompt } from "@engineroom/protocol";
import { gitWorkspace, initGitWorkspace, switchGitBranch } from "../api.ts";
import { useReportError } from "../errors.tsx";
import { modeTone } from "../format.ts";
import { IconArrow, IconBranch, IconClip } from "../icons.tsx";
import { addComposerFiles, removeComposerFile, type ComposerAttachment } from "./attachments.ts";
import { usePromptHeight } from "./promptHeight.ts";

export interface ComposerChoice {
  id: string;
  name: string;
}

export function Composer({
  frame,
  prompt,
  onPrompt,
  attachments,
  onAttachments,
  placeholder,
  username,
  disabled,
  onSubmit,
  modes,
  mode,
  onMode,
  models,
  model,
  onModel,
  queue = [],
  onEditQueued,
  onRemoveQueued,
  workspace,
  projectCreate,
  switchDisabled,
  onReposChanged,
  onBranchChanged,
  children,
}: {
  frame: "dock" | "launch";
  prompt: string;
  onPrompt: (value: string) => void;
  attachments: ComposerAttachment[];
  onAttachments: (items: ComposerAttachment[]) => void;
  placeholder: string;
  username: string;
  disabled: boolean;
  onSubmit: (event: FormEvent) => void;
  modes: ComposerChoice[];
  mode: string;
  onMode?: (modeId: string) => void;
  models: ComposerChoice[];
  model: string;
  onModel?: (modelId: string) => void;
  queue?: QueuedPrompt[];
  onEditQueued?: (index: number) => void;
  onRemoveQueued?: (index: number) => void;
  workspace: string;
  projectCreate: boolean;
  switchDisabled?: boolean;
  onReposChanged?: () => void;
  onBranchChanged?: () => void;
  children?: ReactNode;
}) {
  const report = useReportError();
  const promptHeight = usePromptHeight(username);
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [gitBusy, setGitBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (frame === "launch") box.current?.focus();
  }, [frame, workspace]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    if (!workspace) {
      setGit(null);
      return;
    }
    let cancelled = false;
    setGit(null);
    gitWorkspace(workspace).then((status) => {
      if (!cancelled) setGit(status);
    }).catch((err) => {
      if (!cancelled) report("Repository", err);
    });
    return () => {
      cancelled = true;
    };
  }, [workspace, report]);

  async function createRepo() {
    if (!workspace || gitBusy) return;
    setGitBusy(true);
    try {
      setGit(await initGitWorkspace(workspace));
      onReposChanged?.();
    } catch (err) {
      report("Create repository", err);
    } finally {
      setGitBusy(false);
    }
  }

  async function chooseBranch(branch: string) {
    if (!workspace || !git || branch === git.branch || gitBusy) return;
    setGitBusy(true);
    try {
      setGit(await switchGitBranch(workspace, branch));
      onBranchChanged?.();
    } catch (err) {
      report("Switch branch", err);
    } finally {
      setGitBusy(false);
    }
  }

  async function copyBranch() {
    if (!git?.branch) return;
    if (await copyText(git.branch)) setCopied(true);
  }

  function addFiles(list: FileList | File[]) {
    const result = addComposerFiles(attachments, list);
    onAttachments(result.attachments);
    if (result.error) report("Attach files", result.error);
  }

  function hasFiles(transfer: DataTransfer | null): boolean {
    return Boolean(transfer?.types?.includes("Files"));
  }

  function onDragOver(event: DragEvent<HTMLFormElement>) {
    if (!hasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragging(true);
  }

  function onDragLeave(event: DragEvent<HTMLFormElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragging(false);
  }

  function onDrop(event: DragEvent<HTMLFormElement>) {
    if (!hasFiles(event.dataTransfer)) return;
    event.preventDefault();
    setDragging(false);
    addFiles(event.dataTransfer.files);
  }

  const branches = git?.branches ?? [];
  const branchNames = git?.branch && !branches.includes(git.branch) ? [git.branch, ...branches] : branches;
  const showBranch = Boolean(git?.repo && (git.branch || branchNames.length > 0));
  const showCreate = Boolean(git && !git.repo && projectCreate);
  const tone = modeTone(mode);

  return (
    <div className={frame === "dock" ? "composer" : "launch-composer"}>
      {showCreate && (
        <div className="composer-pills">
          <button className="composer-pill" type="button" disabled={gitBusy} onClick={() => void createRepo()}>
            Create repo
          </button>
        </div>
      )}
      {queue.length > 0 && (
        <ul className="queue-list" aria-label="Queued messages">
          {queue.map((item, index) => (
            <li key={`${index}:${item.text}`}>
              <p title={queueLabel(item)}>{queueLabel(item)}</p>
              {onEditQueued && (
                <button type="button" onClick={() => onEditQueued(index)}>Edit</button>
              )}
              {onRemoveQueued && (
                <button type="button" onClick={() => onRemoveQueued(index)}>Remove</button>
              )}
            </li>
          ))}
        </ul>
      )}
      <form
        className={dragging ? "composer-card dropping" : "composer-card"}
        data-mode={tone || undefined}
        onSubmit={onSubmit}
        onDragEnter={onDragOver}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {attachments.length > 0 && (
          <ul className="composer-files" aria-label="Attachments">
            {attachments.map((item) => (
              <li className="composer-file" key={item.key}>
                {item.previewUrl ? <img src={item.previewUrl} alt="" /> : null}
                <span title={item.name}>{item.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${item.name}`}
                  onClick={() => onAttachments(removeComposerFile(attachments, item.key))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={box}
          style={promptHeight.style}
          value={prompt}
          placeholder={placeholder}
          aria-label={placeholder}
          onPointerDown={promptHeight.onPointerDown}
          onChange={(event) => onPrompt(event.target.value)}
          onPaste={(event) => {
            const files = filesFromClipboard(event.clipboardData);
            if (files.length === 0) return;
            event.preventDefault();
            addFiles(files);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (!disabled) event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="composer-controls">
          <div className="composer-choices">
            {children}
            {modes.length > 0 && (
              <select className="mode-choice" data-mode={tone || undefined} aria-label="Mode" value={mode} onChange={(event) => onMode?.(event.target.value)}>
                {modes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            )}
            {models.length > 0 && (
              <select aria-label="Model" value={model} onChange={(event) => onModel?.(event.target.value)}>
                {model && !models.some((item) => item.id === model) && <option value={model} title={displayModelName(model, model)}>{displayModelName(model, model)}</option>}
                {models.map((item) => {
                  const label = displayModelName(item.id, item.name);
                  return <option key={item.id} value={item.id} title={label}>{label}</option>;
                })}
              </select>
            )}
          </div>
          <div className="composer-actions">
            <button className="attach-button" type="button" aria-label="Attach files" onClick={() => picker.current?.click()}>
              <IconClip />
            </button>
            <input
              ref={picker}
              className="file-input"
              type="file"
              multiple
              onChange={(event) => {
                if (event.target.files) addFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <button className="send" type="submit" disabled={disabled} aria-label="Send">
              <IconArrow />
            </button>
          </div>
        </div>
      </form>
      {showBranch && git && (
        <div className="composer-status">
          <label className="branch-picker">
            <IconBranch />
            <select
              aria-label="Branch"
              value={git.branch}
              disabled={switchDisabled || gitBusy || branchNames.length < 2}
              onChange={(event) => void chooseBranch(event.target.value)}
            >
              {branchNames.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          <button
            className="branch-copy"
            type="button"
            aria-label={copied ? "Copied branch name" : `Copy branch name ${git.branch}`}
            onClick={() => void copyBranch()}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
        </div>
      )}
    </div>
  );
}

function queueLabel(item: QueuedPrompt): string {
  if (item.attachments.length === 0) return item.text;
  const names = item.attachments.map((file) => file.name).join(", ");
  return item.text ? `${item.text} · ${names}` : names;
}

function filesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files: File[] = [];
  for (const item of data.items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the textarea path when the page is not a secure context.
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.left = "-9999px";
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.5 5.5V3.2A1.2 1.2 0 0 0 9.3 2H3.2A1.2 1.2 0 0 0 2 3.2v6.1A1.2 1.2 0 0 0 3.2 10.5H5.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.2 8.3 6.4 11.4 12.8 4.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
