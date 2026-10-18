import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { AgentId, ChatMeta } from "@engineroom/protocol";
import { listChats, listRepositories, login, logout, me, type Session } from "./api.ts";
import { ChatView } from "./chat/ChatView.tsx";
import { StartView } from "./chat/StartView.tsx";
import { message, strip } from "./format.ts";
import { AdminView } from "./settings/AdminView.tsx";
import { SettingsView } from "./settings/SettingsView.tsx";
import { Sidebar } from "./sidebar/Sidebar.tsx";
import { onAgent, startAgentSocket } from "./socket.ts";
import { applyTheme, rememberTheme } from "./theme.ts";

type View = "chat" | "settings" | "start" | "admin";

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    me().then(setSession).catch(() => setSession(null)).finally(() => setReady(true));
  }, []);

  useEffect(() => {
    if (session?.theme === "light" || session?.theme === "dark") rememberTheme(session.theme);
  }, [session?.theme]);

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
  const [repos, setRepos] = useState<Awaited<ReturnType<typeof listRepositories>>>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [target, setTarget] = useState(session.home);
  const [view, setView] = useState<View>("start");
  const [error, setError] = useState("");
  const openingRef = useRef<{ id: string; prompt: string } | null>(null);
  const consumedRef = useRef<string | null>(null);

  const claimOpening = useCallback((id: string): string | null => {
    const pending = openingRef.current;
    if (!pending || pending.id !== id || consumedRef.current === id) return null;
    consumedRef.current = id;
    return pending.prompt;
  }, []);

  const refresh = useCallback(async () => {
    const [nextChats, nextRepos] = await Promise.all([listChats(), listRepositories()]);
    setChats(nextChats);
    setRepos(nextRepos);
  }, []);

  useEffect(() => {
    startAgentSocket();
    refresh().catch((err) => setError(message(err)));
    return onAgent((incoming) => {
      if (incoming.type === "chats_changed") refresh().catch(() => undefined);
    });
  }, [refresh]);

  useEffect(() => {
    if (view === "settings") return;
    if (session.theme === "light" || session.theme === "dark") applyTheme(session.theme);
  }, [view, session.theme]);

  useEffect(() => {
    if (strip(target) === strip(session.home)) return;
    if (repos.some((repo) => strip(repo.path) === strip(target))) return;
    setTarget(session.home);
  }, [repos, session.home, target]);

  const targetLabel = repos.find((repo) => strip(repo.path) === strip(target))?.name
    ?? (strip(target) === strip(session.home) ? "No repository" : "No repository");

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

  const onTitle = useCallback((title: string) => {
    setChats((current) => current.map((chat) => (chat.id === activeId ? { ...chat, title } : chat)));
  }, [activeId]);

  return (
    <div className="shell">
      <Sidebar
        session={session}
        chats={chats}
        repos={repos}
        home={session.home}
        view={view}
        activeId={activeId}
        target={target}
        error={error}
        onNew={choose}
        onOpen={openChat}
        onSettings={() => setView("settings")}
        onAdmin={() => setView("admin")}
        onLogout={() => logout().finally(onLogout)}
        onImported={(chat) => {
          remember(chat);
          openChat(chat);
        }}
      />
      <section className="main">
        {view === "settings" && (
          <SettingsView
            agents={session.agents}
            options={session.options}
            onTheme={applyTheme}
            onSaved={(theme) => onSession({ ...session, theme })}
          />
        )}
        {view === "admin" && session.admin && (
          <AdminView
            session={session}
            onAgents={(agents, rawTerminal) => onSession({ ...session, agents, rawTerminal })}
            onAccess={() => {
              me().then(onSession).catch(() => undefined);
              refresh().catch(() => undefined);
            }}
          />
        )}
        {view === "start" && (
          <StartView
            agents={session.agents}
            options={session.options}
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
            rawTerminal={session.rawTerminal}
            claimOpening={claimOpening}
            onTitle={onTitle}
          />
        )}
      </section>
    </div>
  );
}
