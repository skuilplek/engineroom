import { useEffect, useState, type FormEvent } from "react";
import { agentLabel, type AgentId, type ChatMeta, type ListedSession, type RepositoryEntry } from "@engineroom/protocol";
import { buildGroups, relativeTime, strip, visibleProjectChats, type RepoGroup } from "../format.ts";
import { IconChevron, IconFolder, IconGear, IconPanelLeft, IconPlus, IconSignOut, IconSliders } from "../icons.tsx";
import { onAgent, sendCommand } from "../socket.ts";

type View = "chat" | "settings" | "start" | "admin";

export function Sidebar({
  session,
  chats,
  repos,
  home,
  view,
  activeId,
  target,
  error,
  collapsed,
  onToggleCollapsed,
  onNew,
  onOpen,
  onSettings,
  onAdmin,
  onLogout,
  onCreateProject,
  onImported,
}: {
  session: { username: string; admin: boolean; cliImport?: boolean; appName: string; projectCreate?: boolean; visibleChats?: number };
  chats: ChatMeta[];
  repos: RepositoryEntry[];
  home: string;
  view: View;
  activeId: string | null;
  target: string;
  error: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onNew: (path: string) => void;
  onOpen: (chat: ChatMeta) => void;
  onSettings: () => void;
  onAdmin: () => void;
  onLogout: () => void;
  onCreateProject: (name: string, url: string) => Promise<void>;
  onImported: (chat: ChatMeta) => void;
}) {
  const [query, setQuery] = useState("");
  const [sessions, setSessions] = useState<ListedSession[] | null>(null);
  const [agent, setAgent] = useState<AgentId>("cursor");
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set());
  const groups = buildGroups(chats, repos, home, query);
  const archivedGroups = buildGroups(chats, repos, home, query, true);
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

  useEffect(() => onAgent((message) => {
    if (message.type === "sessions") setSessions(message.sessions);
    if (message.type === "imported") onImported(message.chat);
  }), [onImported]);

  function importList() {
    setSessions([]);
    sendCommand({ type: "list_sessions", agent });
  }

  return (
    <aside id="sidebar-region" className={collapsed ? "sidebar collapsed" : "sidebar"}>
      <div className="sidebar-head">
        {!collapsed && <p className="app-brand" title={appName}>{appName}</p>}
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
      <div className="side-nav">
        <button
          className={view === "settings" ? "nav-item active" : "nav-item"}
          type="button"
          aria-label="Customize"
          title="Customize"
          onClick={onSettings}
        >
          <IconGear />
          {!collapsed && "Customize"}
        </button>
        {session.admin && (
          <button
            className={view === "admin" ? "nav-item active" : "nav-item"}
            type="button"
            aria-label="Admin"
            title="Admin"
            onClick={onAdmin}
          >
            <IconSliders />
            {!collapsed && "Admin"}
          </button>
        )}
        {!collapsed && session.cliImport && (
          <button className="nav-item" type="button" onClick={importList}>Import CLI sessions</button>
        )}
      </div>
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
            {groups.map((group) => (
              <Group
                key={group.key}
                group={group}
                view={view}
                activeId={activeId}
                target={target}
                limit={visibleChats}
                expanded={expandedProjects.has(group.key)}
                searching={searching}
                onToggleOlder={() => toggleOlder(group.key)}
                onNew={onNew}
                onOpen={onOpen}
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
                searching={searching}
                onToggleOlder={() => toggleOlder(group.key)}
                onNew={onNew}
                onOpen={onOpen}
              />
            ))}
          </div>
          {error && <p className="alert" role="alert">{error}</p>}
        </>
      )}
      <div className="sidebar-foot">
        {!collapsed && (
          <div className="presence">
            <span className="dot" />
            <span>{session.username}</span>
          </div>
        )}
        <button className="sign-out" type="button" aria-label="Sign out" title="Sign out" onClick={onLogout}>
          {collapsed ? <IconSignOut /> : "Sign out"}
        </button>
      </div>
    </aside>
  );
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
      /* the sidebar alert shows the reason */
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
          <option value="claude">{agentLabel("claude")}</option>
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
  searching,
  onToggleOlder,
  onNew,
  onOpen,
}: {
  group: RepoGroup;
  view: View;
  activeId: string | null;
  target: string;
  limit: number;
  expanded: boolean;
  searching: boolean;
  onToggleOlder: () => void;
  onNew: (path: string) => void;
  onOpen: (chat: ChatMeta) => void;
}) {
  const selected = view === "start" && strip(target) === strip(group.path);
  const { shown, older } = visibleProjectChats(group.chats, limit, view === "chat" ? activeId : null, { expanded, uncapped: searching });
  return (
    <div>
      <div className={selected ? "repo-line active" : "repo-line"}>
        {group.canStart ? (
          <button className="repo-select" type="button" onClick={() => onNew(group.path)}>
            <span className="repo-icon" aria-hidden="true"><IconFolder /></span>
            <span className="repo-name" title={group.label}>{group.label}</span>
          </button>
        ) : (
          <div className="repo-select">
            <span className="repo-icon" aria-hidden="true"><IconFolder /></span>
            <span className="repo-name" title={group.label}>{group.label}</span>
          </div>
        )}
        {group.canStart && (
          <button className="plus" type="button" aria-label={`New chat in ${group.label}`} onClick={() => onNew(group.path)}>
            <IconPlus />
          </button>
        )}
      </div>
      {shown.map((chat) => (
        <button
          className={view === "chat" && chat.id === activeId ? "chat-row active" : "chat-row"}
          key={chat.id}
          type="button"
          onClick={() => onOpen(chat)}
        >
          <span className={chat.running ? "dot" : "dot dot-idle"} />
          <span className="chat-title">{chat.title}</span>
          <span className="chat-time">{relativeTime(chat.updatedAt)}</span>
        </button>
      ))}
      {older > 0 && (
        <button className="section-toggle older-chats" type="button" aria-expanded={expanded} onClick={onToggleOlder}>
          <IconChevron open={expanded} />
          {expanded ? "Hide older" : `Show ${older} older`}
        </button>
      )}
    </div>
  );
}
