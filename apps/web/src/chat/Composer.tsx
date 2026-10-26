import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { GitStatus } from "@engineroom/protocol";
import { gitWorkspace, initGitWorkspace, switchGitBranch } from "../api.ts";
import { message } from "../format.ts";
import { IconArrow, IconBranch } from "../icons.tsx";
import { usePromptHeight } from "./promptHeight.ts";

export interface ComposerChoice {
  id: string;
  name: string;
}

export function Composer({
  frame,
  prompt,
  onPrompt,
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
  error,
  children,
}: {
  frame: "dock" | "launch";
  prompt: string;
  onPrompt: (value: string) => void;
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
  queue?: string[];
  onEditQueued?: (index: number) => void;
  onRemoveQueued?: (index: number) => void;
  workspace: string;
  projectCreate: boolean;
  switchDisabled?: boolean;
  onReposChanged?: () => void;
  onBranchChanged?: () => void;
  error?: string;
  children?: ReactNode;
}) {
  const promptHeight = usePromptHeight(username);
  const box = useRef<HTMLTextAreaElement>(null);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [gitError, setGitError] = useState("");
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
    setGitError("");
    gitWorkspace(workspace).then((status) => {
      if (!cancelled) {
        setGit(status);
        setGitError("");
      }
    }).catch((err) => {
      if (!cancelled) setGitError(message(err));
    });
    return () => {
      cancelled = true;
    };
  }, [workspace]);

  async function createRepo() {
    if (!workspace || gitBusy) return;
    setGitBusy(true);
    setGitError("");
    try {
      setGit(await initGitWorkspace(workspace));
      onReposChanged?.();
    } catch (err) {
      setGitError(message(err));
    } finally {
      setGitBusy(false);
    }
  }

  async function chooseBranch(branch: string) {
    if (!workspace || !git || branch === git.branch || gitBusy) return;
    setGitBusy(true);
    setGitError("");
    try {
      setGit(await switchGitBranch(workspace, branch));
      onBranchChanged?.();
    } catch (err) {
      setGitError(message(err));
    } finally {
      setGitBusy(false);
    }
  }

  async function copyBranch() {
    if (!git?.branch) return;
    if (await copyText(git.branch)) setCopied(true);
  }

  const branches = git?.branches ?? [];
  const branchNames = git?.branch && !branches.includes(git.branch) ? [git.branch, ...branches] : branches;
  const showBranch = Boolean(git?.repo && (git.branch || branchNames.length > 0));
  const showCreate = Boolean(git && !git.repo && projectCreate);
  const alert = gitError || error || "";

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
          {queue.map((text, index) => (
            <li key={`${index}:${text}`}>
              <p title={text}>{text}</p>
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
      <form className="composer-card" onSubmit={onSubmit}>
        <textarea
          ref={box}
          style={promptHeight.style}
          value={prompt}
          placeholder={placeholder}
          aria-label={placeholder}
          onPointerDown={promptHeight.onPointerDown}
          onChange={(event) => onPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (!disabled) event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="composer-controls">
          {children}
          {modes.length > 0 && (
            <select aria-label="Mode" value={mode} onChange={(event) => onMode?.(event.target.value)}>
              {modes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          )}
          {models.length > 0 && (
            <select aria-label="Model" value={model} onChange={(event) => onModel?.(event.target.value)}>
              {model && !models.some((item) => item.id === model) && <option value={model}>{model}</option>}
              {models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          )}
          <button className="send" type="submit" disabled={disabled} aria-label="Send">
            <IconArrow />
          </button>
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
      {alert && <p className="alert" role="alert">{alert}</p>}
    </div>
  );
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
