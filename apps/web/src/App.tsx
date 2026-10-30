import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { isThemeId, type ChatMeta, type PromptAttachment, type RepositoryEntry } from "@engineroom/protocol";
import { createRepository, deleteRepository, listChats, listRepositories, login, logout, me, setRepositoryArchived, type Session } from "./api.ts";
import { ChatView } from "./chat/ChatView.tsx";
import { HomeView } from "./chat/HomeView.tsx";
import { forgetLastChat, pickLastChat, readLastChat, writeLastChat } from "./chat/lastChat.ts";
import { clearProjectDownload, saveProjectDownload, useProjectDownload } from "./chat/projectDownload.ts";
import { StartView } from "./chat/StartView.tsx";
import { FileManagerDrawer } from "./files/FileManagerDrawer.tsx";
import { ErrorProvider, useErrors, useReportError } from "./errors.tsx";
import { strip } from "./format.ts";
import { useFullscreen } from "./fullscreen.ts";
import { IconFullscreen, IconPanelLeft } from "./icons.tsx";
import { AdminView } from "./settings/AdminView.tsx";
import { DocsView } from "./settings/DocsView.tsx";
import { ErrorsView } from "./settings/ErrorsView.tsx";
import { SettingsView } from "./settings/SettingsView.tsx";
import { Sidebar } from "./sidebar/Sidebar.tsx";
import { onAgent, startAgentSocket, stopAgentSocket } from "./socket.ts";
import { applyTheme, rememberTheme } from "./theme.ts";

function applyWrap(wrapText: boolean) {
  if (wrapText) document.documentElement.dataset.wrap = "1";
  else delete document.documentElement.dataset.wrap;
}

function useNarrow() {
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 800px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 800px)");
    const apply = () => setNarrow(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);
  return narrow;
}

