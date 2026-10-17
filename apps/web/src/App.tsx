import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { AgentId, ChatDetail, ChatMeta, RepositoryEntry, Settings, StreamEvent, TranscriptEntry } from "@engineroom/protocol";
import { AGENTS, agentLabel } from "@engineroom/protocol";
import {
  ApiError,
  addAccount,
  cancelChat,
  createChat,
  followChat,
  getChat,
  getSettings,
  listAccounts,
  listChats,
  listRepositories,
  listUserRepositories,
  login,
  logout,
  me,
  revokeAccount,
  saveAgents,
  saveSettings,
  saveUserRepositories,
  sendMessage,
  type Account,
  type Session,
} from "./api.ts";

type View = "chat" | "settings" | "start" | "admin";

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    me().then(setSession).catch(() => setSession(null)).finally(() => setReady(true));
  }, []);

  if (!ready) return <main className="login-screen"><p className="muted">Loading…</p></main>;
  if (!session) return <Login onSuccess={setSession} />;
  return <Shell session={session} onLogout={() => setSession(null)} onSession={setSession} />;
}

function Login({ onSuccess }: { onSuccess: (session: Session) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onSuccess(await login(username.trim(), password));
    } catch (err) {
      setError(err instanceof Error ? err.message : "sign in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <p className="eyebrow">Engineroom</p>
        <h1>Sign in</h1>
        <p className="lede">Use your Linux account. Chats stay in that home directory.</p>
        <label>
          Username
          <input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        <p className="alert" role="alert">{error}</p>
        <button className="primary" type="submit" disabled={busy}>{busy ? "Checking…" : "Continue"}</button>
      </form>
    </main>
  );
}

function Shell({
  session,
  onLogout,
  onSession,
}: {
  session: Session;
  onLogout: () => void;
  onSession: (session: Session) => void;
}) {
  const [chats, setChats] = useState<ChatMeta[]>([]);
  const [repos, setRepos] = useState<RepositoryEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [target, setTarget] = useState(session.home);
  const [view, setView] = useState<View>("start");
  const [error, setError] = useState("");
  const openingRef = useRef<{ id: string; prompt: string } | null>(null);
  const consumedRef = useRef<string | null>(null);

  function claimOpening(id: string): string | null {
    const pending = openingRef.current;
    if (!pending || pending.id !== id || consumedRef.current === id) return null;
    consumedRef.current = id;
    return pending.prompt;
  }

  async function refresh() {
    const [nextChats, nextRepos] = await Promise.all([listChats(), listRepositories()]);
    setChats(nextChats);
    setRepos(nextRepos);
  }

  useEffect(() => {
    refresh().catch((err) => setError(err instanceof Error ? err.message : "could not load chats"));
  }, []);

  useEffect(() => {
    if (strip(target) === strip(session.home)) return;
    if (repos.some((repo) => strip(repo.path) === strip(target))) return;
    setTarget(session.home);
  }, [repos, session.home, target]);

  const groups = useMemo(() => buildGroups(chats, repos, session.home), [chats, repos, session.home]);
  const targetLabel = groups.find((group) => strip(group.path) === strip(target))?.label ?? "No repository";

  function remember(chat: ChatMeta) {
    setChats((current) => [chat, ...current.filter((item) => item.id !== chat.id)]);
  }

  function choose(path: string) {
    setTarget(path);
    setActiveId(null);
    setView("start");
  }

  function openChat(chat: ChatMeta) {
    openingRef.current = null;
    setActiveId(chat.id);
    setView("chat");
    const key = strip(chat.workspace);
    if (key === strip(session.home) || repos.some((repo) => strip(repo.path) === key)) setTarget(chat.workspace);
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <button className="new-chat" type="button" onClick={() => choose(target)}>
          <IconPlus />
          New Chat
        </button>
        <div className="side-nav">
          <button className={view === "settings" ? "nav-item active" : "nav-item"} type="button" onClick={() => setView("settings")}>
            <IconGear />
            Customize
          </button>
          {session.admin && (
            <button className={view === "admin" ? "nav-item active" : "nav-item"} type="button" onClick={() => setView("admin")}>
              <IconSliders />
              Admin
            </button>
          )}
        </div>
        <p className="section-label">Conversations</p>
        <div className="tree">
          {groups.map((group) => {
            const selected = view === "start" && strip(target) === strip(group.path);
            return (
              <div key={group.key}>
                <div className={selected ? "repo-line active" : "repo-line"}>
                  {group.canStart ? (
                    <button className="repo-select" type="button" onClick={() => choose(group.path)}>
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
                    <button className="plus" type="button" aria-label={`New chat in ${group.label}`} onClick={() => choose(group.path)}>
                      <IconPlus />
                    </button>
                  )}
                </div>
                {group.chats.map((chat) => (
                  <button
                    className={view === "chat" && chat.id === activeId ? "chat-row active" : "chat-row"}
                    key={chat.id}
                    type="button"
                    onClick={() => openChat(chat)}
                  >
                    <span className="chat-title">{chat.title}</span>
                    {chat.running ? <span className="chat-state">Running</span> : null}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
        {error && <p className="alert" role="alert">{error}</p>}
        <div className="sidebar-foot">
          <div className="presence">
            <span className="dot" />
            <span>{session.username}</span>
          </div>
          <button className="sign-out" type="button" onClick={() => logout().finally(onLogout)}>Sign out</button>
        </div>
      </aside>
      <section className="main">
        {view === "settings" && <SettingsView agents={session.agents} />}
        {view === "admin" && session.admin && (
          <AdminView
            session={session}
            onAgents={(agents) => onSession({ ...session, agents })}
            onRepos={() => refresh().catch(() => undefined)}
          />
        )}
        {view === "start" && (
          <StartView
            agents={session.agents}
            workspace={target}
            targetLabel={targetLabel}
            onStarted={(chat, prompt) => {
              remember(chat);
              openingRef.current = { id: chat.id, prompt };
              consumedRef.current = null;
              setActiveId(chat.id);
              setView("chat");
            }}
          />
        )}
        {view === "chat" && activeId && (
          <ChatView
            key={activeId}
            chatId={activeId}
            home={session.home}
            repos={repos}
            claimOpening={claimOpening}
            onChanged={() => refresh().catch(() => undefined)}
          />
        )}
      </section>
    </div>
  );
}

function StartView({
  agents,
  workspace,
  targetLabel,
  onStarted,
}: {
  agents: AgentId[];
  workspace: string;
  targetLabel: string;
  onStarted: (chat: ChatMeta, prompt: string) => void;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  const [agent, setAgent] = useState<AgentId>(agents[0] || "cursor");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getSettings().then((next) => {
      setAgent(agents.includes(next.defaultAgent) ? next.defaultAgent : agents[0] || next.defaultAgent);
      setModel(next.defaultModel);
    }).catch((err) => setError(message(err)));
  }, [agents]);

  useEffect(() => {
    box.current?.focus();
  }, [workspace]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || busy) return;
    setBusy(true);
    setError("");
    try {
      const chat = await createChat({ agent, model, workspace });
      onStarted(chat, text);
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }

  return (
    <div className="start">
      <h1>Let's Start Building!</h1>
      <form className="launch" onSubmit={(event) => void submit(event)}>
        <textarea
          ref={box}
          value={prompt}
          placeholder="What do you want to build?"
          aria-label="What do you want to build?"
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="launch-bar">
          {agents.length > 1 && (
            <label className="chip">
              <select aria-label="Agent" value={agent} onChange={(event) => setAgent(event.target.value as AgentId)}>
                {agents.map((item) => <option key={item} value={item}>{agentLabel(item)}</option>)}
              </select>
            </label>
          )}
          <label className="chip">
            Model
            <input aria-label="Model" value={model} placeholder="default" onChange={(event) => setModel(event.target.value)} />
          </label>
          <button className="send" type="submit" disabled={busy || !prompt.trim()} aria-label="Send">
            <IconArrow />
          </button>
        </div>
        {error && <p className="alert" role="alert">{error}</p>}
      </form>
      <p className="context-line">{targetLabel}</p>
    </div>
  );
}

function SettingsView({ agents }: { agents: AgentId[] }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getSettings().then((next) => {
      const agent = agents.includes(next.defaultAgent) ? next.defaultAgent : agents[0] || next.defaultAgent;
      setSettings({ ...next, defaultAgent: agent });
    }).catch((err) => setError(message(err)));
  }, [agents]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!settings) return;
    setBusy(true);
    setSaved("");
    setError("");
    try {
      setSettings(await saveSettings(settings));
      setSaved("Saved");
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  if (!settings) return <p className="settings muted">Loading settings…</p>;
  return (
    <form className="settings" onSubmit={submit}>
      <p className="eyebrow">Customize</p>
      <h2>Defaults for new chats</h2>
      <label>
        Default agent
        <select
          value={settings.defaultAgent}
          onChange={(event) => setSettings({ ...settings, defaultAgent: event.target.value as Settings["defaultAgent"] })}
        >
          {agents.map((item) => <option key={item} value={item}>{agentLabel(item)}</option>)}
        </select>
      </label>
      <label>
        Default model
        <input
          value={settings.defaultModel}
          placeholder="Leave blank for the CLI default"
          onChange={(event) => setSettings({ ...settings, defaultModel: event.target.value })}
        />
      </label>
      <details>
        <summary>CLI paths</summary>
        {agents.map((agent) => (
          <label key={agent}>
            {agentLabel(agent)}
            <input
              value={settings.binaries[agent] || ""}
              placeholder="Absolute path, or blank to use PATH"
              onChange={(event) =>
                setSettings({
                  ...settings,
                  binaries: { ...settings.binaries, [agent]: event.target.value },
                })
              }
            />
          </label>
        ))}
      </details>
      <p className="alert" role="alert">{error}</p>
      {saved && <p className="muted">{saved}</p>}
      <button className="primary" type="submit" disabled={busy}>Save</button>
    </form>
  );
}

function AdminView({
  session,
  onAgents,
  onRepos,
}: {
  session: Session;
  onAgents: (agents: AgentId[]) => void;
  onRepos: () => void;
}) {
  const [flags, setFlags] = useState<Record<AgentId, boolean>>(() => agentFlags(session.agents));
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);

  async function refreshUsers() {
    const next = await listAccounts();
    setAccounts(next);
    return next;
  }

  useEffect(() => {
    refreshUsers().catch((err) => setError(message(err)));
  }, []);

  function toggle(agent: AgentId) {
    const next = { ...flags, [agent]: !flags[agent] };
    if (!AGENTS.some((item) => next[item])) {
      setError("At least one agent must stay on");
      return;
    }
    setError("");
    setFlags(next);
  }

  async function saveAgentList(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setSaved("");
    setError("");
    try {
      const savedAgents = await saveAgents(flags);
      onAgents(savedAgents.agents);
      setSaved("Agents saved");
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function addUser(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSaved("");
    try {
      await addAccount(username.trim(), password);
      setUsername("");
      setPassword("");
      setSaved("Access granted");
      await refreshUsers();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(name: string) {
    setBusy(true);
    setError("");
    setSaved("");
    try {
      await revokeAccount(name);
      setSaved(`Revoked ${name}`);
      await refreshUsers();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings">
      <form onSubmit={(event) => void saveAgentList(event)}>
        <p className="eyebrow">Admin</p>
        <h2>Available agents</h2>
        <p className="muted">These are the agents everyone can choose for a new chat.</p>
        {AGENTS.map((agent) => (
          <label className="check" key={agent}>
            <input type="checkbox" checked={flags[agent]} onChange={() => toggle(agent)} />
            {agentLabel(agent)}
          </label>
        ))}
        <button className="primary" type="submit" disabled={busy}>Save agents</button>
      </form>
      <RepoAccess accounts={accounts} busy={busy} onSaved={onRepos} onError={setError} onBusy={setBusy} onNote={setSaved} />
      <form onSubmit={(event) => void addUser(event)}>
        <h2>People</h2>
        <p className="muted">A new name creates a Linux account. An existing account is granted access and given this password. Revoke removes access and leaves their files in place.</p>
        <div className="accounts">
          {accounts.map((account) => (
            <div className="account" key={account.username}>
              <div>
                <strong>{account.username}</strong>
                <span>{account.home}</span>
              </div>
              {account.username === session.username ? (
                <span className="muted">Administrator</span>
              ) : (
                <button className="danger" type="button" disabled={busy} onClick={() => void revoke(account.username)}>
                  Revoke
                </button>
              )}
            </div>
          ))}
          {accounts.length === 0 && <p className="muted">No accounts yet.</p>}
        </div>
        <label>
          Username
          <input autoComplete="off" value={username} onChange={(event) => setUsername(event.target.value)} required />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        <button className="primary" type="submit" disabled={busy}>Add user</button>
      </form>
      <p className="alert" role="alert">{error}</p>
      {saved && <p className="muted">{saved}</p>}
    </div>
  );
}

function RepoAccess({
  accounts,
  busy,
  onSaved,
  onError,
  onBusy,
  onNote,
}: {
  accounts: Account[];
  busy: boolean;
  onSaved: () => void;
  onError: (value: string) => void;
  onBusy: (value: boolean) => void;
  onNote: (value: string) => void;
}) {
  const [username, setUsername] = useState("");
  const [repos, setRepos] = useState<RepositoryEntry[] | null>(null);
  const [enabled, setEnabled] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (username && accounts.some((account) => account.username === username)) return;
    setUsername(accounts[0]?.username ?? "");
  }, [accounts, username]);

  useEffect(() => {
    if (!username) {
      setRepos([]);
      setEnabled(new Set());
      return undefined;
    }
    let cancel = false;
    setRepos(null);
    listUserRepositories(username).then((items) => {
      if (cancel) return;
      setRepos(items);
      setEnabled(new Set(items.filter((item) => item.enabled).map((item) => item.path)));
    }).catch((err) => {
      if (!cancel) onError(message(err));
    });
    return () => {
      cancel = true;
    };
  }, [username, onError]);

  function toggle(path: string) {
    setEnabled((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!username) return;
    onBusy(true);
    onNote("");
    onError("");
    try {
      const saved = await saveUserRepositories(username, [...enabled]);
      setRepos(saved);
      setEnabled(new Set(saved.filter((item) => item.enabled).map((item) => item.path)));
      onNote("Repositories saved");
      onSaved();
    } catch (err) {
      onError(message(err));
    } finally {
      onBusy(false);
    }
  }

  return (
    <form className="repo-access" onSubmit={(event) => void save(event)}>
      <h2>Repositories</h2>
      <p className="muted">Git repositories in Sites stay hidden until you enable them for that person. A chat can still start in the home directory with no repository.</p>
      <label>
        Person
        <select value={username} onChange={(event) => setUsername(event.target.value)} disabled={accounts.length === 0}>
          {accounts.map((account) => <option key={account.username} value={account.username}>{account.username}</option>)}
        </select>
      </label>
      <div className="repo-admin">
        {repos === null && <p className="muted">Loading repositories…</p>}
        {repos?.map((repo) => (
          <label className="check repo-choice" key={repo.path}>
            <input type="checkbox" checked={enabled.has(repo.path)} onChange={() => toggle(repo.path)} />
            <span>
              <strong>{repo.name}</strong>
              <span>{repo.path}</span>
            </span>
          </label>
        ))}
        {repos?.length === 0 && <p className="muted">No git repositories in Sites.</p>}
      </div>
      <button className="primary" type="submit" disabled={busy || !username || repos === null}>Save repositories</button>
    </form>
  );
}

function agentFlags(agents: AgentId[]): Record<AgentId, boolean> {
  return {
    cursor: agents.includes("cursor"),
    claude: agents.includes("claude"),
    pi: agents.includes("pi"),
  };
}

function ChatView({
  chatId,
  home,
  repos,
  claimOpening,
  onChanged,
}: {
  chatId: string;
  home: string;
  repos: RepositoryEntry[];
  claimOpening: (id: string) => string | null;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<ChatDetail | null>(null);
  const [draft, setDraft] = useState<TranscriptEntry[]>([]);
  const [prompt, setPrompt] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const serverCount = useRef(0);
  const skipUser = useRef<string | null>(null);
  const followGeneration = useRef(0);

  async function load() {
    followGeneration.current += 1;
    const next = await getChat(chatId);
    serverCount.current = next.transcript.length;
    setDetail(next);
    setDraft(next.transcript);
    return next;
  }

  async function runPrompt(text: string) {
    setStreaming(true);
    setError("");
    skipUser.current = text;
    setDraft((current) => [...current, { kind: "user", text, at: new Date().toISOString() }]);
    try {
      await sendMessage(chatId, text, (streamEvent) => {
        if (streamEvent.type === "error") setError(streamEvent.text);
      });
      await load();
      onChanged();
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError(message(err));
      }
    } finally {
      setStreaming(false);
    }
  }

  useEffect(() => {
    let gone = false;
    setDetail(null);
    setError("");
    load().then(() => {
      if (gone) return;
      const text = claimOpening(chatId);
      if (text) void runPrompt(text);
    }).catch((err) => {
      if (!gone) setError(message(err));
    });
    return () => {
      gone = true;
    };
  }, [chatId]);

  useEffect(() => {
    if (!streaming && !detail?.chat.running) return undefined;
    const controller = new AbortController();
    const generation = followGeneration.current;
    void followChat(chatId, serverCount.current, (entry) => {
      if (followGeneration.current !== generation) return;
      if (skipUser.current && entry.kind === "user" && entry.text === skipUser.current) {
        skipUser.current = null;
        serverCount.current += 1;
        return;
      }
      serverCount.current += 1;
      setDraft((current) => [...current, entry]);
    }, controller.signal).then(() => {
      if (!controller.signal.aborted && followGeneration.current === generation) {
        void load().catch(() => undefined);
      }
    }).catch(() => undefined);
    return () => controller.abort();
  }, [detail?.chat.running, streaming, chatId]);

  const blocks = useMemo(() => groupTranscript(draft), [draft]);
  const following = streaming || Boolean(detail?.chat.running);

  useEffect(() => {
    if (!following) return;
    const node = scroller.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [blocks, following]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || !detail || streaming) return;
    setPrompt("");
    await runPrompt(text);
  }

  async function stop() {
    await cancelChat(chatId).catch((err) => setError(message(err)));
  }

  if (!detail) {
    return <p className={error ? "settings alert" : "settings muted"} role={error ? "alert" : undefined}>{error || "Loading chat…"}</p>;
  }
  return (
    <>
      <header className="topbar">
        <div>
          <h2>{detail.chat.title}</h2>
          <p className="muted">{agentLabel(detail.chat.agent)} · {workspaceLabel(detail.chat.workspace, home, repos)}</p>
        </div>
        <div className="row">
          {(streaming || detail.chat.running) && (
            <button className="danger" type="button" onClick={() => void stop()}>Stop</button>
          )}
        </div>
      </header>
      <div className="transcript" ref={scroller}>
        {blocks.map((block, index) => {
          if (block.kind === "text") {
            const user = block.role === "user";
            return <div className={user ? "bubble user" : "bubble assistant"} key={index}>{block.text}</div>;
          }
          if (block.kind === "thinking") {
            return <p className="thinking" key={index}>{block.text}</p>;
          }
          if (block.kind === "tool") {
            const shown = presentTool(block);
            return (
              <div className="tool" key={index}>
                <div>{shown.title}</div>
                {shown.body ? <pre>{shown.body}</pre> : block.phase === "start" ? <pre>running…</pre> : null}
              </div>
            );
          }
          if (block.kind === "error") return <p className="alert" key={index} role="alert">{block.text}</p>;
          return <p className="status" key={index}>{block.text}</p>;
        })}
        {blocks.length === 0 && <p className="empty">Send a prompt to start.</p>}
      </div>
      <form className="composer" onSubmit={(event) => void submit(event)}>
        <textarea
          value={prompt}
          placeholder={streaming ? "Waiting for the agent…" : "Message this chat"}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <button className="primary" type="submit" disabled={streaming || !prompt.trim()}>Send</button>
        {error && <p className="alert" role="alert">{error}</p>}
      </form>
    </>
  );
}

function IconPlus() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M8 2.5v11M2.5 8h11" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function IconGear() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 1.6v1.8M8 12.6v1.8M1.6 8h1.8M12.6 8h1.8M3.2 3.2l1.3 1.3M11.5 11.5l1.3 1.3M12.8 3.2l-1.3 1.3M4.5 11.5l-1.3 1.3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function IconSliders() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M2 4h12M2 8h12M2 12h12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="5" cy="4" r="1.4" fill="currentColor" />
      <circle cx="11" cy="8" r="1.4" fill="currentColor" />
      <circle cx="7" cy="12" r="1.4" fill="currentColor" />
    </svg>
  );
}

function IconArrow() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface RepoGroup {
  key: string;
  label: string;
  path: string;
  chats: ChatMeta[];
  canStart: boolean;
  time?: string;
  marked: boolean;
}

function buildGroups(chats: ChatMeta[], repos: RepositoryEntry[], home: string): RepoGroup[] {
  const homeKey = strip(home);
  const buckets = new Map<string, ChatMeta[]>();
  for (const chat of chats) {
    const key = strip(chat.workspace);
    const list = buckets.get(key) ?? [];
    list.push(chat);
    buckets.set(key, list);
  }
  const newestKey = chats[0] ? strip(chats[0].workspace) : "";
  function take(key: string, label: string, canStart: boolean): RepoGroup {
    const items = buckets.get(key) ?? [];
    buckets.delete(key);
    return {
      key,
      label,
      path: key,
      chats: items,
      canStart,
      time: items[0] ? relativeTime(items[0].updatedAt) : undefined,
      marked: items.some((chat) => chat.running) || (newestKey !== "" && newestKey === key),
    };
  }
  const groups = [take(homeKey, "No repository", true)];
  for (const repo of [...repos].sort((a, b) => a.name.localeCompare(b.name))) {
    groups.push(take(strip(repo.path), repo.name, true));
  }
  for (const [key, items] of [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const label = key.split("/").filter(Boolean).pop() || key;
    groups.push({
      key,
      label,
      path: key,
      chats: items,
      canStart: false,
      time: items[0] ? relativeTime(items[0].updatedAt) : undefined,
      marked: items.some((chat) => chat.running) || newestKey === key,
    });
  }
  return groups;
}

function workspaceLabel(workspace: string, home: string, repos: RepositoryEntry[]): string {
  if (strip(workspace) === strip(home)) return "No repository";
  return repos.find((repo) => strip(repo.path) === strip(workspace))?.name
    || workspace.split("/").filter(Boolean).pop()
    || workspace;
}

function strip(value: string): string {
  return value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const delta = Math.max(0, Date.now() - then);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return "just now";
  if (delta < hour) return `${Math.round(delta / minute)}m ago`;
  if (delta < day) return `${Math.round(delta / hour)}h ago`;
  const days = Math.round(delta / day);
  if (days < 14) return `${days}d ago`;
  return `${Math.round(days / 7)}w ago`;
}

type Block =
  | { kind: "text"; role: "user" | "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id: string; name: string; phase: string; input?: string; output?: string }
  | { kind: "error"; text: string }
  | { kind: "status"; text: string };

function presentTool(block: { name: string; phase: string; input?: string; output?: string }): { title: string; body: string } {
  const action = readableField(block.input, ["command", "cmd", "globPattern", "glob_pattern", "pattern", "path", "file_path", "query", "url", "targetDirectory", "target_directory"]);
  const body = readableOutput(block.output);
  const title = action ? `${block.name} · ${action}` : `${block.name} · ${block.phase}`;
  return { title: title.length > 180 ? `${title.slice(0, 179)}…` : title, body };
}

function readableOutput(value?: string): string {
  const record = parseRecord(value);
  if (!record) return value?.trim() ?? "";
  const inner = unwrapRecord(record);
  for (const key of ["stdout", "interleavedOutput", "content", "error"]) {
    if (typeof inner[key] === "string" && inner[key]) return clipView(inner[key] as string);
  }
  if (Array.isArray(inner.files)) return clipView(inner.files.map(String).join("\n"));
  return clipView(value?.trim() ?? "");
}

function readableField(value: string | undefined, keys: string[]): string {
  const record = parseRecord(value);
  if (!record) {
    const line = value?.split("\n")[0]?.trim() ?? "";
    return line.length > 160 ? `${line.slice(0, 159)}…` : line;
  }
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key]) return record[key] as string;
  }
  return "";
}

function parseRecord(value?: string): Record<string, unknown> | null {
  if (!value || !value.trim().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function unwrapRecord(record: Record<string, unknown>): Record<string, unknown> {
  const nested = record.success ?? record.error ?? record.result ?? record.value;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) return unwrapRecord(nested as Record<string, unknown>);
  return record;
}

function clipView(text: string): string {
  return text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text;
}

function groupTranscript(entries: TranscriptEntry[]): Block[] {
  const blocks: Block[] = [];
  for (const entry of entries) {
    if (entry.kind === "user") {
      blocks.push({ kind: "text", role: "user", text: entry.text });
      continue;
    }
    if (entry.kind === "text") {
      const last = blocks.at(-1);
      if (last?.kind === "text" && last.role === "assistant") last.text += entry.text;
      else blocks.push({ kind: "text", role: "assistant", text: entry.text });
      continue;
    }
    if (entry.kind === "thinking") {
      const last = blocks.at(-1);
      if (last?.kind === "thinking") last.text += entry.text;
      else blocks.push({ kind: "thinking", text: entry.text });
      continue;
    }
    if (entry.kind === "tool") {
      const prior = [...blocks].reverse().find((block) => block.kind === "tool" && block.id === entry.id);
      if (prior && prior.kind === "tool") {
        prior.phase = entry.phase;
        if (entry.name && entry.name !== "tool") prior.name = entry.name;
        if (entry.input) prior.input = entry.input;
        if (entry.output) prior.output = entry.output;
      } else {
        blocks.push({
          kind: "tool",
          id: entry.id,
          name: entry.name,
          phase: entry.phase,
          input: entry.input,
          output: entry.output,
        });
      }
      continue;
    }
    if (entry.kind === "error") blocks.push({ kind: "error", text: entry.text });
    else blocks.push({ kind: "status", text: entry.text });
  }
  return blocks;
}

function applyStreamEvent(entries: TranscriptEntry[], event: StreamEvent): TranscriptEntry[] {
  const at = new Date().toISOString();
  if (event.type === "text_delta") return [...entries, { kind: "text", text: event.text, at }];
  if (event.type === "thinking") return [...entries, { kind: "thinking", text: event.text, at }];
  if (event.type === "tool") {
    return [...entries, { kind: "tool", id: event.id, name: event.name, phase: event.phase, input: event.input, output: event.output, at }];
  }
  if (event.type === "error") return [...entries, { kind: "error", text: event.text, at }];
  if (event.type === "status") return [...entries, { kind: "status", text: event.text, at }];
  return entries;
}

function message(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "request failed";
}
