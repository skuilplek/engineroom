import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { isTheme, type ChatMeta, type RepositoryEntry } from "@engineroom/protocol";
import { listChats, listRepositories, login, logout, me, type Session } from "./api.ts";
import { ChatView } from "./chat/ChatView.tsx";
import { forgetLastChat, pickLastChat, readLastChat, writeLastChat } from "./chat/lastChat.ts";
import { StartView } from "./chat/StartView.tsx";
import { FileManagerDrawer } from "./files/FileManagerDrawer.tsx";
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
    if (session && isTheme(session.theme)) rememberTheme(session.theme);
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
  const [checkingChat, setCheckingChat] = useState(() => readLastChat(session.username) != null);
  const [error, setError] = useState("");
  const [filesOpen, setFilesOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem("engineroom.filesOpen") === "1";
    } catch {
      return false;
    }
  });
  const [filesExpanded, setFilesExpanded] = useState<boolean>(() => {
    try {
      return localStorage.getItem("engineroom.filesExpanded") === "1";
    } catch {
      return false;
    }
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("engineroom.sidebarCollapsed") === "1";
    } catch {
      return false;
    }
  });
  const [filesRefreshKey, setFilesRefreshKey] = useState(0);
  const openingRef = useRef<{ id: string; prompt: string } | null>(null);
  const consumedRef = useRef<string | null>(null);
  const restoredRef = useRef(false);
  const choseRef = useRef(false);
  const usernameRef = useRef(session.username);
  const homeRef = useRef(session.home);
  const reposRef = useRef<RepositoryEntry[]>([]);
  usernameRef.current = session.username;
  homeRef.current = session.home;
  reposRef.current = repos;

  const toggleFiles = useCallback(() => {
    setFilesOpen((current) => {
      const next = !current;
      try {
        localStorage.setItem("engineroom.filesOpen", next ? "1" : "0");
      } catch {
        /* ignore storage failure */
      }
      return next;
    });
  }, []);

  const toggleFilesExpanded = useCallback(() => {
    setFilesExpanded((current) => {
      const next = !current;
      try {
        localStorage.setItem("engineroom.filesExpanded", next ? "1" : "0");
      } catch {
        /* ignore storage failure */
      }
      return next;
    });
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem("engineroom.sidebarCollapsed", next ? "1" : "0");
      } catch {
        /* ignore storage failure */
      }
      return next;
    });
  }, []);

  const bumpFilesRefresh = useCallback(() => {
    setFilesRefreshKey((current) => current + 1);
  }, []);

  const claimOpening = useCallback((id: string): string | null => {
    const pending = openingRef.current;
    if (!pending || pending.id !== id || consumedRef.current === id) return null;
    consumedRef.current = id;
    return pending.prompt;
  }, []);

  const showChat = useCallback((chat: ChatMeta, knownRepos: RepositoryEntry[]) => {
    openingRef.current = null;
    writeLastChat(usernameRef.current, chat.id);
    setActiveId(chat.id);
    setView("chat");
    const key = strip(chat.workspace);
    if (key === strip(homeRef.current) || knownRepos.some((repo) => strip(repo.path) === key)) setTarget(chat.workspace);
  }, []);

  const refresh = useCallback(async () => {
    const [nextChats, nextRepos] = await Promise.all([listChats(), listRepositories()]);
    setChats(nextChats);
    setRepos(nextRepos);
    if (restoredRef.current) return;
    restoredRef.current = true;
    setCheckingChat(false);
    if (choseRef.current) return;
    const stored = readLastChat(usernameRef.current);
    const chat = pickLastChat(nextChats, stored);
    if (chat) {
      showChat(chat, nextRepos);
      return;
    }
    if (stored) forgetLastChat(usernameRef.current);
  }, [showChat]);

  useEffect(() => {
    startAgentSocket();
    refresh().catch((err) => {
      setCheckingChat(false);
      setError(message(err));
    });
    return onAgent((incoming) => {
      if (incoming.type === "chats_changed") refresh().catch(() => undefined);
    });
  }, [refresh]);

  useEffect(() => {
    if (view === "settings") return;
    if (isTheme(session.theme)) applyTheme(session.theme);
  }, [view, session.theme]);

  useEffect(() => {
    if (strip(target) === strip(session.home)) return;
    if (repos.some((repo) => strip(repo.path) === strip(target))) return;
    setTarget(session.home);
  }, [repos, session.home, target]);

  const selectedRepo = repos.find((repo) => strip(repo.path) === strip(target));
  const filesEnabled = session.fileManager;
  const showFileManager = filesEnabled && (view === "chat" || view === "start") && Boolean(selectedRepo);

  useEffect(() => {
    if (filesEnabled) return;
    setFilesOpen(false);
    try {
      localStorage.removeItem("engineroom.filesOpen");
    } catch {
      /* ignore storage failure */
    }
  }, [filesEnabled]);

  function remember(chat: ChatMeta) {
    setChats((current) => [chat, ...current.filter((item) => item.id !== chat.id)]);
  }

  function choose(path: string) {
    choseRef.current = true;
    setTarget(path);
    setActiveId(null);
    setView("start");
  }

  function openChat(chat: ChatMeta) {
    choseRef.current = true;
    showChat(chat, reposRef.current);
  }

  const onTitle = useCallback((title: string) => {
    setChats((current) => current.map((chat) => (chat.id === activeId ? { ...chat, title } : chat)));
  }, [activeId]);

  const onChatWorkspace = useCallback((workspace: string) => {
    const key = strip(workspace);
    if (key === strip(session.home) || repos.some((repo) => strip(repo.path) === key)) {
      setTarget(workspace);
    }
  }, [repos, session.home]);

  const canEditFiles = Boolean(session.fileEditor) && !session.filesReadOnly;
  const canDownloadFiles = Boolean(session.fileDownload);
  const canUploadFiles = Boolean(session.fileUpload) && !session.filesReadOnly;

  const shellClass = [
    "shell",
    showFileManager && filesOpen ? "with-drawer" : "",
    showFileManager && filesOpen && filesExpanded ? "drawer-expanded" : "",
    sidebarCollapsed ? "sidebar-collapsed" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={shellClass}>
      <Sidebar
        session={session}
        chats={chats}
        repos={repos}
        home={session.home}
        view={view}
        activeId={activeId}
        target={target}
        error={error}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={toggleSidebar}
        onNew={choose}
        onOpen={openChat}
        onSettings={() => {
          choseRef.current = true;
          setView("settings");
        }}
        onAdmin={() => {
          choseRef.current = true;
          setView("admin");
        }}
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
            agentCatalog={session.agentCatalog}
            options={session.options}
            fileEditorAllowed={session.fileEditor}
            onTheme={applyTheme}
            onSaved={(theme, filesReadOnly) => onSession({ ...session, theme, filesReadOnly })}
          />
        )}
        {view === "admin" && session.admin && (
          <AdminView
            session={session}
            onAgents={(agents, rawTerminal, cliImport, fileManagerOffered, fileEditor, agentCatalog, fileDownloadOffered, fileUploadOffered) => onSession({
              ...session,
              agents,
              rawTerminal,
              cliImport,
              fileManagerOffered,
              fileEditor: fileEditor ?? session.fileEditor,
              fileDownloadOffered: fileDownloadOffered ?? session.fileDownloadOffered,
              fileUploadOffered: fileUploadOffered ?? session.fileUploadOffered,
              agentCatalog: agentCatalog ?? session.agentCatalog,
            })}
            onBranding={(appName) => onSession({ ...session, appName })}
            onAccess={() => {
              me().then(onSession).catch(() => undefined);
              refresh().catch(() => undefined);
            }}
          />
        )}
        {checkingChat && view === "start" && (
          <div className="start">
            <p className="muted">Loading…</p>
          </div>
        )}
        {!checkingChat && view === "start" && selectedRepo && (
          <StartView
            agents={session.agents}
            agentCatalog={session.agentCatalog}
            options={session.options}
            workspace={target}
            targetLabel={selectedRepo.name}
            filesOpen={filesEnabled ? filesOpen : undefined}
            onToggleFiles={filesEnabled ? toggleFiles : undefined}
            username={session.username}
            onStarted={(chat, prompt) => {
              choseRef.current = true;
              remember(chat);
              openingRef.current = { id: chat.id, prompt };
              consumedRef.current = null;
              writeLastChat(session.username, chat.id);
              setActiveId(chat.id);
              setView("chat");
            }}
          />
        )}
        {!checkingChat && view === "start" && !selectedRepo && (
          <div className="start">
            <p className="lede">Use the plus next to a repository to start a chat.</p>
          </div>
        )}
        {view === "chat" && activeId && (
          <ChatView
            key={activeId}
            chatId={activeId}
            home={session.home}
            agentCatalog={session.agentCatalog}
            repos={repos}
            rawTerminal={session.rawTerminal}
            claimOpening={claimOpening}
            onTitle={onTitle}
            filesOpen={filesEnabled && selectedRepo ? filesOpen : undefined}
            onToggleFiles={filesEnabled && selectedRepo ? toggleFiles : undefined}
            onWorkspace={onChatWorkspace}
            onFilesChanged={bumpFilesRefresh}
            username={session.username}
          />
        )}
      </section>
      {showFileManager && selectedRepo && (
        <FileManagerDrawer
          workspace={selectedRepo.path}
          repoName={selectedRepo.name}
          open={filesOpen}
          expanded={filesExpanded}
          canEdit={canEditFiles}
          canDownload={canDownloadFiles}
          canUpload={canUploadFiles}
          refreshKey={filesRefreshKey}
          onToggleExpanded={toggleFilesExpanded}
          onClose={toggleFiles}
        />
      )}
    </div>
  );
}
