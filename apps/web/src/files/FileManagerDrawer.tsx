import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { RepoChangeEntry, RepoChangeStatus, RepoFileContent, RepoFileEntry } from "@engineroom/protocol";
import { ApiError, commitRepoChanges, createRepoEntry, deleteRepoEntry, discardRepoChange, downloadRepoFile, listRepoFiles, readHomeFile, readRepoFile, renameRepoEntry, stageRepoChange, unstageRepoChange, uploadRepoFiles, writeRepoFile } from "../api.ts";
import { classifyOpenedPath } from "../chat/filePaths.ts";
import { DiffView } from "../chat/Diff.tsx";
import { Markdown } from "../chat/Markdown.tsx";
import { message } from "../format.ts";
import {
  IconBranch,
  IconCheck,
  IconChevron,
  IconDownload,
  IconEdit,
  IconExpand,
  IconFile,
  IconFolder,
  IconMinus,
  IconNewFile,
  IconNewFolder,
  IconPanelRight,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconUndo,
  IconUpload,
} from "../icons.tsx";
import { CodeEditor } from "./CodeEditor.tsx";

type DrawerTab = "files" | "changes";
type FileViewMode = "code" | "diff" | "preview";

interface TreeNode {
  name: string;
  path: string;
  kind: "file" | "dir";
  size?: number;
  status?: RepoChangeStatus;
  children: TreeNode[];
}

