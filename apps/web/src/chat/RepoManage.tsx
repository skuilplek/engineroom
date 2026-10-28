import { useEffect, useState } from "react";
import type { GitStatus } from "@engineroom/protocol";
import { createGitBranch, gitWorkspace, pullGit, pushGit, setGitRemote, switchGitBranch } from "../api.ts";
import { useReportError } from "../errors.tsx";

export function RepoManage({
  workspace,
  refreshToken,
  onBranchChanged,
}: {
  workspace: string;
  refreshToken: number;
  onBranchChanged?: () => void;
}) {
  const [git, setGit] = useState<GitStatus | null>(null);
  const [remote, setRemote] = useState("");
  const [branchName, setBranchName] = useState("");
  const [action, setAction] = useState<"remote" | "switch" | "branch" | "pull" | "push" | "">("");
  const [note, setNote] = useState("");
  const report = useReportError();

  useEffect(() => {
    setGit(null);
    setRemote("");
    setBranchName("");
    setNote("");
  }, [workspace]);

  useEffect(() => {
    let cancelled = false;
    gitWorkspace(workspace).then((status) => {
      if (cancelled) return;
      setGit(status);
      setRemote(status.remote || "");
    }).catch((err) => {
      if (!cancelled) report("Repository", err);
    });
    return () => {
      cancelled = true;
    };
  }, [workspace, refreshToken, report]);

  async function run(kind: "remote" | "switch" | "branch" | "pull" | "push", task: () => Promise<GitStatus>, done: string) {
    if (action) return;
    setAction(kind);
    setNote("");
    try {
      const status = await task();
      setGit(status);
      setRemote(status.remote || "");
      setNote(done);
      if (kind !== "remote") onBranchChanged?.();
    } catch (err) {
      const labels = { remote: "Save remote", switch: "Switch branch", branch: "Create branch", pull: "Pull", push: "Push" };
      report(labels[kind], err);
    } finally {
      setAction("");
    }
  }

  if (!git) return null;
  if (!git.repo) {
    return (
      <section className="repo-manage" aria-label="Repository">
        <h2>Repository</h2>
        <p className="muted">This folder is not a git repository. Use Create repo above to start one.</p>
      </section>
    );
  }

  const detached = git.branch === "HEAD";
  const branches = git.branches ?? [];
  const busy = action !== "";
  const remoteChanged = remote.trim() !== (git.remote || "");

  return (
    <section className="repo-manage" aria-label="Repository">
      <h2>Repository</h2>
      {detached && <p className="muted">Checkout a branch first.</p>}
      <div className="repo-manage-row">
        <label>
          Remote URL
          <input
            value={remote}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            disabled={busy}
            onChange={(event) => setRemote(event.target.value)}
          />
        </label>
        <button
          className="ghost"
          type="button"
          disabled={busy || !remote.trim() || !remoteChanged}
          onClick={() => void run("remote", () => setGitRemote(workspace, remote.trim()), "Remote saved.")}
        >
          {action === "remote" ? "Saving…" : "Save remote"}
        </button>
      </div>
      <div className="repo-manage-row">
        <label>
          Branch
          <select
            aria-label="Branch"
            value={detached ? "" : git.branch}
            disabled={busy || branches.length === 0 || (!detached && branches.length < 2)}
            onChange={(event) => {
              const next = event.target.value;
              if (!next || next === git.branch) return;
              void run("switch", () => switchGitBranch(workspace, next), `Switched to ${next}.`);
            }}
          >
            {detached && <option value="">Detached HEAD</option>}
            {branches.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
      </div>
      <div className="repo-manage-row">
        <label>
          New branch
          <input
            aria-label="New branch name"
            value={branchName}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            disabled={busy || detached}
            onChange={(event) => setBranchName(event.target.value)}
          />
        </label>
        <button
          className="ghost"
          type="button"
          disabled={busy || detached || !branchName.trim()}
          onClick={() => void run("branch", async () => {
            const status = await createGitBranch(workspace, branchName.trim());
            setBranchName("");
            return status;
          }, "Branch created.")}
        >
          {action === "branch" ? "Creating…" : "Create branch"}
        </button>
      </div>
      <div className="repo-manage-actions">
        <button
          className="ghost"
          type="button"
          disabled={busy || detached || !git.remote}
          onClick={() => void run("pull", () => pullGit(workspace), "Pulled.")}
        >
          {action === "pull" ? "Pulling…" : "Pull"}
        </button>
        <button
          className="ghost"
          type="button"
          disabled={busy || detached || !git.remote}
          onClick={() => void run("push", () => pushGit(workspace), "Pushed.")}
        >
          {action === "push" ? "Pushing…" : "Push"}
        </button>
      </div>
      {note && <p className="muted" role="status">{note}</p>}
    </section>
  );
}
