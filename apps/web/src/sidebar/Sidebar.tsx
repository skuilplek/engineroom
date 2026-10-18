import { useEffect, useState } from "react";
import type { AgentId, ChatMeta, ListedSession, RepositoryEntry } from "@engineroom/protocol";
import { buildGroups, strip, type RepoGroup } from "../format.ts";
import { IconGear, IconPlus, IconSliders } from "../icons.tsx";
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
  onNew,
  onOpen,
  onSettings,
  onAdmin,
  onLogout,
  onImported,
}: {
  session: { username: string; admin: boolean };
  chats: ChatMeta[];
  repos: RepositoryEntry[];
  home: string;
  view: View;
  activeId: string | null;
  target: string;
  error: string;
  onNew: (path: string) => void;
  onOpen: (chat: ChatMeta) => void;
  onSettings: () => void;
  onAdmin: () => void;
  onLogout: () => void;
  onImported: (chat: ChatMeta) => void;
}) {
  const [query, setQuery] = useState("");
  const [sessions, setSessions] = useState<ListedSession[] | null>(null);
  const [agent, setAgent] = useState<AgentId>("cursor");
  const groups = buildGroups(chats, repos, home, query);
  const repoSelected = repos.some((repo) => strip(repo.path) === strip(target));

  useEffect(() => onAgent((message) => {
    if (message.type === "sessions") setSessions(message.sessions);
    if (message.type === "imported") onImported(message.chat);
  }), [onImported]);

  function importList() {
    setSessions([]);
    sendCommand({ type: "list_sessions", agent });
  }

  return (
    <aside className="sidebar">
      <button className="new-chat" type="button" disabled={!repoSelected} onClick={() => onNew(target)}>
        <IconPlus />
        New Chat
      </button>
      <label className="search">
        <span className="sr">Search chats</span>
        <input value={query} placeholder="Search chats" onChange={(event) => setQuery(event.target.value)} />
      </label>
      <div className="side-nav">
        <button className={view === "settings" ? "nav-item active" : "nav-item"} type="button" onClick={onSettings}>
          <IconGear />
          Customize
        </button>
        {session.admin && (
          <button className={view === "admin" ? "nav-item active" : "nav-item"} type="button" onClick={onAdmin}>
            <IconSliders />
            Admin
          </button>
        )}
        <button className="nav-item" type="button" onClick={importList}>Import CLI sessions</button>
      </div>
      {sessions && (
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
      <p className="section-label">Conversations</p>
      <div className="tree">
        {groups.map((group) => (
          <Group key={group.key} group={group} view={view} activeId={activeId} target={target} onNew={onNew} onOpen={onOpen} />
        ))}
      </div>
      {error && <p className="alert" role="alert">{error}</p>}
      <div className="sidebar-foot">
        <div className="presence">
          <span className="dot" />
          <span>{session.username}</span>
        </div>
        <button className="sign-out" type="button" onClick={onLogout}>Sign out</button>
      </div>
    </aside>
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
          <option value="cursor">agent</option>
          <option value="claude">claude</option>
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
  onNew,
  onOpen,
}: {
  group: RepoGroup;
  view: View;
  activeId: string | null;
  target: string;
  onNew: (path: string) => void;
  onOpen: (chat: ChatMeta) => void;
}) {
  const selected = view === "start" && strip(target) === strip(group.path);
  return (
    <div>
      <div className={selected ? "repo-line active" : "repo-line"}>
        {group.canStart ? (
          <button className="repo-select" type="button" onClick={() => onNew(group.path)}>
            <span className="dot-slot">{group.marked ? <span className="dot" /> : null}</span>
            <span className="repo-name" title={group.label}>{group.label}</span>
            {group.time ? <span className="repo-time">{group.time}</span> : null}
          </button>
        ) : (
          <div className="repo-select">
            <span className="dot-slot">{group.marked ? <span className="dot" /> : null}</span>
            <span className="repo-name" title={group.label}>{group.label}</span>
            {group.time ? <span className="repo-time">{group.time}</span> : null}
          </div>
        )}
        {group.canStart && (
          <button className="plus" type="button" aria-label={`New chat in ${group.label}`} onClick={() => onNew(group.path)}>
            <IconPlus />
          </button>
        )}
      </div>
      {group.chats.map((chat) => (
        <button
          className={view === "chat" && chat.id === activeId ? "chat-row active" : "chat-row"}
          key={chat.id}
          type="button"
          onClick={() => onOpen(chat)}
        >
          <span className="chat-title">{chat.title}</span>
          {chat.running ? <span className="chat-state">Running</span> : null}
        </button>
      ))}
    </div>
  );
}
