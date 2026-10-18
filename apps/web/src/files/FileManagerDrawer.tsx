import { useCallback, useEffect, useMemo, useState } from "react";
import type { RepoChangeEntry, RepoChangeStatus, RepoFileContent, RepoFileEntry } from "@engineroom/protocol";
import { listRepoFiles, readRepoFile } from "../api.ts";
import { DiffView } from "../chat/Diff.tsx";
import { message } from "../format.ts";
import { IconBranch, IconChevron, IconFile, IconFolder, IconPanelRight, IconRefresh } from "../icons.tsx";

type DrawerTab = "files" | "changes";

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
  refreshKey,
  onClose,
}: {
  workspace: string;
  repoName: string;
  open: boolean;
  refreshKey?: number;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<DrawerTab>("files");
  const [filter, setFilter] = useState("");
  const [branch, setBranch] = useState("");
  const [files, setFiles] = useState<RepoFileEntry[]>([]);
  const [changes, setChanges] = useState<RepoChangeEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<RepoFileContent | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [previewMode, setPreviewMode] = useState<"code" | "diff">("code");

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
    setPreview(null);
    setPreviewError("");
    setExpanded(new Set());
    setFilter("");
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
        if (content.oldContent != null && tab === "changes") {
          setPreviewMode("diff");
        } else {
          setPreviewMode("code");
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setPreview(null);
        setPreviewError(message(err));
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, workspace, selectedPath, refreshKey, tab]);

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

  const tree = useMemo(() => buildTree(filteredFiles, changeMap), [filteredFiles, changeMap]);

  function toggleDir(dirPath: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  }

  function selectFile(filePath: string) {
    setSelectedPath((current) => (current === filePath ? null : filePath));
  }

  if (!open) return null;

  const isFiltering = filter.trim().length > 0;

  return (
    <aside className="file-drawer" aria-label="Repository files">
      <header className="file-drawer-head">
        <div className="file-drawer-title">
          <strong title={workspace}>{repoName}</strong>
          {branch && (
            <span className="file-branch" title={`Branch: ${branch}`}>
              <IconBranch />
              <span>{branch}</span>
            </span>
          )}
        </div>
        <div className="file-drawer-actions">
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
      </div>

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
                expanded={expanded}
                forceOpen={isFiltering}
                selectedPath={selectedPath}
                onToggleDir={toggleDir}
                onSelectFile={selectFile}
              />
            ))}

          {!loading && tab === "changes" && filteredChanges.length === 0 && (
            <p className="muted file-empty">{isFiltering ? "No matching changes." : "Working tree is clean."}</p>
          )}

          {tab === "changes" &&
            filteredChanges.map((item) => {
              const name = item.path.split("/").pop() || item.path;
              const dir = item.path.includes("/") ? item.path.slice(0, item.path.lastIndexOf("/")) : "";
              const active = selectedPath === item.path;
              return (
                <button
                  key={item.path}
                  className={active ? "file-row change-row active" : "file-row change-row"}
                  type="button"
                  onClick={() => selectFile(item.path)}
                  title={item.path}
                >
                  <IconFile />
                  <span className="file-name">{name}</span>
                  {dir && <span className="file-dir">{dir}</span>}
                  <span className={`git-status status-${statusKey(item.status)}`} title={statusLabel(item.status)}>
                    {item.status === "?" ? "U" : item.status}
                  </span>
                </button>
              );
            })}
        </div>

        {selectedPath && (
          <section className="file-preview" aria-label={`Preview ${selectedPath}`}>
            <header className="file-preview-head">
              <div className="file-preview-meta">
                <strong title={selectedPath}>{selectedPath}</strong>
                {preview && !preview.binary && (
                  <span className="muted">
                    {formatSize(preview.size)}
                    {preview.truncated ? " · truncated" : ""}
                  </span>
                )}
              </div>
              <div className="file-preview-actions">
                {preview?.oldContent != null && !preview.binary && (
                  <div className="file-mode-switch" role="group" aria-label="Preview mode">
                    <button
                      className={previewMode === "code" ? "mode-pill active" : "mode-pill"}
                      type="button"
                      onClick={() => setPreviewMode("code")}
                    >
                      File
                    </button>
                    <button
                      className={previewMode === "diff" ? "mode-pill active" : "mode-pill"}
                      type="button"
                      onClick={() => setPreviewMode("diff")}
                    >
                      Diff
                    </button>
                  </div>
                )}
                <button
                  className="icon-btn"
                  type="button"
                  aria-label="Close preview"
                  title="Close preview"
                  onClick={() => setSelectedPath(null)}
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
                  <DiffView path={preview.path} oldText={preview.oldContent} newText={preview.content} />
                ) : (
                  <CodeBlock content={preview.content} />
                )
              )}
            </div>
          </section>
        )}
      </div>
    </aside>
  );
}

function TreeItem({
  node,
  depth,
  expanded,
  forceOpen,
  selectedPath,
  onToggleDir,
  onSelectFile,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  forceOpen: boolean;
  selectedPath: string | null;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
}) {
  const isOpen = forceOpen || expanded.has(node.path);
  const indent = 8 + depth * 14;

  if (node.kind === "dir") {
    return (
      <div role="treeitem" aria-expanded={isOpen}>
        <button
          className="file-row dir-row"
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

function CodeBlock({ content }: { content: string }) {
  const lines = useMemo(() => content.split("\n"), [content]);
  return (
    <pre className="file-code">
      {lines.map((line, index) => (
        <div className="file-code-line" key={index}>
          <span className="file-line-num">{index + 1}</span>
          <span className="file-line-text">{line}</span>
        </div>
      ))}
    </pre>
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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
