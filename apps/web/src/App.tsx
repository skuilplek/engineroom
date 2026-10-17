import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { AgentId, ChatDetail, ChatMeta, Settings, StreamEvent, TranscriptEntry, WorkspaceEntry } from "@engineroom/protocol";
import { AGENTS } from "@engineroom/protocol";
import {
  ApiError,
  addAccount,
  cancelChat,
  createChat,
  getChat,
  getSettings,
  listAccounts,
  listChats,
  listWorkspaces,
  login,
  logout,
  me,
  revokeAccount,
  saveAgents,
  saveSettings,
  sendMessage,
  type Account,
  type Session,
} from "./api.ts";

type View = "chat" | "settings" | "new" | "admin";

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
  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<View>("chat");
  const [error, setError] = useState("");

  async function refresh() {
    setChats(await listChats());
  }

  useEffect(() => {
    refresh().catch((err) => setError(err instanceof Error ? err.message : "could not load chats"));
  }, []);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div>
            <p className="eyebrow">Engineroom</p>
            <h1>{session.username}</h1>
            <p className="muted">{session.home}</p>
          </div>
          <button
            className="ghost"
            type="button"
            onClick={() => logout().finally(onLogout)}
          >
            Sign out
          </button>
        </div>
        <div className="nav">
          <button className="primary" type="button" onClick={() => setView("new")}>New chat</button>
          <button className="ghost" type="button" onClick={() => setView("settings")}>Settings</button>
          {session.admin && <button className="ghost" type="button" onClick={() => setView("admin")}>Admin</button>}
        </div>
        <div className="chat-list">
          {chats.map((chat) => (
            <button
              className={chat.id === activeId && view === "chat" ? "active" : ""}
              key={chat.id}
              type="button"
              onClick={() => {
                setActiveId(chat.id);
                setView("chat");
              }}
            >
              <strong>{chat.title}</strong>
              <span>{chat.agent}{chat.running ? " · running" : ""}</span>
            </button>
          ))}
          {chats.length === 0 && <p className="muted">No chats yet.</p>}
        </div>
        {error && <p className="alert" role="alert">{error}</p>}
      </aside>
      <section className="main">
        {view === "settings" && <SettingsView agents={session.agents} />}
        {view === "admin" && session.admin && (
          <AdminView
            session={session}
            onAgents={(agents) => onSession({ ...session, agents })}
          />
        )}
        {view === "new" && (
          <NewChat
            home={session.home}
            agents={session.agents}
            onCreated={(chat) => {
              setChats((current) => [chat, ...current.filter((item) => item.id !== chat.id)]);
              setActiveId(chat.id);
              setView("chat");
            }}
          />
        )}
        {view === "chat" && activeId && (
          <ChatView
            chatId={activeId}
            onChanged={() => refresh().catch(() => undefined)}
          />
        )}
        {view === "chat" && !activeId && <p className="empty">Choose a chat or start a new one.</p>}
      </section>
    </div>
  );
}

