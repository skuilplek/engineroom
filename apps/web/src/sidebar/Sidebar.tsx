import { useEffect, useRef, useState, type FormEvent } from "react";
import { agentLabel, type AgentId, type ChatMeta, type GitIdentity, type ListedSession, type RepositoryEntry } from "@engineroom/protocol";
import { getGitIdentity, saveGitIdentity } from "../api.ts";
import { useReportError } from "../errors.tsx";
import { activeChats, buildGroups, message, modeTone, pinnedChats, relativeTime, strip, visibleProjectChats, workspaceLabel, type RepoGroup } from "../format.ts";
import { IconAlert, IconBook, IconChevron, IconFolder, IconFullscreen, IconGear, IconPanelLeft, IconPin, IconPlus, IconSignOut, IconSliders } from "../icons.tsx";
import { onAgent, sendCommand } from "../socket.ts";
import { readCollapsedProjects, writeCollapsedProjects } from "./collapsedProjects.ts";

type View = "chat" | "settings" | "start" | "admin" | "docs" | "errors";

export function Sidebar({
  session,
  chats,
  repos,
  home,
  view,
  activeId,
  target,
  errorCount,
  collapsed,
  onToggleCollapsed,
  onNew,
  onOpen,
  onPin,
  onSettings,
  onDocs,
  onErrors,
  onAdmin,
  onLogout,
  onCreateProject,
  onImported,
  fullscreen,
  inert,
  identityRevision = 0,
}: {
  session: { username: string; admin: boolean; cliImport?: boolean; appName: string; projectCreate?: boolean; visibleChats?: number };
  chats: ChatMeta[];
  repos: RepositoryEntry[];
  home: string;
  view: View;
  activeId: string | null;
  target: string;
  errorCount: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onNew: (path: string) => void;
  onOpen: (chat: ChatMeta) => void;
  onPin: (chat: ChatMeta, pinned: boolean) => void;
  onSettings: () => void;
  onDocs: () => void;
  onErrors: () => void;
  onAdmin: () => void;
  onLogout: () => void;
  onCreateProject: (name: string, url: string) => Promise<void>;
  onImported: (chat: ChatMeta) => void;
  fullscreen: { active: boolean; enabled: boolean; toggle: () => void };
  inert?: boolean;
  identityRevision?: number;
}) {
  const [query, setQuery] = useState("");
  const [sessions, setSessions] = useState<ListedSession[] | null>(null);
  const [agent, setAgent] = useState<AgentId>("cursor");
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set());
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => readCollapsedProjects(session.username));
  const groups = buildGroups(chats, repos, home, query);
  const archivedGroups = buildGroups(chats, repos, home, query, true);
  const pinned = pinnedChats(chats, repos, home, query);
  const active = activeChats(chats, repos, home, query);
  const appName = session.appName.trim() || "AgentWrapper";
  const visibleChats = session.visibleChats ?? 5;
  const searching = query.trim() !== "";

  function toggleOlder(key: string) {
    setExpandedProjects((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleProject(key: string) {
    setCollapsedProjects((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeCollapsedProjects(session.username, next);
      return next;
    });
  }

  useEffect(() => {
    setCollapsedProjects(readCollapsedProjects(session.username));
  }, [session.username]);

  useEffect(() => onAgent((message) => {
    if (message.type === "sessions") setSessions(message.sessions);
    if (message.type === "imported") onImported(message.chat);
  }), [onImported]);

  function importList() {
    setSessions([]);
    sendCommand({ type: "list_sessions", agent });
  }

  return (
    <aside id="sidebar-region" className={collapsed ? "sidebar collapsed" : "sidebar"} inert={inert || undefined} aria-hidden={inert || undefined}>
      <div className="sidebar-head">
        {!collapsed && <p className="app-brand" title={appName}>{appName}</p>}
        {fullscreen.enabled && (
          <button
            className="sidebar-toggle sidebar-fullscreen"
            type="button"
            aria-pressed={fullscreen.active}
            aria-label={fullscreen.active ? "Exit full screen" : "Full screen"}
            title={fullscreen.active ? "Exit full screen" : "Full screen"}
            onClick={fullscreen.toggle}
          >
            <IconFullscreen active={fullscreen.active} />
          </button>
        )}
        <button
          className="sidebar-toggle"
          type="button"
          aria-expanded={!collapsed}
          aria-controls="sidebar-region"
          aria-label={collapsed ? "Expand menu" : "Collapse menu"}
          title={collapsed ? "Expand menu" : "Collapse menu"}
          onClick={onToggleCollapsed}
        >
          <IconPanelLeft />
        </button>
      </div>
      {!collapsed && (
        <label className="search">
          <span className="sr">Search chats</span>
          <input value={query} placeholder="Search chats" onChange={(event) => setQuery(event.target.value)} />
        </label>
      )}
      {!collapsed && session.cliImport && (
        <div className="side-nav">
          <button className="nav-item" type="button" onClick={importList}>Import CLI sessions</button>
        </div>
      )}
      {!collapsed && session.cliImport && sessions && (
        <ImportList
          agent={agent}
          sessions={sessions}
          onAgent={(value) => {
            setAgent(value);
            sendCommand({ type: "list_sessions", agent: value });
          }}
          onClose={() => setSessions(null)}
          onPick={(item) => {
            sendCommand({ type: "import_session", agent, agentSessionId: item.sessionId, workspace: item.cwd });
            setSessions(null);
          }}
        />
      )}
      {!collapsed && (
        <>
          {session.projectCreate && <NewProject onCreate={onCreateProject} />}
          <p className="section-label">Conversations</p>
          <div className="tree">
            {active.length > 0 && (
              <div className="active-chats">
                <p className="section-label">Active</p>
                {active.map((chat) => (
                  <ChatLine
                    key={chat.id}
                    chat={chat}
                    active={view === "chat" && chat.id === activeId}
                    project={workspaceLabel(chat.workspace, home, repos)}
                    pinned={false}
                    onOpen={onOpen}
                    onPin={onPin}
                  />
                ))}
              </div>
            )}
            {pinned.length > 0 && (
              <div className="pinned-chats">
                {pinned.map((chat) => (
                  <ChatLine
                    key={chat.id}
                    chat={chat}
                    active={view === "chat" && chat.id === activeId}
                    project={workspaceLabel(chat.workspace, home, repos)}
                    pinned
                    onOpen={onOpen}
                    onPin={onPin}
                  />
                ))}
              </div>
            )}
            {groups.map((group) => (
              <Group
                key={group.key}
                group={group}
                view={view}
                activeId={activeId}
                target={target}
                limit={visibleChats}
                expanded={expandedProjects.has(group.key)}
                collapsed={!searching && collapsedProjects.has(group.key)}
                searching={searching}
                onToggleOlder={() => toggleOlder(group.key)}
                onToggleCollapsed={() => toggleProject(group.key)}
                onNew={onNew}
                onOpen={onOpen}
                onPin={onPin}
              />
            ))}
            {archivedGroups.length > 0 && (
              <button
                className="section-toggle"
                type="button"
                aria-expanded={archivedOpen}
                onClick={() => setArchivedOpen((open) => !open)}
              >
                <IconChevron open={archivedOpen} />
                Archived
              </button>
            )}
            {archivedOpen && archivedGroups.map((group) => (
              <Group
                key={`archived-${group.key}`}
                group={group}
                view={view}
                activeId={activeId}
                target={target}
                limit={visibleChats}
                expanded={expandedProjects.has(group.key)}
                collapsed={!searching && collapsedProjects.has(group.key)}
                searching={searching}
                onToggleOlder={() => toggleOlder(group.key)}
                onToggleCollapsed={() => toggleProject(group.key)}
                onNew={onNew}
                onOpen={onOpen}
                onPin={onPin}
              />
            ))}
          </div>
        </>
      )}
      <UserMenu
        username={session.username}
        admin={session.admin}
        collapsed={collapsed}
        view={view}
        errorCount={errorCount}
        onSettings={onSettings}
        onDocs={onDocs}
        onErrors={onErrors}
        onAdmin={onAdmin}
        onLogout={onLogout}
        identityRevision={identityRevision}
      />
    </aside>
  );
}

function UserMenu({
  username,
  admin,
  collapsed,
  view,
  errorCount,
  onSettings,
  onDocs,
  onErrors,
  onAdmin,
  onLogout,
  identityRevision,
}: {
  username: string;
  admin: boolean;
  collapsed: boolean;
  view: View;
  errorCount: number;
  onSettings: () => void;
  onDocs: () => void;
  onErrors: () => void;
  onAdmin: () => void;
  onLogout: () => void;
  identityRevision: number;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [identity, setIdentity] = useState<GitIdentity | null>(null);
  const [ready, setReady] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftEmail, setDraftEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const report = useReportError();
  function setError(value: string) {
    if (value) report("Git identity", value);
  }
  const displayName = identity?.name || username;
  const complete = Boolean(identity?.name && identity?.email);
  const editingRef = useRef(editing);
  editingRef.current = editing;

  useEffect(() => {
    let active = true;
    getGitIdentity().then((next) => {
      if (!active) return;
      setIdentity(next);
      if (!editingRef.current) {
        setDraftName(next.name);
        setDraftEmail(next.email);
      }
    }).catch((err) => {
      if (active) setError(message(err));
    }).finally(() => {
      if (active) setReady(true);
    });
    return () => {
      active = false;
    };
  }, [identityRevision]);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function toggle() {
    setOpen((current) => {
      const next = !current;
      if (next) {
        setEditing(ready && (!identity?.name || !identity?.email));
        setDraftName(identity?.name ?? "");
        setDraftEmail(identity?.email ?? "");
      }
      return next;
    });
  }

  function choose(action: () => void) {
    setOpen(false);
    action();
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const saved = await saveGitIdentity({ name: draftName.trim(), email: draftEmail.trim() });
      setIdentity(saved);
      setDraftName(saved.name);
      setDraftEmail(saved.email);
      setEditing(false);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sidebar-foot" ref={root}>
      {open && (
        <div className="user-menu" aria-label="Account">
          {!ready ? (
            <p className="muted user-menu-identity">Loading…</p>
          ) : editing || !complete ? (
            <form className="user-menu-form" onSubmit={(event) => void save(event)}>
              <label>
                Name
                <input
                  value={draftName}
                  autoComplete="name"
                  autoFocus
                  required
                  onChange={(event) => setDraftName(event.target.value)}
                />
              </label>
              <label>
                Email
                <input
                  type="email"
                  value={draftEmail}
                  autoComplete="email"
                  required
                  onChange={(event) => setDraftEmail(event.target.value)}
                />
              </label>
              <p className="muted user-menu-note">Saved as your global git name and email.</p>
              <div className="user-menu-actions">
                <button className="primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
                {complete && (
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => {
                      setDraftName(identity?.name ?? "");
                      setDraftEmail(identity?.email ?? "");
                      setEditing(false);
                      setError("");
                    }}
                    disabled={busy}
                  >
                    Cancel
                  </button>
                )}
              </div>
            </form>
          ) : (
            <div className="user-menu-identity">
              <div className="user-menu-id">
                <strong>{identity?.name}</strong>
                <span className="muted">{identity?.email}</span>
              </div>
              <button
                className="user-menu-edit"
                type="button"
                onClick={() => {
                  setDraftName(identity?.name ?? "");
                  setDraftEmail(identity?.email ?? "");
                  setEditing(true);
                  setError("");
                }}
              >
                Edit
              </button>
            </div>
          )}
          <div className="user-menu-sep" />
          <button
            className={view === "settings" ? "user-menu-item active" : "user-menu-item"}
            type="button"
            onClick={() => choose(onSettings)}
          >
            <IconGear />
            Customize
          </button>
          <button
            className={view === "docs" ? "user-menu-item active" : "user-menu-item"}
            type="button"
            onClick={() => choose(onDocs)}
          >
            <IconBook />
            Docs
          </button>
          {errorCount > 0 && (
            <button
              className={view === "errors" ? "user-menu-item active" : "user-menu-item"}
              type="button"
              onClick={() => choose(onErrors)}
            >
              <IconAlert />
              Errors
              <span className="user-menu-count">{errorCount}</span>
            </button>
          )}
          {admin && (
            <button
              className={view === "admin" ? "user-menu-item active" : "user-menu-item"}
              type="button"
              onClick={() => choose(onAdmin)}
            >
              <IconSliders />
              Admin
            </button>
          )}
          <div className="user-menu-sep" />
          <button className="user-menu-item" type="button" onClick={onLogout}>
            <IconSignOut />
            Sign out
          </button>
        </div>
      )}
      <button
        className={open ? "account-button open" : "account-button"}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${displayName}`}
        title={displayName}
        onClick={toggle}
      >
        <span className="account-avatar" aria-hidden="true">{initialOf(displayName)}</span>
        {!collapsed && (
          <span className="account-meta">
            <span className="account-name">{displayName}</span>
            {identity?.name ? <span className="account-user">{username}</span> : null}
          </span>
        )}
      </button>
    </div>
  );
}

function initialOf(value: string): string {
  const match = value.trim().match(/\p{L}|\p{N}/u);
  return (match ? match[0] : "?").toLocaleUpperCase();
}

function NewProject({ onCreate }: { onCreate: (name: string, url: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await onCreate(name.trim(), url.trim());
      setName("");
      setUrl("");
      setOpen(false);
    } catch {
      /* the notice shows the reason */
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="nav-item" type="button" onClick={() => setOpen(true)}>
        <IconPlus />
        New project
      </button>
    );
  }

  return (
    <form className="new-project" onSubmit={(event) => void submit(event)}>
      <label>
        Folder name
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="widget" required autoFocus />
      </label>
      <label>
        Git URL
        <input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="Leave blank to start an empty repository"
        />
      </label>
      <div className="new-project-actions">
        <button className="primary" type="submit" disabled={busy}>{busy ? "Creating…" : "Create"}</button>
        <button type="button" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}

function ImportList({
  agent,
  sessions,
  onAgent,
  onClose,
  onPick,
}: {
  agent: AgentId;
  sessions: ListedSession[];
  onAgent: (agent: AgentId) => void;
  onClose: () => void;
  onPick: (session: ListedSession) => void;
}) {
  return (
    <div className="import-list">
      <div className="row">
        <select aria-label="Agent to import" value={agent} onChange={(event) => onAgent(event.target.value as AgentId)}>
          <option value="cursor">{agentLabel("cursor")}</option>
        </select>
        <button type="button" onClick={onClose}>Close</button>
      </div>
      {sessions.length === 0 && <p className="muted">Looking for CLI sessions…</p>}
      {sessions.map((item) => (
        <button className="chat-row" key={item.sessionId} type="button" onClick={() => onPick(item)}>
          <span className="chat-title">{item.title || item.cwd || item.sessionId}</span>
        </button>
      ))}
    </div>
  );
}

function Group({
  group,
  view,
  activeId,
  target,
  limit,
  expanded,
  collapsed,
  searching,
  onToggleOlder,
  onToggleCollapsed,
  onNew,
  onOpen,
  onPin,
}: {
  group: RepoGroup;
  view: View;
  activeId: string | null;
  target: string;
  limit: number;
  expanded: boolean;
  collapsed: boolean;
  searching: boolean;
  onToggleOlder: () => void;
  onToggleCollapsed: () => void;
  onNew: (path: string) => void;
  onOpen: (chat: ChatMeta) => void;
  onPin: (chat: ChatMeta, pinned: boolean) => void;
}) {
  const selected = view === "start" && strip(target) === strip(group.path);
  const { shown, older } = visibleProjectChats(group.chats, limit, view === "chat" ? activeId : null, { expanded, uncapped: searching });
  const rows = collapsed
    ? shown.filter((chat) => chat.running === true || chat.waiting === true || (view === "chat" && chat.id === activeId))
    : shown;
  const marked = group.chats.some((chat) => chat.running === true || chat.waiting === true);
  return (
    <div>
      <div className={selected ? "repo-line active" : "repo-line"}>
        <button
          className="repo-chevron"
          type="button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Expand ${group.label} chats` : `Collapse ${group.label} chats`}
          title={collapsed ? "Expand chats" : "Collapse chats"}
          onClick={onToggleCollapsed}
        >
          <IconChevron open={!collapsed} />
        </button>
        {group.canStart ? (
          <button className="repo-select" type="button" onClick={() => onNew(group.path)}>
            <span className="repo-icon" aria-hidden="true"><IconFolder open={!collapsed} /></span>
            <span className="repo-name" title={group.label}>{group.label}</span>
            {marked && <span className="dot repo-dot" aria-label="Active chats" />}
          </button>
        ) : (
          <div className="repo-select">
            <span className="repo-icon" aria-hidden="true"><IconFolder open={!collapsed} /></span>
            <span className="repo-name" title={group.label}>{group.label}</span>
          </div>
        )}
        {group.canStart && (
          <button className="plus" type="button" aria-label={`New chat in ${group.label}`} onClick={() => onNew(group.path)}>
            <IconPlus />
          </button>
        )}
      </div>
      {rows.map((chat) => (
        <ChatLine
          key={chat.id}
          chat={chat}
          active={view === "chat" && chat.id === activeId}
          pinned={false}
          onOpen={onOpen}
          onPin={onPin}
        />
      ))}
      {!collapsed && older > 0 && (
        <button className="section-toggle older-chats" type="button" aria-expanded={expanded} onClick={onToggleOlder}>
          <IconChevron open={expanded} />
          {expanded ? "Hide older" : `Show ${older} older`}
        </button>
      )}
    </div>
  );
}

function ChatLine({
  chat,
  active,
  project,
  pinned,
  onOpen,
  onPin,
}: {
  chat: ChatMeta;
  active: boolean;
  project?: string;
  pinned: boolean;
  onOpen: (chat: ChatMeta) => void;
  onPin: (chat: ChatMeta, pinned: boolean) => void;
}) {
  return (
    <div className={active ? "chat-line active" : "chat-line"}>
      <button
        className={active ? "chat-row active" : "chat-row"}
        type="button"
        onClick={() => onOpen(chat)}
      >
        <span className={chatDotClass(chat)} data-mode={modeTone(chat.mode) || undefined} />
        <span className="chat-title">{chat.title}</span>
        {project ? <span className="chat-project" title={project}>{project}</span> : null}
        <span className="chat-time">{relativeTime(chat.updatedAt)}</span>
      </button>
      <button
        className="chat-pin"
        type="button"
        aria-pressed={pinned}
        aria-label={pinned ? `Unpin ${chat.title}` : `Pin ${chat.title}`}
        title={pinned ? "Unpin" : "Pin"}
        onClick={() => onPin(chat, !pinned)}
      >
        <IconPin filled={pinned} />
      </button>
    </div>
  );
}

function chatDotClass(chat: ChatMeta): string {
  if (chat.waiting) return "dot dot-waiting";
  const tone = modeTone(chat.mode);
  if (tone) return chat.running ? "dot dot-live" : "dot";
  return chat.running ? "dot" : "dot dot-idle";
}