type View = "chat" | "settings" | "start" | "admin" | "docs" | "errors";

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    me().then(setSession).catch(() => setSession(null)).finally(() => setReady(true));
  }, []);

  useEffect(() => {
    if (session && isThemeId(session.theme)) rememberTheme(session.theme);
  }, [session?.theme]);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const apply = () => {
      document.documentElement.style.setProperty("--vvh", `${viewport.height}px`);
      document.documentElement.style.setProperty("--vvtop", `${viewport.offsetTop}px`);
    };
    apply();
    viewport.addEventListener("resize", apply);
    viewport.addEventListener("scroll", apply);
    return () => {
      viewport.removeEventListener("resize", apply);
      viewport.removeEventListener("scroll", apply);
      document.documentElement.style.removeProperty("--vvh");
      document.documentElement.style.removeProperty("--vvtop");
    };
  }, []);

  if (!ready) return <main className="login-screen"><p className="muted">Loading…</p></main>;
  if (!session) return <Login onSuccess={setSession} />;
  return (
    <ErrorProvider>
      <Shell session={session} onLogout={() => setSession(null)} onSession={setSession} />
    </ErrorProvider>
  );
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
  const report = useReportError();
  const { errors } = useErrors();
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
  const narrow = useNarrow();
  const fullscreen = useFullscreen();
  const [identityRevision, setIdentityRevision] = useState(0);
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    if (!navOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setNavOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);
  const [filesRefreshKey, setFilesRefreshKey] = useState(0);
  const [fileOpenRequest, setFileOpenRequest] = useState<{ id: number; path: string } | null>(null);
  const openingRef = useRef<{ id: string; prompt: string; attachments: PromptAttachment[] } | null>(null);
  const consumedRef = useRef<string | null>(null);
  const restoredRef = useRef(false);
  const choseRef = useRef(false);
  const deliveredDownload = useRef<string | null>(null);
  const reportedDownload = useRef("");
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

  const openAgentFile = useCallback((filePath: string) => {
    setFilesOpen(true);
    try {
      localStorage.setItem("engineroom.filesOpen", "1");
    } catch {
      /* ignore storage failure */
    }
    setFileOpenRequest((current) => ({ id: (current?.id ?? 0) + 1, path: filePath }));
  }, []);

  const refreshRepos = useCallback(() => {
    listRepositories().then(setRepos).catch(() => undefined);
  }, []);

  const claimOpening = useCallback((id: string): { prompt: string; attachments: PromptAttachment[] } | null => {
    const pending = openingRef.current;
    if (!pending || pending.id !== id || consumedRef.current === id) return null;
    consumedRef.current = id;
    return { prompt: pending.prompt, attachments: pending.attachments };
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
    return () => stopAgentSocket();
  }, [session.username]);

  useEffect(() => {
    refresh().catch((err) => {
      setCheckingChat(false);
      report("Conversations", err);
    });
    return onAgent((incoming) => {
      if (incoming.type === "chats_changed") refresh().catch(() => undefined);
    });
  }, [refresh, report]);

  useEffect(() => {
    if (view === "settings") return;
    if (isThemeId(session.theme)) applyTheme(session.theme);
    applyWrap(Boolean(session.wrapText));
  }, [view, session.theme, session.wrapText]);

  useEffect(() => {
    if (strip(target) === strip(session.home)) return;
    if (repos.some((repo) => strip(repo.path) === strip(target))) return;
    setTarget(session.home);
  }, [repos, session.home, target]);

  const selectedRepo = repos.find((repo) => strip(repo.path) === strip(target));
  const downloadJob = useProjectDownload();
  const onDownloadPage = Boolean(
    downloadJob && view === "start" && selectedRepo && strip(downloadJob.workspace) === strip(selectedRepo.path),
  );
  useEffect(() => {
    if (!downloadJob || downloadJob.phase !== "ready" || !onDownloadPage || !downloadJob.id) return;
    if (deliveredDownload.current === downloadJob.id) return;
    deliveredDownload.current = downloadJob.id;
    saveProjectDownload(downloadJob.id, downloadJob.filename);
    clearProjectDownload();
  }, [downloadJob, onDownloadPage]);
  useEffect(() => {
    if (!downloadJob) return;
    if (downloadJob.phase === "creating") {
      reportedDownload.current = "";
      return;
    }
    if (downloadJob.phase !== "failed") return;
    const key = `${downloadJob.workspace}\n${downloadJob.id}\n${downloadJob.error ?? ""}`;
    if (reportedDownload.current === key) return;
    reportedDownload.current = key;
    report("Download project", downloadJob.error || "The project zip could not be created.");
    clearProjectDownload();
  }, [downloadJob, report]);
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
    setNavOpen(false);
    setTarget(path);
    setActiveId(null);
    setView("start");
  }

  function openChat(chat: ChatMeta) {
    choseRef.current = true;
    setNavOpen(false);
    showChat(chat, reposRef.current);
  }

  function openView(next: View) {
    choseRef.current = true;
    setNavOpen(false);
    setView(next);
  }

  function leaveMissingChat() {
    forgetLastChat(usernameRef.current);
    setActiveId(null);
    setTarget(homeRef.current);
    setView("start");
    setCheckingChat(false);
  }

  async function archiveProject() {
    if (!selectedRepo) return;
    await setRepositoryArchived(selectedRepo.path, !selectedRepo.archived);
    await refresh();
  }

  async function removeProject(name: string) {
    await deleteRepository(target, name);
    const [nextChats, nextRepos] = await Promise.all([listChats(), listRepositories()]);
    setChats(nextChats);
    setRepos(nextRepos);
    choseRef.current = true;
    forgetLastChat(session.username);
    setActiveId(null);
    setTarget(session.home);
    setView("start");
  }

  async function createProject(name: string, url: string) {
    try {
      const repo = await createRepository(name, url);
      const [nextChats, nextRepos] = await Promise.all([listChats(), listRepositories()]);
      setChats(nextChats);
      setRepos(nextRepos);
      choose(repo.path);
    } catch (err) {
      report("Create project", err);
      throw err;
    }
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
    showFileManager && filesOpen && filesExpanded && !narrow ? "drawer-expanded" : "",
    sidebarCollapsed && !narrow ? "sidebar-collapsed" : "",
    narrow && navOpen ? "nav-open" : "",
  ].filter(Boolean).join(" ");
  const activeChat = chats.find((chat) => chat.id === activeId);
  const mobileTitle = view === "settings" ? "Customize"
    : view === "docs" ? "Docs"
    : view === "errors" ? "Errors"
    : view === "admin" ? "Admin"
    : view === "chat" ? (activeChat?.title || "Chat")
    : selectedRepo ? selectedRepo.name
    : "Home";

  return (
    <div className={shellClass}>
      {narrow && navOpen && (
        <button className="nav-scrim" type="button" aria-label="Close menu" onClick={() => setNavOpen(false)} />
      )}
      <Sidebar
        session={session}
        chats={chats}
        repos={repos}
        home={session.home}
        view={view}
        activeId={activeId}
        target={target}
        errorCount={errors.length}
        collapsed={narrow ? false : sidebarCollapsed}
        inert={narrow && !navOpen}
        onToggleCollapsed={narrow ? () => setNavOpen(false) : toggleSidebar}
        onNew={choose}
        onOpen={openChat}
        onSettings={() => openView("settings")}
        onDocs={() => openView("docs")}
        onErrors={() => openView("errors")}
        onAdmin={() => openView("admin")}
        identityRevision={identityRevision}
        onLogout={() => {
          stopAgentSocket();
          clearProjectDownload();
          logout().finally(onLogout);
        }}
        onCreateProject={createProject}
        fullscreen={fullscreen}
        onImported={(chat) => {
          remember(chat);
          openChat(chat);
        }}
      />
      <section className="main">
        <header className="mobile-bar">
          <button
            className="mobile-menu"
            type="button"
            aria-label="Open menu"
            aria-expanded={navOpen}
            aria-controls="sidebar-region"
            onClick={() => setNavOpen(true)}
          >
            <IconPanelLeft />
          </button>
          <strong className="mobile-title">{mobileTitle}</strong>
          {fullscreen.enabled && (
            <button
              className="mobile-fullscreen"
              type="button"
              aria-pressed={fullscreen.active}
              aria-label={fullscreen.active ? "Exit full screen" : "Full screen"}
              onClick={fullscreen.toggle}
            >
              <IconFullscreen active={fullscreen.active} />
            </button>
          )}
          {showFileManager && (
            <button className="mobile-files" type="button" aria-label="Files" onClick={toggleFiles}>
              Files
            </button>
          )}
        </header>
        {view === "settings" && (
          <SettingsView
            agents={session.agents}
            agentCatalog={session.agentCatalog}
            options={session.options}
            fileEditorAllowed={session.fileEditor}
            piSetup={session.piSetup}
            themes={session.themes}
            onPackagesChanged={() => {
              me().then(onSession).catch(() => undefined);
            }}
            onTheme={applyTheme}
            onWrap={applyWrap}
            onSaved={(theme, filesReadOnly, visibleChats, commandBlockStyle, wrapText) => onSession({ ...session, theme, filesReadOnly, visibleChats, commandBlockStyle, wrapText })}
            onSession={onSession}
          />
        )}
        {view === "docs" && <DocsView />}
        {view === "errors" && <ErrorsView />}
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
            onIdentity={() => setIdentityRevision((current) => current + 1)}
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
            piSetup={session.piSetup}
            onSession={onSession}
            projectCreate={Boolean(session.projectCreate)}
            projectDownloads={Boolean(session.projectDownloads)}
            archived={Boolean(selectedRepo.archived)}
            onArchive={archiveProject}
            onDelete={removeProject}
            onReposChanged={refreshRepos}
            onBranchChanged={bumpFilesRefresh}
            onStarted={(chat, prompt, attachments) => {
              choseRef.current = true;
              setNavOpen(false);
              remember(chat);
              openingRef.current = { id: chat.id, prompt, attachments };
              consumedRef.current = null;
              writeLastChat(session.username, chat.id);
              setActiveId(chat.id);
              setView("chat");
            }}
          />
        )}
        {!checkingChat && view === "start" && !selectedRepo && (
          <HomeView
            repos={repos}
            chats={chats}
            home={session.home}
            projectCreate={Boolean(session.projectCreate)}
            onPickProject={choose}
            onOpen={openChat}
            onCreateProject={createProject}
          />
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
            onUnavailable={leaveMissingChat}
            username={session.username}
            commandBlockStyle={session.commandBlockStyle}
            projectCreate={Boolean(session.projectCreate)}
            onReposChanged={refreshRepos}
            onOpenFile={showFileManager ? openAgentFile : undefined}
          />
        )}
      </section>
      {showFileManager && selectedRepo && (
        <FileManagerDrawer
          workspace={selectedRepo.path}
          repoName={selectedRepo.name}
          open={filesOpen}
          expanded={narrow ? false : filesExpanded}
          canEdit={canEditFiles}
          canDownload={canDownloadFiles}
          canUpload={canUploadFiles}
          refreshKey={filesRefreshKey}
          openRequest={fileOpenRequest}
          narrow={narrow}
          onToggleExpanded={narrow ? undefined : toggleFilesExpanded}
          onClose={() => {
            setNavOpen(false);
            toggleFiles();
          }}
        />
      )}
      {downloadJob?.phase === "ready" && !onDownloadPage && (
        <div className="download-popup" role="dialog" aria-labelledby="download-popup-title">
          <p id="download-popup-title">The project download is ready.</p>
          <div className="actions">
            <button className="ghost" type="button" onClick={clearProjectDownload}>Dismiss</button>
            <button className="primary" type="button" onClick={() => {
              saveProjectDownload(downloadJob.id, downloadJob.filename);
              clearProjectDownload();
            }}>Download</button>
          </div>
        </div>
      )}
    </div>
  );
}