function NewChat({
  home,
  agents,
  onCreated,
}: {
  home: string;
  agents: AgentId[];
  onCreated: (chat: ChatMeta) => void;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [agent, setAgent] = useState(agents[0] || "cursor");
  const [model, setModel] = useState("");
  const [workspace, setWorkspace] = useState(home);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getSettings().then((next) => {
      setSettings(next);
      setAgent(agents.includes(next.defaultAgent) ? next.defaultAgent : agents[0] || next.defaultAgent);
      setModel(next.defaultModel);
    }).catch((err) => setError(err instanceof Error ? err.message : "could not load settings"));
    listWorkspaces().then((items) => {
      setWorkspaces(items);
      if (items[0]) setWorkspace(items[0].path);
    }).catch((err) => setError(err instanceof Error ? err.message : "could not list folders"));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onCreated(await createChat({ agent, model, workspace }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not create chat");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="settings" onSubmit={submit}>
      <p className="eyebrow">New chat</p>
      <h2>Start in {settings ? "your home" : "…"}</h2>
      <label>
        Agent
        <select value={agent} onChange={(event) => setAgent(event.target.value as AgentId)}>
          {agents.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </label>
      <label>
        Model
        <input value={model} placeholder="Leave blank for the CLI default" onChange={(event) => setModel(event.target.value)} />
      </label>
      <label>
        Workspace
        <select value={workspace} onChange={(event) => setWorkspace(event.target.value)}>
          {workspaces.map((item) => <option key={item.path} value={item.path}>{item.name}</option>)}
        </select>
      </label>
      <p className="muted">The agent is fixed after the chat is created. Tools run as you, inside this folder.</p>
      <p className="alert" role="alert">{error}</p>
      <button className="primary" type="submit" disabled={busy}>Create chat</button>
    </form>
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
      <p className="eyebrow">Settings</p>
      <h2>Defaults for new chats</h2>
      <label>
        Default agent
        <select
          value={settings.defaultAgent}
          onChange={(event) => setSettings({ ...settings, defaultAgent: event.target.value as Settings["defaultAgent"] })}
        >
          {agents.map((item) => <option key={item} value={item}>{item}</option>)}
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
            {agent}
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

function AdminView({ session, onAgents }: { session: Session; onAgents: (agents: AgentId[]) => void }) {
  const [flags, setFlags] = useState<Record<AgentId, boolean>>(() => agentFlags(session.agents));
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);

  async function refreshUsers() {
    setAccounts(await listAccounts());
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
            {agent}
          </label>
        ))}
        <button className="primary" type="submit" disabled={busy}>Save agents</button>
      </form>
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

function agentFlags(agents: AgentId[]): Record<AgentId, boolean> {
  return {
    cursor: agents.includes("cursor"),
    claude: agents.includes("claude"),
    pi: agents.includes("pi"),
  };
}

function ChatView({ chatId, onChanged }: { chatId: string; onChanged: () => void }) {
  const [detail, setDetail] = useState<ChatDetail | null>(null);
  const [draft, setDraft] = useState<TranscriptEntry[]>([]);
  const [prompt, setPrompt] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    const next = await getChat(chatId);
    setDetail(next);
    setDraft(next.transcript);
    return next;
  }

  useEffect(() => {
    setDetail(null);
    load().catch((err) => setError(message(err)));
  }, [chatId]);

  useEffect(() => {
    if (!detail?.chat.running || streaming) return undefined;
    const timer = setInterval(() => {
      load().catch(() => undefined);
    }, 1000);
    return () => clearInterval(timer);
  }, [detail?.chat.running, streaming, chatId]);

  const blocks = useMemo(() => groupTranscript(draft), [draft]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || !detail) return;
    setPrompt("");
    setStreaming(true);
    setError("");
    setDraft((current) => [...current, { kind: "user", text, at: new Date().toISOString() }]);
    try {
      await sendMessage(chatId, text, (streamEvent) => {
        setDraft((current) => applyStreamEvent(current, streamEvent));
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

  async function stop() {
    await cancelChat(chatId).catch((err) => setError(message(err)));
  }

  if (!detail) return <p className="settings muted">Loading chat…</p>;
  return (
    <>
      <header className="topbar">
        <div>
          <h2>{detail.chat.title}</h2>
          <p className="muted">{detail.chat.agent} · {detail.chat.workspace}</p>
        </div>
        <div className="row">
          {(streaming || detail.chat.running) && (
            <button className="danger" type="button" onClick={() => void stop()}>Stop</button>
          )}
        </div>
      </header>
      <div className="transcript">
        {blocks.map((block, index) => {
          if (block.kind === "text") {
            const user = block.role === "user";
            return <div className={user ? "bubble user" : "bubble assistant"} key={index}>{block.text}</div>;
          }
          if (block.kind === "tool") {
            return (
              <details className="tool" key={index} open={block.phase !== "done"}>
                <summary>{block.name} · {block.phase}</summary>
                {block.input && <pre>{block.input}</pre>}
                {block.output && <pre>{block.output}</pre>}
              </details>
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

type Block =
  | { kind: "text"; role: "user" | "assistant"; text: string }
  | { kind: "tool"; id: string; name: string; phase: string; input?: string; output?: string }
  | { kind: "error"; text: string }
  | { kind: "status"; text: string };

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