export function FileManagerDrawer({
  workspace,
  repoName,
  open,
  expanded = false,
  canEdit = false,
  canDownload = false,
  canUpload = false,
  refreshKey,
  openRequest,
  onToggleExpanded,
  onClose,
}: {
  workspace: string;
  repoName: string;
  open: boolean;
  expanded?: boolean;
  canEdit?: boolean;
  canDownload?: boolean;
  canUpload?: boolean;
  refreshKey?: number;
  openRequest?: { id: number; path: string } | null;
  onToggleExpanded?: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<DrawerTab>("files");
  const [filter, setFilter] = useState("");
  const [branch, setBranch] = useState("");
  const [files, setFiles] = useState<RepoFileEntry[]>([]);
  const [changes, setChanges] = useState<RepoChangeEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [externalPath, setExternalPath] = useState<string | null>(null);
  const [selectedDir, setSelectedDir] = useState<string>("");
  const [preview, setPreview] = useState<RepoFileContent | null>(null);
  const [draftContent, setDraftContent] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [previewMode, setPreviewMode] = useState<FileViewMode>("code");
  const [viewOnlyOverride, setViewOnlyOverride] = useState(false);
  const [saving, setSaving] = useState(false);

  const [createKind, setCreateKind] = useState<"file" | "dir" | null>(null);
  const [createPathInput, setCreatePathInput] = useState("");
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState("");
  const [confirmDeletePath, setConfirmDeletePath] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [stagedOpen, setStagedOpen] = useState(true);
  const [unstagedOpen, setUnstagedOpen] = useState(true);
  const [contentRefresh, setContentRefresh] = useState(0);
  const uploadInput = useRef<HTMLInputElement>(null);
  const forceCodePath = useRef<string | null>(null);
  const autoModeFor = useRef<string | null>(null);
  const seenOpen = useRef(0);

  const isDirty = Boolean(preview && !preview.binary && draftContent !== preview.content);
  const isEditable = Boolean(canEdit && !externalPath && !viewOnlyOverride && preview && !preview.binary && !preview.truncated);
  const viewingPath = externalPath || selectedPath;

  const loadFiles = useCallback(async (ws: string) => {
    if (!ws) return;
    setLoading(true);
    setError("");
    try {
      const result = await listRepoFiles(ws);
      setBranch(result.branch);
      setFiles(result.files);
      setChanges(result.changes);
    } catch (err) {
      setError(message(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setSelectedPath(null);
    setExternalPath(null);
    setSelectedDir("");
    setPreview(null);
    setDraftContent("");
    setPreviewError("");
    setExpandedDirs(new Set());
    setFilter("");
    setCreateKind(null);
    setRenamingPath(null);
    setConfirmDeletePath(null);
    setCommitMessage("");
    setStagedOpen(true);
    setUnstagedOpen(true);
    autoModeFor.current = null;
    forceCodePath.current = null;
  }, [workspace]);

  useEffect(() => {
    if (!open || !workspace) return;
    void loadFiles(workspace);
  }, [open, workspace, refreshKey, loadFiles]);

  useEffect(() => {
    if (!open || !workspace || !selectedPath) return;
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError("");
    readRepoFile(workspace, selectedPath)
      .then((content) => {
        if (cancelled) return;
        setPreview(content);
        setDraftContent(content.content);
        const modeKey = `${selectedPath}:${tab}`;
        if (forceCodePath.current === selectedPath) {
          forceCodePath.current = null;
          autoModeFor.current = modeKey;
          setPreviewMode("code");
        } else if (autoModeFor.current !== modeKey) {
          autoModeFor.current = modeKey;
          setPreviewMode(defaultViewMode(selectedPath, tab, content.oldContent != null));
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setPreview(null);
        setDraftContent("");
        setPreviewError(message(err));
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, workspace, selectedPath, refreshKey, tab, contentRefresh]);

  const changeMap = useMemo(() => {
    const map = new Map<string, RepoChangeStatus>();
    for (const item of changes) {
      map.set(item.path, item.status);
    }
    return map;
  }, [changes]);

  const filteredFiles = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return files;
    const matched = new Set<string>();
    for (const entry of files) {
      if (entry.path.toLowerCase().includes(needle)) {
        matched.add(entry.path);
        const parts = entry.path.split("/");
        for (let i = 1; i < parts.length; i += 1) {
          matched.add(parts.slice(0, i).join("/"));
        }
      }
    }
    return files.filter((entry) => matched.has(entry.path));
  }, [files, filter]);

  const filteredChanges = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return changes;
    return changes.filter((item) => item.path.toLowerCase().includes(needle));
  }, [changes, filter]);

  const stagedChanges = useMemo(() => filteredChanges.filter((item) => item.staged), [filteredChanges]);
  const unstagedChanges = useMemo(() => filteredChanges.filter((item) => item.unstaged), [filteredChanges]);

  const tree = useMemo(() => buildTree(filteredFiles, changeMap), [filteredFiles, changeMap]);

  function expandAncestors(targetPath: string) {
    const parts = targetPath.split("/");
    if (parts.length <= 1) return;
    setExpandedDirs((current) => {
      const next = new Set(current);
      for (let i = 1; i < parts.length; i += 1) {
        next.add(parts.slice(0, i).join("/"));
      }
      return next;
    });
  }

  function toggleDir(dirPath: string) {
    setSelectedDir(dirPath);
    setExpandedDirs((current) => {
      const next = new Set(current);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  }

  function chooseViewMode(mode: FileViewMode) {
    const path = externalPath || selectedPath;
    if (path) {
      autoModeFor.current = `${path}:${tab}`;
      forceCodePath.current = mode === "code" ? path : null;
    }
    setPreviewMode(mode);
  }

  function selectFile(filePath: string, mode?: "code" | "preview") {
    if (selectedPath === filePath && !externalPath && !expanded && mode == null) {
      setSelectedPath(null);
      return;
    }
    if ((selectedPath !== filePath || externalPath) && isDirty) {
      if (!window.confirm("Discard unsaved changes to the current file?")) {
        return;
      }
    }
    setExternalPath(null);
    if (mode === "code") {
      forceCodePath.current = filePath;
      setPreviewMode("code");
    } else if (mode === "preview" || isPlanPath(filePath)) {
      forceCodePath.current = null;
      setPreviewMode("preview");
    } else {
      forceCodePath.current = null;
    }
    const parent = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
    setSelectedDir(parent);
    setSelectedPath(filePath);
    setRenamingPath(null);
    setConfirmDeletePath(null);
  }

  useEffect(() => {
    if (!open || !externalPath) return;
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError("");
    setPreview(null);
    setDraftContent("");
    readHomeFile(externalPath)
      .then((content) => {
        if (cancelled) return;
        setPreview(content);
        setDraftContent(content.content);
        setPreviewMode(isPlanPath(externalPath) ? "preview" : "code");
      })
      .catch((err) => {
        if (cancelled) return;
        setPreview(null);
        setDraftContent("");
        setPreviewError(message(err));
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, externalPath]);

  useEffect(() => {
    if (!open || !openRequest || openRequest.id === seenOpen.current) return;
    seenOpen.current = openRequest.id;
    const target = classifyOpenedPath(workspace, openRequest.path);
    if (!target) return;
    if (target.kind === "home") {
      if (isDirty && !window.confirm("Discard unsaved changes to the current file?")) return;
      setSelectedPath(null);
      setSelectedDir("");
      setPreview(null);
      setDraftContent("");
      setPreviewError("");
      setPreviewMode(isPlanPath(target.path) ? "preview" : "code");
      setRenamingPath(null);
      setConfirmDeletePath(null);
      setExternalPath(target.path);
      setTab("files");
      return;
    }
    setTab("files");
    expandAncestors(target.path);
    selectFile(target.path, isPlanPath(target.path) ? "preview" : "code");
  }, [open, openRequest, workspace]);

  async function refreshAfterGit(clearedPath?: string) {
    if (clearedPath && selectedPath === clearedPath) {
      setSelectedPath(null);
      setPreview(null);
      setDraftContent("");
    }
    await loadFiles(workspace);
    setContentRefresh((value) => value + 1);
  }

  async function runGitAction(action: "stage" | "unstage" | "discard", filePath: string) {
    if (!canEdit || actionBusy) return;
    const item = changes.find((entry) => entry.path === filePath);
    if (action === "discard") {
      const untracked = item?.worktreeStatus === "?" || item?.status === "?";
      const prompt = untracked ? `Delete untracked file ${filePath}?` : `Discard changes to ${filePath}?`;
      if (!window.confirm(prompt)) return;
    }
    setActionBusy(true);
    setError("");
    try {
      if (action === "stage") await stageRepoChange(workspace, filePath);
      else if (action === "unstage") await unstageRepoChange(workspace, filePath);
      else await discardRepoChange(workspace, filePath);
      const untracked = item?.worktreeStatus === "?" || item?.status === "?";
      await refreshAfterGit(action === "discard" && untracked ? filePath : undefined);
    } catch (err) {
      await loadFiles(workspace);
      setError(message(err));
    } finally {
      setActionBusy(false);
    }
  }

  async function runGitActionAll(action: "stage" | "unstage" | "discard", items: RepoChangeEntry[]) {
    if (!canEdit || actionBusy || items.length === 0) return;
    if (action === "discard") {
      const untracked = items.some((item) => item.worktreeStatus === "?" || item.status === "?");
      const noun = items.length === 1 ? "1 file" : `${items.length} files`;
      const prompt = untracked
        ? `Discard changes to ${noun}? Untracked files will be deleted.`
        : `Discard changes to ${noun}?`;
      if (!window.confirm(prompt)) return;
    }
    setActionBusy(true);
    setError("");
    try {
      for (const item of items) {
        if (action === "stage") await stageRepoChange(workspace, item.path);
        else if (action === "unstage") await unstageRepoChange(workspace, item.path);
        else await discardRepoChange(workspace, item.path);
      }
      const removed = action === "discard" ? items.find((item) => item.path === selectedPath && (item.worktreeStatus === "?" || item.status === "?")) : undefined;
      await refreshAfterGit(removed?.path);
    } catch (err) {
      await loadFiles(workspace);
      setContentRefresh((value) => value + 1);
      setError(message(err));
    } finally {
      setActionBusy(false);
    }
  }

  async function submitCommit() {
    const text = commitMessage.trim();
    if (!canEdit || !text || actionBusy || changes.length === 0) return;
    const stagedCount = changes.filter((item) => item.staged).length;
    const unstagedCount = changes.filter((item) => item.unstaged).length;
    if (stagedCount === 0 && unstagedCount === 0) return;
    if (isDirty && !window.confirm("Unsaved edits are not included. Commit the saved files anyway?")) return;
    let stageVisible = false;
    if (stagedCount === 0) {
      const noun = unstagedCount === 1 ? "1 visible change" : `${unstagedCount} visible changes`;
      if (!window.confirm(`No staged changes. Stage ${noun} and commit them?`)) return;
      stageVisible = true;
    }
    setActionBusy(true);
    setError("");
    try {
      await commitRepoChanges(workspace, text, stageVisible);
      setCommitMessage("");
      await refreshAfterGit();
    } catch (err) {
      await loadFiles(workspace);
      setContentRefresh((value) => value + 1);
      setError(message(err));
    } finally {
      setActionBusy(false);
    }
  }

  async function handleSave() {
    if (!workspace || !preview || !canEdit || !isDirty || saving || externalPath) return;
    setSaving(true);
    setPreviewError("");
    try {
      const updated = await writeRepoFile(workspace, preview.path, draftContent);
      setPreview(updated);
      setDraftContent(updated.content);
      await loadFiles(workspace);
    } catch (err) {
      setPreviewError(message(err));
    } finally {
      setSaving(false);
    }
  }

  function startCreate(kind: "file" | "dir") {
    setCreateKind(kind);
    const prefix = selectedDir ? `${selectedDir}/` : "";
    setCreatePathInput(prefix);
    setError("");
  }

  async function submitCreate(event: React.FormEvent) {
    event.preventDefault();
    if (!workspace || !createKind || actionBusy) return;
    const trimmed = createPathInput.trim().replace(/^\/+|\/+$/g, "");
    if (!trimmed) return;
    setActionBusy(true);
    setError("");
    try {
      const created = await createRepoEntry(workspace, trimmed, createKind, createKind === "file" ? "" : undefined);
      setCreateKind(null);
      setCreatePathInput("");
      expandAncestors(created.path);
      await loadFiles(workspace);
      if (created.kind === "file") {
        setSelectedPath(created.path);
        setPreviewMode("code");
      } else {
        setSelectedDir(created.path);
        setExpandedDirs((current) => new Set(current).add(created.path));
      }
    } catch (err) {
      setError(message(err));
    } finally {
      setActionBusy(false);
    }
  }

  function startRename(targetPath: string) {
    setRenamingPath(targetPath);
    setRenameInput(targetPath);
    setConfirmDeletePath(null);
    setError("");
  }

  async function submitRename(event: React.FormEvent) {
    event.preventDefault();
    if (!workspace || !renamingPath || actionBusy) return;
    const trimmed = renameInput.trim().replace(/^\/+|\/+$/g, "");
    if (!trimmed || trimmed === renamingPath) {
      setRenamingPath(null);
      return;
    }
    setActionBusy(true);
    setError("");
    try {
      const res = await renameRepoEntry(workspace, renamingPath, trimmed);
      setRenamingPath(null);
      expandAncestors(res.newPath);
      await loadFiles(workspace);
      if (selectedPath === renamingPath) {
        setSelectedPath(res.newPath);
      }
    } catch (err) {
      setError(message(err));
    } finally {
      setActionBusy(false);
    }
  }

  async function submitDownload() {
    if (!workspace || !selectedPath || !canDownload || actionBusy) return;
    setActionBusy(true);
    setError("");
    try {
      const { blob, name } = await downloadRepoFile(workspace, selectedPath);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(message(err));
    } finally {
      setActionBusy(false);
    }
  }

  async function submitUpload(list: FileList) {
    if (!workspace || !canUpload || actionBusy) return;
    const picked = [...list];
    if (picked.length === 0) return;
    const directory = selectedDir;
    const clashes = picked.filter((file) => {
      const rel = directory ? `${directory}/${file.name}` : file.name;
      return files.some((entry) => entry.path === rel);
    });
    let overwrite = false;
    if (clashes.length > 0) {
      const label = clashes.length === 1 ? clashes[0]!.name : `${clashes.length} files`;
      if (!window.confirm(`Replace ${label}?`)) return;
      overwrite = true;
    }
    setActionBusy(true);
    setError("");
    try {
      await uploadRepoFiles(workspace, directory, picked, overwrite);
      await loadFiles(workspace);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && !overwrite) {
        if (window.confirm("A file with that name already exists. Replace it?")) {
          try {
            await uploadRepoFiles(workspace, directory, picked, true);
            await loadFiles(workspace);
            return;
          } catch (retryErr) {
            setError(message(retryErr));
            await loadFiles(workspace);
            return;
          }
        }
      }
      setError(message(err));
      await loadFiles(workspace);
    } finally {
      setActionBusy(false);
    }
  }

  async function confirmDelete(targetPath: string) {
    if (!workspace || actionBusy) return;
    setActionBusy(true);
    setError("");
    try {
      await deleteRepoEntry(workspace, targetPath);
      setConfirmDeletePath(null);
      if (selectedPath === targetPath || (selectedPath && selectedPath.startsWith(`${targetPath}/`))) {
        setSelectedPath(null);
        setPreview(null);
        setDraftContent("");
      }
      if (selectedDir === targetPath || selectedDir.startsWith(`${targetPath}/`)) {
        setSelectedDir("");
      }
      await loadFiles(workspace);
    } catch (err) {
      setError(message(err));
    } finally {
      setActionBusy(false);
    }
  }

  if (!open) return null;

  const isFiltering = filter.trim().length > 0;
  const activeTarget = selectedPath || selectedDir || null;

  return (
    <aside className={expanded ? "file-drawer expanded" : "file-drawer"} aria-label="Repository files">
      <header className="file-drawer-head">
        <div className="file-drawer-title">
          <strong title={workspace}>{repoName}</strong>
          {branch && (
            <span className="file-branch" title={`Branch: ${branch}`}>
              <IconBranch />
              <span>{branch}</span>
            </span>
          )}
          <span className={canEdit ? "file-access-pill editable" : "file-access-pill readonly"}>
            {canEdit ? (viewOnlyOverride ? "Read-only view" : "Editor") : "Read-only"}
          </span>
        </div>
        <div className="file-drawer-actions">
          {canEdit && (
            <>
              <button
                className="icon-btn"
                type="button"
                title="New file"
                aria-label="New file"
                onClick={() => startCreate("file")}
              >
                <IconNewFile />
              </button>
              <button
                className="icon-btn"
                type="button"
                title="New folder"
                aria-label="New folder"
                onClick={() => startCreate("dir")}
              >
                <IconNewFolder />
              </button>
            </>
          )}
          {canUpload && (
            <>
              <button
                className="icon-btn"
                type="button"
                title={selectedDir ? `Upload into ${selectedDir}` : "Upload into repository root"}
                aria-label={selectedDir ? `Upload into ${selectedDir}` : "Upload into repository root"}
                disabled={actionBusy}
                onClick={() => uploadInput.current?.click()}
              >
                <IconUpload />
              </button>
              <input
                ref={uploadInput}
                type="file"
                multiple
                hidden
                onChange={(event) => {
                  const list = event.target.files;
                  if (list && list.length > 0) void submitUpload(list);
                  event.target.value = "";
                }}
              />
            </>
          )}
          {canDownload && selectedPath && (
            <button
              className="icon-btn"
              type="button"
              title={`Download ${selectedPath}`}
              aria-label={`Download ${selectedPath}`}
              disabled={actionBusy}
              onClick={() => void submitDownload()}
            >
              <IconDownload />
            </button>
          )}
          <button
            className="icon-btn"
            type="button"
            title="Refresh files"
            aria-label="Refresh files"
            disabled={loading}
            onClick={() => void loadFiles(workspace)}
          >
            <IconRefresh />
          </button>
          {onToggleExpanded && (
            <button
              className={expanded ? "icon-btn active" : "icon-btn"}
              type="button"
              title={expanded ? "Restore split view" : "Expand across chat window"}
              aria-label={expanded ? "Restore split view" : "Expand across chat window"}
              onClick={onToggleExpanded}
            >
              <IconExpand expanded={expanded} />
            </button>
          )}
          <button
            className="icon-btn"
            type="button"
            title="Collapse file manager"
            aria-label="Collapse file manager"
            onClick={onClose}
          >
            <IconPanelRight />
          </button>
        </div>
      </header>

      <div className="file-drawer-tabs" role="tablist" aria-label="File views">
        <button
          className={tab === "files" ? "file-tab active" : "file-tab"}
          type="button"
          role="tab"
          aria-selected={tab === "files"}
          onClick={() => setTab("files")}
        >
          All Files
        </button>
        <button
          className={tab === "changes" ? "file-tab active" : "file-tab"}
          type="button"
          role="tab"
          aria-selected={tab === "changes"}
          onClick={() => setTab("changes")}
        >
          <span>Changed</span>
          {changes.length > 0 && <span className="file-badge">{changes.length}</span>}
        </button>
      </div>

      <div className="file-drawer-search">
        <input
          value={filter}
          placeholder={tab === "files" ? "Filter files…" : "Filter changed files…"}
          aria-label="Filter files"
          onChange={(event) => setFilter(event.target.value)}
        />
        {canEdit && activeTarget && !createKind && !renamingPath && !confirmDeletePath && (
          <div className="file-tree-quick-actions">
            <button
              className="icon-btn"
              type="button"
              title={`Rename ${activeTarget}`}
              aria-label={`Rename ${activeTarget}`}
              onClick={() => startRename(activeTarget)}
            >
              <IconEdit />
            </button>
            <button
              className="icon-btn"
              type="button"
              title={`Delete ${activeTarget}`}
              aria-label={`Delete ${activeTarget}`}
              onClick={() => setConfirmDeletePath(activeTarget)}
            >
              <IconTrash />
            </button>
          </div>
        )}
      </div>

      {tab === "changes" && canEdit && (
        <form
          className="commit-box"
          onSubmit={(event) => {
            event.preventDefault();
            void submitCommit();
          }}
        >
          <input
            value={commitMessage}
            placeholder="Message"
            aria-label="Commit message"
            disabled={actionBusy}
            onChange={(event) => setCommitMessage(event.target.value)}
          />
          <button
            className="commit-btn"
            type="submit"
            disabled={actionBusy || !commitMessage.trim() || !changes.some((item) => item.staged || item.unstaged)}
          >
            <IconCheck />
            <span>Commit</span>
          </button>
        </form>
      )}

      {createKind && canEdit && (
        <form className="file-inline-form" onSubmit={(e) => void submitCreate(e)}>
          <span className="file-inline-label">{createKind === "file" ? "New file:" : "New folder:"}</span>
          <input
            value={createPathInput}
            placeholder={createKind === "file" ? "src/example.ts" : "src/components"}
            aria-label={createKind === "file" ? "New file path" : "New folder path"}
            autoFocus
            onChange={(e) => setCreatePathInput(e.target.value)}
          />
          <button className="btn small" type="submit" disabled={actionBusy || !createPathInput.trim()}>
            Create
          </button>
          <button className="btn ghost small" type="button" onClick={() => setCreateKind(null)}>
            Cancel
          </button>
        </form>
      )}

      {renamingPath && canEdit && (
        <form className="file-inline-form" onSubmit={(e) => void submitRename(e)}>
          <span className="file-inline-label">Rename:</span>
          <input
            value={renameInput}
            aria-label="New path"
            autoFocus
            onChange={(e) => setRenameInput(e.target.value)}
          />
          <button className="btn small" type="submit" disabled={actionBusy || !renameInput.trim()}>
            Save
          </button>
          <button className="btn ghost small" type="button" onClick={() => setRenamingPath(null)}>
            Cancel
          </button>
        </form>
      )}

      {confirmDeletePath && canEdit && (
        <div className="file-inline-form">
          <span className="file-inline-label" title={confirmDeletePath}>
            Delete <code>{confirmDeletePath}</code>?
          </span>
          <button
            className="btn danger small"
            type="button"
            disabled={actionBusy}
            onClick={() => void confirmDelete(confirmDeletePath)}
          >
            Delete
          </button>
          <button className="btn ghost small" type="button" onClick={() => setConfirmDeletePath(null)}>
            Cancel
          </button>
        </div>
      )}

      {error && <p className="alert file-drawer-error" role="alert">{error}</p>}

      <div className="file-drawer-body">
        <div className="file-tree" role="tree" aria-label={tab === "files" ? "Repository file tree" : "Changed files"}>
          {loading && files.length === 0 && <p className="muted file-empty">Loading files…</p>}

          {!loading && tab === "files" && tree.length === 0 && (
            <p className="muted file-empty">{isFiltering ? "No matching files." : "No visible files in this repository."}</p>
          )}

          {tab === "files" &&
            tree.map((node) => (
              <TreeItem
                key={node.path}
                node={node}
                depth={0}
                expanded={expandedDirs}
                forceOpen={isFiltering}
                selectedPath={selectedPath}
                selectedDir={selectedDir}
                onToggleDir={toggleDir}
                onSelectFile={selectFile}
              />
            ))}

          {!loading && tab === "changes" && filteredChanges.length === 0 && (
            <p className="muted file-empty">{isFiltering ? "No matching changes." : "Working tree is clean."}</p>
          )}

          {tab === "changes" && stagedChanges.length > 0 && (
            <ChangeSection
              title="Staged Changes"
              open={stagedOpen}
              count={stagedChanges.length}
              onToggle={() => setStagedOpen((value) => !value)}
              actions={canEdit ? (
                <button
                  className="change-action"
                  type="button"
                  title="Unstage all changes"
                  aria-label="Unstage all changes"
                  disabled={actionBusy}
                  onClick={() => void runGitActionAll("unstage", stagedChanges)}
                >
                  <IconMinus />
                </button>
              ) : null}
            >
              {stagedChanges.map((item) => (
                <ChangeRow
                  key={`staged:${item.path}`}
                  item={item}
                  side="staged"
                  active={selectedPath === item.path}
                  canEdit={canEdit}
                  busy={actionBusy}
                  onOpen={() => selectFile(item.path)}
                  onOpenFile={() => selectFile(item.path, "code")}
                  onUnstage={() => void runGitAction("unstage", item.path)}
                />
              ))}
            </ChangeSection>
          )}

          {tab === "changes" && unstagedChanges.length > 0 && (
            <ChangeSection
              title="Changes"
              open={unstagedOpen}
              count={unstagedChanges.length}
              onToggle={() => setUnstagedOpen((value) => !value)}
              actions={canEdit ? (
                <>
                  <button
                    className="change-action"
                    type="button"
                    title="Discard all changes"
                    aria-label="Discard all changes"
                    disabled={actionBusy}
                    onClick={() => void runGitActionAll("discard", unstagedChanges)}
                  >
                    <IconUndo />
                  </button>
                  <button
                    className="change-action"
                    type="button"
                    title="Stage all changes"
                    aria-label="Stage all changes"
                    disabled={actionBusy}
                    onClick={() => void runGitActionAll("stage", unstagedChanges)}
                  >
                    <IconPlus />
                  </button>
                </>
              ) : null}
            >
              {unstagedChanges.map((item) => (
                <ChangeRow
                  key={`unstaged:${item.path}`}
                  item={item}
                  side="unstaged"
                  active={selectedPath === item.path}
                  canEdit={canEdit}
                  busy={actionBusy}
                  onOpen={() => selectFile(item.path)}
                  onOpenFile={() => selectFile(item.path, "code")}
                  onDiscard={() => void runGitAction("discard", item.path)}
                  onStage={() => void runGitAction("stage", item.path)}
                />
              ))}
            </ChangeSection>
          )}
        </div>

        {(selectedPath || externalPath || expanded) && (
          <section className="file-preview" aria-label={viewingPath ? `File ${viewingPath}` : "File editor"}>
            {viewingPath ? (
              <>
                <header className="file-preview-head">
                  <div className="file-preview-meta">
                    <strong title={viewingPath}>
                      {viewingPath}
                      {isDirty && <span className="unsaved-dot" title="Unsaved changes"> ●</span>}
                    </strong>
                    {externalPath && <span className="muted">Outside this repository</span>}
                    {preview && !preview.binary && (
                      <span className="muted">
                        {formatSize(preview.size)}
                        {preview.truncated ? " · truncated (read-only)" : ""}
                      </span>
                    )}
                  </div>
                  <div className="file-preview-actions">
                    {canEdit && !externalPath && preview && !preview.binary && !preview.truncated && previewMode === "code" && (
                      <>
                        {isDirty && (
                          <button
                            className="btn ghost small"
                            type="button"
                            disabled={saving}
                            onClick={() => setDraftContent(preview.content)}
                          >
                            Discard
                          </button>
                        )}
                        <button
                          className="btn small"
                          type="button"
                          disabled={!isDirty || saving}
                          title="Save file (Ctrl+S)"
                          onClick={() => void handleSave()}
                        >
                          {saving ? "Saving…" : "Save"}
                        </button>
                        <button
                          className={viewOnlyOverride ? "mode-pill active" : "mode-pill"}
                          type="button"
                          title="Toggle between editable and read-only view"
                          onClick={() => setViewOnlyOverride((v) => !v)}
                        >
                          {viewOnlyOverride ? "Locked" : "Editable"}
                        </button>
                      </>
                    )}
                    {preview?.oldContent != null && !preview.binary && (
                      <div className="file-mode-switch" role="group" aria-label="Preview mode">
                        <button
                          className={previewMode === "code" ? "mode-pill active" : "mode-pill"}
                          type="button"
                          onClick={() => chooseViewMode("code")}
                        >
                          File
                        </button>
                        <button
                          className={previewMode === "diff" ? "mode-pill active" : "mode-pill"}
                          type="button"
                          onClick={() => chooseViewMode("diff")}
                        >
                          Diff
                        </button>
                      </div>
                    )}
                    {viewingPath && isMarkdownPath(viewingPath) && (
                      <button
                        className={previewMode === "preview" ? "mode-pill file-preview-toggle active" : "mode-pill file-preview-toggle"}
                        type="button"
                        title={previewMode === "preview" ? "Show source" : "Preview markdown"}
                        onClick={() => chooseViewMode(previewMode === "preview" ? "code" : "preview")}
                      >
                        {previewMode === "preview" ? "Source" : "Preview"}
                      </button>
                    )}
                    <button
                      className="icon-btn"
                      type="button"
                      aria-label="Close file"
                      title="Close file"
                      onClick={() => {
                        if (isDirty && !window.confirm("Discard unsaved changes to this file?")) return;
                        setSelectedPath(null);
                        setExternalPath(null);
                        setPreview(null);
                        setDraftContent("");
                      }}
                    >
                      ✕
                    </button>
                  </div>
                </header>
                <div className="file-preview-content">
                  {previewLoading && <p className="muted file-empty">Loading file…</p>}
                  {previewError && <p className="alert file-empty" role="alert">{previewError}</p>}
                  {!previewLoading && !previewError && preview && (
                    preview.binary ? (
                      <p className="muted file-empty">Binary file ({formatSize(preview.size)}) cannot be previewed.</p>
                    ) : previewMode === "diff" && preview.oldContent != null ? (
                      <DiffView path={preview.path} oldText={preview.oldContent} newText={draftContent} />
                    ) : previewMode === "preview" && isMarkdownPath(preview.path) ? (
                      <div className="file-markdown">
                        <Markdown text={draftContent} />
                      </div>
                    ) : (
                      <CodeEditor
                        filePath={preview.path}
                        value={draftContent}
                        readOnly={!isEditable}
                        onChange={setDraftContent}
                        onSave={() => void handleSave()}
                      />
                    )
                  )}
                </div>
              </>
            ) : (
              <div className="file-preview-placeholder">
                <p className="muted">Select a file from the repository tree to view{canEdit ? " or edit" : ""} its contents.</p>
              </div>
            )}
          </section>
        )}
      </div>
    </aside>
  );
}

function ChangeSection({
  title,
  open,
  count,
  onToggle,
  actions,
  children,
}: {
  title: string;
  open: boolean;
  count: number;
  onToggle: () => void;
  actions: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="change-section">
      <div className="change-section-head">
        <button className="change-section-toggle" type="button" aria-expanded={open} onClick={onToggle}>
          <IconChevron open={open} />
          <span>{title}</span>
        </button>
        <span className="change-section-side">
          {actions && <span className="change-section-actions">{actions}</span>}
          <span className="file-badge">{count}</span>
        </span>
      </div>
      {open && children}
    </section>
  );
}

function ChangeRow({
  item,
  side,
  active,
  canEdit,
  busy,
  onOpen,
  onOpenFile,
  onStage,
  onUnstage,
  onDiscard,
}: {
  item: RepoChangeEntry;
  side: "staged" | "unstaged";
  active: boolean;
  canEdit: boolean;
  busy: boolean;
  onOpen: () => void;
  onOpenFile: () => void;
  onStage?: () => void;
  onUnstage?: () => void;
  onDiscard?: () => void;
}) {
  const name = item.path.split("/").pop() || item.path;
  const dir = item.path.includes("/") ? item.path.slice(0, item.path.lastIndexOf("/")) : "";
  const status = side === "staged" ? item.indexStatus ?? item.status : item.worktreeStatus ?? item.status;
  return (
    <div className={active ? "file-row change-row active" : "file-row change-row"} role="treeitem" aria-selected={active}>
      <button className="change-row-main" type="button" title={item.path} onClick={onOpen}>
        <IconFile />
        <span className="file-name">{name}</span>
        {dir && <span className="file-dir">{dir}</span>}
      </button>
      <span className="change-row-actions">
        <button className="change-action" type="button" title="Open file" aria-label={`Open ${item.path}`} onClick={onOpenFile}>
          <IconFile />
        </button>
        {canEdit && side === "unstaged" && (
          <button
            className="change-action"
            type="button"
            title="Discard changes"
            aria-label={`Discard changes to ${item.path}`}
            disabled={busy}
            onClick={onDiscard}
          >
            <IconUndo />
          </button>
        )}
        {canEdit && side === "unstaged" && (
          <button
            className="change-action"
            type="button"
            title="Stage changes"
            aria-label={`Stage ${item.path}`}
            disabled={busy}
            onClick={onStage}
          >
            <IconPlus />
          </button>
        )}
        {canEdit && side === "staged" && (
          <button
            className="change-action"
            type="button"
            title="Unstage changes"
            aria-label={`Unstage ${item.path}`}
            disabled={busy}
            onClick={onUnstage}
          >
            <IconMinus />
          </button>
        )}
      </span>
      <span className={`git-status status-${statusKey(status)}`} title={statusLabel(status)}>
        {status === "?" ? "U" : status}
      </span>
    </div>
  );
}

function TreeItem({
  node,
  depth,
  expanded,
  forceOpen,
  selectedPath,
  selectedDir,
  onToggleDir,
  onSelectFile,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  forceOpen: boolean;
  selectedPath: string | null;
  selectedDir: string;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
}) {
  const isOpen = forceOpen || expanded.has(node.path);
  const indent = 8 + depth * 14;

  if (node.kind === "dir") {
    const dirSelected = !selectedPath && selectedDir === node.path;
    return (
      <div role="treeitem" aria-expanded={isOpen}>
        <button
          className={dirSelected ? "file-row dir-row active" : "file-row dir-row"}
          type="button"
          style={{ paddingLeft: `${indent}px` }}
          onClick={() => onToggleDir(node.path)}
          title={node.path}
        >
          <IconChevron open={isOpen} />
          <IconFolder open={isOpen} />
          <span className="file-name">{node.name}</span>
          {node.status && (
            <span className={`git-dot status-${statusKey(node.status)}`} title="Contains modified files" />
          )}
        </button>
        {isOpen &&
          node.children.map((child) => (
            <TreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              forceOpen={forceOpen}
              selectedPath={selectedPath}
              selectedDir={selectedDir}
              onToggleDir={onToggleDir}
              onSelectFile={onSelectFile}
            />
          ))}
      </div>
    );
  }

  const active = selectedPath === node.path;
  return (
    <button
      role="treeitem"
      aria-selected={active}
      className={active ? "file-row active" : "file-row"}
      type="button"
      style={{ paddingLeft: `${indent + 16}px` }}
      onClick={() => onSelectFile(node.path)}
      title={node.path}
    >
      <IconFile />
      <span className="file-name">{node.name}</span>
      {node.status && (
        <span className={`git-status status-${statusKey(node.status)}`} title={statusLabel(node.status)}>
          {node.status === "?" ? "U" : node.status}
        </span>
      )}
    </button>
  );
}

function buildTree(entries: RepoFileEntry[], changeMap: Map<string, RepoChangeStatus>): TreeNode[] {
  const roots: TreeNode[] = [];
  const byPath = new Map<string, TreeNode>();

  for (const entry of entries) {
    const node: TreeNode = {
      name: entry.name,
      path: entry.path,
      kind: entry.kind,
      size: entry.size,
      status: changeMap.get(entry.path),
      children: [],
    };
    byPath.set(entry.path, node);
    const slash = entry.path.lastIndexOf("/");
    if (slash < 0) {
      roots.push(node);
    } else {
      const parentPath = entry.path.slice(0, slash);
      const parent = byPath.get(parentPath);
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }
  }

  for (const [changedPath, status] of changeMap.entries()) {
    const parts = changedPath.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      const dirPath = parts.slice(0, i).join("/");
      const dirNode = byPath.get(dirPath);
      if (dirNode && !dirNode.status) {
        dirNode.status = status;
      }
    }
  }

  return roots;
}

function statusKey(status: RepoChangeStatus): string {
  if (status === "A" || status === "?") return "add";
  if (status === "D") return "del";
  return "mod";
}

function statusLabel(status: RepoChangeStatus): string {
  switch (status) {
    case "M":
      return "Modified";
    case "A":
      return "Added";
    case "D":
      return "Deleted";
    case "R":
      return "Renamed";
    case "U":
      return "Unmerged";
    case "?":
      return "Untracked";
  }
}

function isMarkdownPath(filePath: string): boolean {
  const name = filePath.split("/").pop()?.toLowerCase() ?? "";
  return name.endsWith(".md") || name.endsWith(".markdown");
}

function isPlanPath(filePath: string): boolean {
  const name = filePath.split("/").pop()?.toLowerCase() ?? "";
  return name.endsWith(".plan.md") || filePath.includes("/.cursor/plans/");
}

function defaultViewMode(filePath: string, tab: DrawerTab, hasDiff: boolean): FileViewMode {
  if (isPlanPath(filePath)) return "preview";
  if (hasDiff && tab === "changes") return "diff";
  return "code";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
