import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  AGENTS,
  agentLabel,
  DEFAULT_FILE_VISIBILITY,
  displayModelName,
  isCommandBlockStyle,
  isTheme,
  type AgentId,
  type AgentName,
  type AgentOptionChoice,
  type CatalogEntry,
  type ChatDetail,
  type ChatMeta,
  type CommandBlockStyle,
  type EnvEntry,
  type ExtensionTheme,
  type FileVisibility,
  type GitIdentity,
  type Settings,
  type UserPolicy,
} from "@engineroom/protocol";
import { PackagesSection } from "./PackagesSection.tsx";
import { ServerConfig } from "./ServerConfig.tsx";
import { commandLines, CursorCommandFields } from "./CursorCommands.tsx";
import {
  addAccount,
  addCatalog,
  applyAgentDefaults,
  changePassword,
  createCustomAgent,
  deleteCustomAgent,
  getAgentOptions,
  getRepoDirectory,
  getUserAccess,
  getUserChat,
  getUserCursorCommands,
  getUserGitIdentity,
  listAccounts,
  listAdminAgents,
  listCatalog,
  listUserChats,
  probeAgentOptions,
  removeAccount,
  removeCatalog,
  saveAgentOptions,
  saveAgents,
  saveBranding,
  saveUserCursorCommands,
  saveUserEnv,
  saveUserGitIdentity,
  saveUserGrants,
  saveUserPolicy,
  saveUserSettings,
  saveRepoDirectory,
  serverOverview,
  type Account,
  type AgentOptionsState,
  type HarnessApplyResult,
  type ServerOverview,
  type AdminAgent,
  type Session,
} from "../api.ts";
import { groupTranscript } from "../chat/group.ts";
import { ToolBlock } from "../chat/ToolBlock.tsx";
import { CopyResponse } from "../chat/CopyResponse.tsx";
import { Markdown } from "../chat/Markdown.tsx";
import { useReportError } from "../errors.tsx";
import { message, relativeTime } from "../format.ts";
import { normalizeTheme, THEME_CATALOG } from "../theme.ts";

type AdminTab = "overview" | "server" | "agents" | "packages" | "repositories" | "users";

type FolderBaseline = {
  directory: string;
  projectCreate: boolean;
  projectDownloads: boolean;
  visibility: FileVisibility;
};

type OfferSnapshot = {
  flags: Record<string, boolean>;
  rawTerminal: boolean;
  cliImport: boolean;
  fileManager: boolean;
  fileEditor: boolean;
  fileDownload: boolean;
  fileUpload: boolean;
  piProvider: string;
  piModel: string;
  cursorCommands: string[];
  cursorFast: boolean;
  offered: Partial<Record<string, { modes: string[]; models: string[] }>>;
};

const TABS: { id: AdminTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "server", label: "Server" },
  { id: "agents", label: "Agents" },
  { id: "packages", label: "Packages" },
  { id: "repositories", label: "Repositories" },
  { id: "users", label: "Users" },
];

export function AdminView({
  session,
  onAgents,
  onBranding,
  onAccess,
  onIdentity,
}: {
  session: Session;
  onAgents: (
    agents: AgentId[],
    rawTerminal: boolean,
    cliImport: boolean,
    fileManagerOffered: boolean,
    fileEditor?: boolean,
    agentCatalog?: { id: string; label: string }[],
    fileDownloadOffered?: boolean,
    fileUploadOffered?: boolean,
  ) => void;
  onBranding: (appName: string) => void;
  onAccess: () => void;
  onIdentity: () => void;
}) {
  const [flags, setFlags] = useState<Record<string, boolean>>(() => agentFlags(session.agents));
  const [savedOffer, setSavedOffer] = useState<OfferSnapshot>(() => sessionOffer(session));
  const [inventory, setInventory] = useState<AdminAgent[]>([]);
  const [agentTab, setAgentTab] = useState("+");
  const [customLabel, setCustomLabel] = useState("");
  const [customCommand, setCustomCommand] = useState("");
  const [rawTerminal, setRawTerminal] = useState(session.rawTerminal);
  const [cliImport, setCliImport] = useState(session.cliImport);
  const [fileManager, setFileManager] = useState(session.fileManagerOffered ?? false);
  const [fileEditor, setFileEditor] = useState(session.fileEditor ?? true);
  const [fileDownload, setFileDownload] = useState(session.fileDownloadOffered ?? false);
  const [fileUpload, setFileUpload] = useState(session.fileUploadOffered ?? false);
  const [piProvider, setPiProvider] = useState("");
  const [piModel, setPiModel] = useState("");
  const [cursorCommandText, setCursorCommandText] = useState("");
  const [cursorFast, setCursorFast] = useState(false);
  const [applyUser, setApplyUser] = useState("");
  const [appName, setAppName] = useState(session.appName || "AgentWrapper");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [selected, setSelected] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [repoName, setRepoName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [repoFolder, setRepoFolder] = useState("Sites");
  const [projectCreate, setProjectCreate] = useState(session.projectCreate);
  const [projectDownloads, setProjectDownloads] = useState(Boolean(session.projectDownloads));
  const [fileVisibility, setFileVisibility] = useState<FileVisibility>(() => ({
    ...(session.fileVisibility ?? DEFAULT_FILE_VISIBILITY),
  }));
  const [folderBaseline, setFolderBaseline] = useState<FolderBaseline>(() => ({
    directory: "Sites",
    projectCreate: session.projectCreate,
    projectDownloads: Boolean(session.projectDownloads),
    visibility: { ...(session.fileVisibility ?? DEFAULT_FILE_VISIBILITY) },
  }));
  const [saved, setSaved] = useState("");
  const report = useReportError();
  function setError(value: string) {
    if (value) report("Admin", value);
  }
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<AdminTab>("overview");
  const [agentOptions, setAgentOptions] = useState<AgentOptionsState>({});
  const [offeredDraft, setOfferedDraft] = useState<Partial<Record<AgentId, { modes: string[]; models: string[] }>>>({});

  function openTab(next: AdminTab) {
    setTab(next);
    setError("");
    setSaved("");
  }

  function onTabKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const index = TABS.findIndex((item) => item.id === tab);
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = TABS[(index + step + TABS.length) % TABS.length]?.id;
    if (!next) return;
    openTab(next);
    document.getElementById(`admin-tab-${next}`)?.focus();
  }

  async function refreshUsers() {
    const next = await listAccounts();
    setAccounts(next);
    setApplyUser((current) => next.some((account) => account.username === current) ? current : "");
    return next;
  }

  async function reloadUsers() {
    setBusy(true);
    setError("");
    setSaved("");
    try {
      await refreshUsers();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    refreshUsers().catch((err) => setError(message(err)));
    listCatalog().then((body) => setCatalog(body.repositories)).catch((err) => setError(message(err)));
    getRepoDirectory().then((body) => {
      setRepoFolder(body.directory);
      if (body.visibility) setFileVisibility(body.visibility);
      if (typeof body.projectCreate === "boolean") setProjectCreate(body.projectCreate);
      if (typeof body.projectDownloads === "boolean") setProjectDownloads(body.projectDownloads);
      setFolderBaseline((current) => ({
        directory: body.directory,
        projectCreate: typeof body.projectCreate === "boolean" ? body.projectCreate : current.projectCreate,
        projectDownloads: typeof body.projectDownloads === "boolean" ? body.projectDownloads : current.projectDownloads,
        visibility: body.visibility ? { ...body.visibility } : { ...current.visibility },
      }));
    }).catch((err) => setError(message(err)));
    listAdminAgents().then((body) => {
      setInventory(body.agents);
      const nextFlags = Object.fromEntries(body.agents.map((agent) => [agent.id, agent.enabled]));
      setFlags(nextFlags);
      setRawTerminal(body.rawTerminal);
      setCliImport(body.cliImport);
      setFileManager(body.fileManager);
      setFileEditor(body.fileEditor ?? true);
      setFileDownload(body.fileDownload ?? false);
      setFileUpload(body.fileUpload ?? false);
      setPiProvider(body.piProvider ?? "");
      setPiModel(body.piModel ?? "");
      setCursorCommandText((body.cursorCommands ?? []).join("\n"));
      setCursorFast(body.cursorFast === true);
      setSavedOffer((current) => ({
        ...current,
        flags: nextFlags,
        rawTerminal: body.rawTerminal,
        cliImport: body.cliImport,
        fileManager: body.fileManager,
        fileEditor: body.fileEditor ?? true,
        fileDownload: body.fileDownload ?? false,
        fileUpload: body.fileUpload ?? false,
        piProvider: body.piProvider ?? "",
        piModel: body.piModel ?? "",
        cursorCommands: [...(body.cursorCommands ?? [])],
        cursorFast: body.cursorFast === true,
      }));
      const first = body.agents[0];
      setAgentTab(first?.id ?? "+");
    }).catch((err) => setError(message(err)));
    getAgentOptions().then((options) => {
      setAgentOptions(options);
      const draft: Partial<Record<AgentId, { modes: string[]; models: string[] }>> = {};
      for (const agent of Object.keys(options) as AgentId[]) {
        if (options[agent]) draft[agent] = options[agent].offered;
      }
      setOfferedDraft(draft);
      setSavedOffer((current) => ({ ...current, offered: cloneOffered(draft) }));
    }).catch((err) => setError(message(err)));
  }, []);

  function toggle(agent: string) {
    const next = { ...flags, [agent]: !flags[agent] };
    if (!Object.values(next).some(Boolean)) {
      setError("At least one agent must stay on");
      return;
    }
    setError("");
    setFlags(next);
  }

  function applyInventory(body: { agents: AdminAgent[]; rawTerminal: boolean; cliImport: boolean; fileManager?: boolean; fileEditor?: boolean; fileDownload?: boolean; fileUpload?: boolean }, select?: string) {
    setInventory(body.agents);
    const nextFlags = Object.fromEntries(body.agents.map((agent) => [agent.id, agent.enabled]));
    setFlags(nextFlags);
    setRawTerminal(body.rawTerminal);
    setCliImport(body.cliImport);
    if (typeof body.fileManager === "boolean") setFileManager(body.fileManager);
    if (typeof body.fileEditor === "boolean") setFileEditor(body.fileEditor);
    if (typeof body.fileDownload === "boolean") setFileDownload(body.fileDownload);
    if (typeof body.fileUpload === "boolean") setFileUpload(body.fileUpload);
    setSavedOffer((current) => ({
      ...current,
      flags: nextFlags,
      rawTerminal: body.rawTerminal,
      cliImport: body.cliImport,
      fileManager: typeof body.fileManager === "boolean" ? body.fileManager : current.fileManager,
      fileEditor: typeof body.fileEditor === "boolean" ? body.fileEditor : current.fileEditor,
      fileDownload: typeof body.fileDownload === "boolean" ? body.fileDownload : current.fileDownload,
      fileUpload: typeof body.fileUpload === "boolean" ? body.fileUpload : current.fileUpload,
    }));
    if (select) setAgentTab(select);
  }

  async function saveName(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setSaved("");
    setError("");
    try {
      const savedName = await saveBranding(appName);
      setAppName(savedName.appName);
      onBranding(savedName.appName);
      setSaved("Application name saved");
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveAgentList(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setSaved("");
    setError("");
    try {
      const commands = commandLines(cursorCommandText);
      const savedAgents = await saveAgents(flags, rawTerminal, cliImport, fileManager, fileEditor, fileDownload, fileUpload, {
        piProvider: piProvider.trim(),
        piModel: piModel.trim(),
        cursorCommands: commands,
        cursorFast,
      });
      onAgents(
        savedAgents.agents,
        savedAgents.rawTerminal ?? rawTerminal,
        savedAgents.cliImport ?? cliImport,
        savedAgents.fileManager ?? fileManager,
        savedAgents.fileEditor ?? fileEditor,
        savedAgents.agentCatalog,
        savedAgents.fileDownload ?? fileDownload,
        savedAgents.fileUpload ?? fileUpload,
      );
      const provider = piProvider.trim();
      const model = piModel.trim();
      let offered = offeredDraft;
      if (Object.keys(offeredDraft).length > 0) {
        const savedOptions = await saveAgentOptions(offeredDraft);
        setAgentOptions(savedOptions);
        offered = {};
        for (const agent of Object.keys(savedOptions) as AgentId[]) {
          const record = savedOptions[agent];
          if (record) offered[agent] = { modes: [...record.offered.modes], models: [...record.offered.models] };
        }
        setOfferedDraft(offered);
      }
      setPiProvider(provider);
      setPiModel(model);
      setCursorCommandText(commands.join("\n"));
      setCursorFast(savedAgents.cursorFast === true);
      const listed = await listAdminAgents();
      setInventory(listed.agents);
      setSavedOffer({
        flags,
        rawTerminal: savedAgents.rawTerminal ?? rawTerminal,
        cliImport: savedAgents.cliImport ?? cliImport,
        fileManager: savedAgents.fileManager ?? fileManager,
        fileEditor: savedAgents.fileEditor ?? fileEditor,
        fileDownload: savedAgents.fileDownload ?? fileDownload,
        fileUpload: savedAgents.fileUpload ?? fileUpload,
        piProvider: savedAgents.piProvider ?? provider,
        piModel: savedAgents.piModel ?? model,
        cursorCommands: [...(savedAgents.cursorCommands ?? commands)],
        cursorFast: savedAgents.cursorFast === true,
        offered: cloneOffered(offered),
      });
      onAccess();
      setSaved("Agents saved");
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  function discardOffer() {
    setFlags(savedOffer.flags);
    setRawTerminal(savedOffer.rawTerminal);
    setCliImport(savedOffer.cliImport);
    setFileManager(savedOffer.fileManager);
    setFileEditor(savedOffer.fileEditor);
    setFileDownload(savedOffer.fileDownload);
    setFileUpload(savedOffer.fileUpload);
    setPiProvider(savedOffer.piProvider);
    setPiModel(savedOffer.piModel);
    setCursorCommandText(savedOffer.cursorCommands.join("\n"));
    setCursorFast(savedOffer.cursorFast);
    setOfferedDraft(cloneOffered(savedOffer.offered));
    setError("");
  }

  function clearOfferedModels(agent: AgentId, ids: string[]) {
    const drop = new Set(ids);
    setOfferedDraft((current) => {
      const list = current[agent] ?? { modes: [], models: [] };
      return { ...current, [agent]: { ...list, models: list.models.filter((item) => !drop.has(item)) } };
    });
  }

  const offerDirty = !offersEqual({
    flags,
    rawTerminal,
    cliImport,
    fileManager,
    fileEditor,
    fileDownload,
    fileUpload,
    piProvider,
    piModel,
    cursorCommands: commandLines(cursorCommandText),
    cursorFast,
    offered: offeredDraft,
  }, savedOffer);

  async function applyDefaults(agent: "pi" | "cursor", username?: string) {
    setBusy(true);
    setSaved("");
    setError("");
    try {
      setSaved(formatApply(agent, await applyAgentDefaults(agent, username || undefined)));
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  function toggleOffered(agent: AgentId, kind: "modes" | "models", id: string) {
    setOfferedDraft((current) => {
      const list = current[agent] ?? { modes: [], models: [] };
      const next = list[kind].includes(id) ? list[kind].filter((item) => item !== id) : [...list[kind], id];
      return { ...current, [agent]: { ...list, [kind]: next } };
    });
  }

  async function addAgent(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setSaved("");
    setError("");
    try {
      const saved = await createCustomAgent(customLabel.trim(), customCommand.trim());
      const created = saved.agents.find((agent) => !agent.builtin && agent.label === customLabel.trim() && agent.binary === customCommand.trim());
      applyInventory(saved, created?.id ?? "+");
      setCustomLabel("");
      setCustomCommand("");
      setSaved(created ? `${created.label} added. Offer it, then each person can use it after they install ${created.binary}.` : "Agent added");
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function dropAgent(id: string) {
    setBusy(true);
    setSaved("");
    setError("");
    try {
      const saved = await deleteCustomAgent(id);
      const next = saved.agents[0]?.id ?? "+";
      applyInventory(saved, agentTab === id ? next : agentTab);
      setSaved("Agent removed");
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  function onAgentTabKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    event.stopPropagation();
    const ids = [...inventory.map((agent) => agent.id), "+"];
    const index = Math.max(0, ids.indexOf(agentTab));
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = ids[(index + step + ids.length) % ids.length];
    if (next) setAgentTab(next);
  }

  async function loadOptions(agent: AgentId) {
    setBusy(true);
    setSaved("");
    setError("");
    try {
      const record = await probeAgentOptions(agent);
      setAgentOptions((current) => ({ ...current, [agent]: record }));
      const offered = { modes: [...record.offered.modes], models: [...record.offered.models] };
      setOfferedDraft((current) => ({ ...current, [agent]: offered }));
      setSavedOffer((current) => ({ ...current, offered: { ...current.offered, [agent]: { modes: [...offered.modes], models: [...offered.models] } } }));
      setSaved(`Loaded ${agentLabel(agent, inventory)} modes and models`);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveFolder(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const next = await saveRepoDirectory(repoFolder.trim(), fileVisibility, projectCreate, projectDownloads);
      const baseline: FolderBaseline = {
        directory: next.directory,
        projectCreate: next.projectCreate,
        projectDownloads: next.projectDownloads,
        visibility: { ...(next.visibility ?? fileVisibility) },
      };
      setRepoFolder(baseline.directory);
      setFileVisibility(baseline.visibility);
      setProjectCreate(baseline.projectCreate);
      setProjectDownloads(baseline.projectDownloads);
      setFolderBaseline(baseline);
      onAccess();
      setSaved("Repository folder saved");
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  function discardFolder() {
    setRepoFolder(folderBaseline.directory);
    setProjectCreate(folderBaseline.projectCreate);
    setProjectDownloads(folderBaseline.projectDownloads);
    setFileVisibility({ ...folderBaseline.visibility });
    setError("");
  }

  const folderDirty = repoFolder !== folderBaseline.directory
    || projectCreate !== folderBaseline.projectCreate
    || projectDownloads !== folderBaseline.projectDownloads
    || !visibilityEqual(fileVisibility, folderBaseline.visibility);

  async function addRepo(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const entry = await addCatalog(repoName.trim(), repoUrl.trim());
      setCatalog((current) => [...current, entry].sort((a, b) => a.name.localeCompare(b.name)));
      setRepoName("");
      setRepoUrl("");
      setSaved("Repository added");
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function dropRepo(id: string) {
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const next = await removeCatalog(id);
      setCatalog(next.repositories);
      setSaved("Repository removed from the catalog");
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
      const added = await addAccount(username.trim(), password);
      setUsername("");
      setPassword("");
      setSaved("Access granted");
      if (added.accounts) setAccounts(added.accounts);
      else await refreshUsers();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  const names = inventory.length > 0 ? inventory : session.agentCatalog;
  const offered = inventory.length > 0
    ? inventory.filter((agent) => agent.packageName ? agent.enabled : Boolean(flags[agent.id])).map((agent) => agent.label)
    : session.agents.map((agent) => agentLabel(agent, session.agentCatalog));
  const selectedAgent = inventory.find((agent) => agent.id === agentTab);

  return (
    <div className="settings admin-view">
      <header className="admin-mast">
        <div className="admin-tabs" role="tablist" aria-label="Admin" onKeyDown={onTabKey}>
          {TABS.map((item) => (
            <button
              className={tab === item.id ? "admin-tab active" : "admin-tab"}
              id={`admin-tab-${item.id}`}
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              aria-controls={`admin-panel-${item.id}`}
              tabIndex={tab === item.id ? 0 : -1}
              onClick={() => openTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {saved && <p className="admin-note" role="status">{saved}</p>}
      </header>
      <div className="admin-stage" role="tabpanel" id={`admin-panel-${tab}`} aria-labelledby={`admin-tab-${tab}`}>
        {tab === "overview" && (
          <div className="admin-overview">
            <form className="branding-form" onSubmit={(event) => void saveName(event)}>
              <label>
                Application name
                <input
                  value={appName}
                  maxLength={64}
                  onChange={(event) => setAppName(event.target.value)}
                  required
                />
              </label>
              <button className="primary" type="submit" disabled={busy}>Save</button>
            </form>
            <ServerPanel />
            <div className="overview-links">
              <button className="overview-link" type="button" onClick={() => openTab("agents")}>
                <span>Agents</span>
                <strong>{offered.length}</strong>
                <span className="muted">{offered.length ? offered.join(", ") : "None offered"}. {rawTerminal ? "Terminal on." : "Terminal off."} {fileManager ? "File manager on." : "File manager off."} {fileEditor ? "File editor on." : "File editor off."} {fileDownload ? "File download on." : "File download off."} {fileUpload ? "File upload on." : "File upload off."} {cliImport ? "CLI import on." : "CLI import off."}</span>
              </button>
              <button className="overview-link" type="button" onClick={() => openTab("packages")}>
                <span>Packages</span>
                <strong>Install</strong>
                <span className="muted">Themes, docs, and agents from outside this checkout.</span>
              </button>
              <button className="overview-link" type="button" onClick={() => openTab("repositories")}>
                <span>Repositories</span>
                <strong>{catalog.length}</strong>
                <span className="muted">{catalog.length === 0 ? "Nothing in the catalog yet." : "Ready to grant."}</span>
              </button>
              <button className="overview-link" type="button" onClick={() => openTab("users")}>
                <span>Users</span>
                <strong>{accounts.length}</strong>
                <span className="muted">{accounts.length === 0 ? "No accounts yet." : "Linux accounts on this machine."}</span>
              </button>
            </div>
          </div>
        )}

        {tab === "server" && (
          <div className="admin-pane">
            <ServerConfig />
          </div>
        )}

        {tab === "packages" && (
          <div className="admin-pane">
            <PackagesSection scope="site" />
          </div>
        )}

        {tab === "agents" && (
          <div className="agents-page">
            <form id="agent-offer" className="agents-stack" onSubmit={(event) => void saveAgentList(event)}>
              <section className="agents-card">
                <div className="agents-card-head">
                  <h2>Available agents</h2>
                  <p className="muted">Offer an agent here, then allow it for each person. They can use it only while that offer is on and the command is installed on their account.</p>
                </div>
                <div className="agents-privileges">
                  <span className="eyebrow">Global tooling</span>
                  <div className="privilege-grid">
                    <label className={rawTerminal ? "privilege on" : "privilege"}>
                      <input type="checkbox" checked={rawTerminal} onChange={() => setRawTerminal((value) => !value)} />
                      Raw terminal
                    </label>
                    <label className={cliImport ? "privilege on" : "privilege"}>
                      <input type="checkbox" checked={cliImport} onChange={() => setCliImport((value) => !value)} />
                      Import CLI sessions
                    </label>
                    <label className={fileManager ? "privilege on" : "privilege"}>
                      <input type="checkbox" checked={fileManager} onChange={() => setFileManager((value) => !value)} />
                      Repository file manager
                    </label>
                    <label className={fileEditor ? "privilege on" : "privilege"}>
                      <input type="checkbox" checked={fileEditor} onChange={() => setFileEditor((value) => !value)} />
                      File editor
                    </label>
                    <label className={fileDownload ? "privilege on" : "privilege"}>
                      <input type="checkbox" checked={fileDownload} onChange={() => setFileDownload((value) => !value)} />
                      File download
                    </label>
                    <label className={fileUpload ? "privilege on" : "privilege"}>
                      <input type="checkbox" checked={fileUpload} onChange={() => setFileUpload((value) => !value)} />
                      File upload
                    </label>
                  </div>
                </div>
              </section>
              <div className="agent-switcher">
                <div className="agent-tabs" role="tablist" aria-label="Agents" onKeyDown={onAgentTabKey}>
                  {inventory.map((agent) => (
                    <button
                      className={agentTab === agent.id ? "admin-tab active" : "admin-tab"}
                      id={`agent-tab-${agent.id}`}
                      key={agent.id}
                      type="button"
                      role="tab"
                      aria-selected={agentTab === agent.id}
                      tabIndex={agentTab === agent.id ? 0 : -1}
                      onClick={() => setAgentTab(agent.id)}
                    >
                      <span className="agent-tab-label">
                        <span className={agent.available ? "dot" : "dot dot-idle"} aria-hidden="true" />
                        {agent.label}
                      </span>
                    </button>
                  ))}
                  <button
                    className={agentTab === "+" ? "admin-tab agent-add active" : "admin-tab agent-add"}
                    id="agent-tab-add"
                    type="button"
                    role="tab"
                    aria-selected={agentTab === "+"}
                    tabIndex={agentTab === "+" ? 0 : -1}
                    onClick={() => setAgentTab("+")}
                  >
                    + Add agent
                  </button>
                </div>
                {selectedAgent && !selectedAgent.packageName && (
                  <label className="offer-switch">
                    <span>Offer {selectedAgent.label}</span>
                    <input type="checkbox" checked={Boolean(flags[selectedAgent.id])} onChange={() => toggle(selectedAgent.id)} />
                    <span className="switch-track" aria-hidden="true" />
                  </label>
                )}
                {selectedAgent?.packageName && (
                  <p className="muted">Offered while the {selectedAgent.packageName} package is enabled.</p>
                )}
              </div>
              {inventory.length === 0 && agentTab !== "+" && <p className="muted">No agents are configured.</p>}
              {selectedAgent && (
                <div className="agents-stack" role="tabpanel" aria-labelledby={`agent-tab-${selectedAgent.id}`}>
                  <section className="agents-card">
                    <h3>{selectedAgent.label}</h3>
                    <p className="muted">Each person uses the {selectedAgent.binary} command they install on their own account. Turning this offer off hides it, even when the command is already installed.</p>
                    {!selectedAgent.builtin && !selectedAgent.packageName && (
                      <button className="danger" type="button" disabled={busy} onClick={() => void dropAgent(selectedAgent.id)}>Remove {selectedAgent.label}</button>
                    )}
                    {selectedAgent.packageName && (
                      <p className="muted">This agent comes from the {selectedAgent.packageName} package. Remove that package to drop it.</p>
                    )}
                  </section>
                  {selectedAgent.id === "cursor" && (
                    <section className="agents-card">
                      <h3>Cursor defaults</h3>
                      <p className="muted">The default model is Grok 4.7 with a 256k context and high reasoning. Fast mode stays off unless an administrator enables it here. Apply writes that choice with the model only for a person who is allowed to use grok-4.7, and replaces that person's Shell entries. Apply to all users covers everyone who has Cursor. Apply to this user covers the account you pick.</p>
                      <label className={cursorFast ? "privilege on" : "privilege"}>
                        <input type="checkbox" checked={cursorFast} aria-label="Fast mode" onChange={() => setCursorFast((value) => !value)} />
                        Fast mode
                      </label>
                      <CursorCommandFields value={cursorCommandText} onChange={setCursorCommandText} />
                      <div className="row-actions">
                        <button className="ghost" type="button" disabled={busy || offerDirty} onClick={() => void applyDefaults("cursor")}>Apply to all users</button>
                        <select
                          className="apply-user"
                          aria-label="User to apply Cursor defaults"
                          value={applyUser}
                          onChange={(event) => setApplyUser(event.target.value)}
                        >
                          <option value="">Choose a user…</option>
                          {accounts.map((account) => <option key={account.username} value={account.username}>{account.username}</option>)}
                        </select>
                        <button className="ghost" type="button" disabled={busy || offerDirty || !applyUser} onClick={() => void applyDefaults("cursor", applyUser)}>Apply to this user</button>
                      </div>
                      {offerDirty && <p className="muted">Save before applying.</p>}
                    </section>
                  )}
                  {selectedAgent.id === "pi" && (
                    <section className="agents-card">
                      <h3>Pi setup</h3>
                      <p className="muted">The account page offers setup when Pi is enabled for that person and their pi command is missing. Setup installs Pi for that account only.</p>
                      <label>
                        Provider
                        <input aria-label="Pi provider" value={piProvider} onChange={(event) => setPiProvider(event.target.value)} placeholder="openrouter" />
                      </label>
                      <label>
                        Model
                        <input aria-label="Pi model" value={piModel} onChange={(event) => setPiModel(event.target.value)} placeholder="recursive/flint-v1.0:free" />
                      </label>
                      <p className="muted">Saving stores the provider and model. Apply writes defaultProvider and defaultModel into the Pi settings of a person who is allowed that model. Apply to all users covers every such person. Apply to this user covers the account you pick. Setup writes the same values when it installs Pi.</p>
                      <div className="row-actions">
                        <button className="ghost" type="button" disabled={busy || offerDirty} onClick={() => void applyDefaults("pi")}>Apply to all users</button>
                        <select
                          className="apply-user"
                          aria-label="User to apply Pi defaults"
                          value={applyUser}
                          onChange={(event) => setApplyUser(event.target.value)}
                        >
                          <option value="">Choose a user…</option>
                          {accounts.map((account) => <option key={account.username} value={account.username}>{account.username}</option>)}
                        </select>
                        <button className="ghost" type="button" disabled={busy || offerDirty || !applyUser} onClick={() => void applyDefaults("pi", applyUser)}>Apply to this user</button>
                      </div>
                      {offerDirty && <p className="muted">Save before applying.</p>}
                      <p className="muted">This list is the models this Pi login can call. Nothing is offered until you check it and save.</p>
                    </section>
                  )}
                  <AgentOptions
                    key={selectedAgent.id}
                    label={selectedAgent.label}
                    config={agentOptions[selectedAgent.id]}
                    draft={offeredDraft[selectedAgent.id] ?? { modes: [], models: [] }}
                    enabled={Boolean(savedOffer.flags[selectedAgent.id])}
                    onToggle={(kind, id) => toggleOffered(selectedAgent.id, kind, id)}
                    onClearModels={(ids) => clearOfferedModels(selectedAgent.id, ids)}
                  />
                </div>
              )}
            </form>
            {agentTab === "+" && (
              <form className="agents-card" onSubmit={(event) => void addAgent(event)}>
                <h3>Add an agent</h3>
                <p className="muted">Give it a display name and the command to launch with acp. Use a command name such as codex, or an absolute path. Built-in agents already have their own tabs.</p>
                <label>
                  Display name
                  <input value={customLabel} onChange={(event) => setCustomLabel(event.target.value)} placeholder="Codex" required />
                </label>
                <label>
                  Command
                  <input value={customCommand} onChange={(event) => setCustomCommand(event.target.value)} placeholder="codex" required />
                </label>
                <button className="primary" type="submit" disabled={busy}>Add agent</button>
              </form>
            )}
            <footer className="agents-bar">
              {offerDirty && <p>Unsaved changes. Nothing is offered until you save.</p>}
              <div className="row-actions">
                <button className="ghost" type="button" disabled={!offerDirty || busy} onClick={discardOffer}>Discard</button>
                {selectedAgent && savedOffer.flags[selectedAgent.id] && (
                  <button className="ghost" type="button" disabled={busy} onClick={() => void loadOptions(selectedAgent.id)}>
                    Load modes and models
                  </button>
                )}
                <button className="primary" type="submit" form="agent-offer" disabled={busy}>Save agents</button>
              </div>
            </footer>
          </div>
        )}

        {tab === "repositories" && (
          <div className="repos-page">
            <header className="repos-head">
              <div>
                <h2>Repository folder</h2>
                <p className="muted">Users can start a chat in any git repository inside this folder of their home, including ones they add themselves. The folder is scanned when they sign in. The default is Sites.</p>
              </div>
              <span className="repos-scan">Scanned on sign-in</span>
            </header>
            <form id="repo-folder" className="repos-stack" onSubmit={(event) => void saveFolder(event)}>
              <section className="agents-card">
                <div className="repos-card-head">
                  <label htmlFor="repo-folder-input">Folder</label>
                  <p className="muted" id="repo-folder-help">Home-relative path. The default is Sites.</p>
                </div>
                <div className="repos-path">
                  <span className="repos-path-prefix" aria-hidden="true">~/</span>
                  <input
                    id="repo-folder-input"
                    value={repoFolder}
                    onChange={(event) => setRepoFolder(event.target.value)}
                    placeholder="Sites"
                    aria-describedby="repo-folder-help"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    required
                  />
                </div>
              </section>
              <section className="repos-access" aria-labelledby="repo-access-heading">
                <h3 id="repo-access-heading">Access</h3>
                <div className="repos-toggles">
                  <div className={projectCreate ? "repos-toggle on" : "repos-toggle"}>
                    <div className="repos-toggle-copy">
                      <div className="repos-toggle-title">
                        <h3>Allow users to create projects</h3>
                        <span className="repos-state">{projectCreate ? "On" : "Off"}</span>
                      </div>
                      <p className="muted">When this is on, a person can add a folder here by cloning a Git URL or starting an empty repository, unless their own access turns it off. The same switch lets them set a remote, create and switch branches, and pull or push.</p>
                    </div>
                    <label className="offer-switch">
                      <input
                        type="checkbox"
                        checked={projectCreate}
                        aria-label="Allow users to create projects"
                        onChange={() => setProjectCreate((value) => !value)}
                      />
                      <span className="switch-track" aria-hidden="true" />
                    </label>
                  </div>
                  <div className={projectDownloads ? "repos-toggle on" : "repos-toggle"}>
                    <div className="repos-toggle-copy">
                      <div className="repos-toggle-title">
                        <h3>Allow project downloads</h3>
                        <span className="repos-state">{projectDownloads ? "On" : "Off"}</span>
                      </div>
                      <p className="muted">When this is on, a person can download a project as a zip from the new chat page.</p>
                    </div>
                    <label className="offer-switch">
                      <input
                        type="checkbox"
                        checked={projectDownloads}
                        aria-label="Allow project downloads"
                        onChange={() => setProjectDownloads((value) => !value)}
                      />
                      <span className="switch-track" aria-hidden="true" />
                    </label>
                  </div>
                </div>
              </section>
              <section className="agents-card" aria-labelledby="repo-visibility-heading">
                <div className="repos-card-head">
                  <h3 id="repo-visibility-heading">File manager visibility</h3>
                  <p className="muted">Choose which repository files are visible in the right-hand file manager. Hidden dotfiles, gitignored files, and .git/ are hidden by default.</p>
                </div>
                <div className="repos-visibility">
                  <label className={fileVisibility.showHidden ? "choice-card on" : "choice-card"}>
                    <input
                      type="checkbox"
                      checked={fileVisibility.showHidden}
                      onChange={() => setFileVisibility((current) => ({ ...current, showHidden: !current.showHidden }))}
                    />
                    <span className="choice-copy">
                      <strong>Show hidden files</strong>
                      <span className="choice-sub">Dotfiles, including names that start with a dot.</span>
                    </span>
                  </label>
                  <label className={fileVisibility.showGitignored ? "choice-card on" : "choice-card"}>
                    <input
                      type="checkbox"
                      checked={fileVisibility.showGitignored}
                      onChange={() => setFileVisibility((current) => ({ ...current, showGitignored: !current.showGitignored }))}
                    />
                    <span className="choice-copy">
                      <strong>Show gitignored files</strong>
                      <span className="choice-sub">Files matched by .gitignore.</span>
                    </span>
                  </label>
                  <label className={fileVisibility.showGitDir ? "choice-card on" : "choice-card"}>
                    <input
                      type="checkbox"
                      checked={fileVisibility.showGitDir}
                      onChange={() => setFileVisibility((current) => ({ ...current, showGitDir: !current.showGitDir }))}
                    />
                    <span className="choice-copy">
                      <span className="repos-choice-title">
                        <strong>Show .git directory</strong>
                        <span className="repos-caution">Caution</span>
                      </span>
                      <span className="choice-sub">Shows the Git database, hooks, and logs.</span>
                    </span>
                  </label>
                </div>
              </section>
            </form>
            <section className="agents-card" aria-labelledby="repo-catalog-heading">
              <div className="agents-section-head">
                <h3 id="repo-catalog-heading">
                  Repository catalog
                  <span className="agents-count">{catalog.length}</span>
                </h3>
                <p className="muted">These remotes are what a person can install. Granting one clones it into their repository folder. A checkout that is already there stays available for chats.</p>
              </div>
              {catalog.length === 0 ? (
                <p className="muted">No repositories in the catalog yet.</p>
              ) : (
                <div className="repos-table-wrap">
                  <table className="repos-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Git URL</th>
                        <th>Remove</th>
                      </tr>
                    </thead>
                    <tbody>
                      {catalog.map((entry) => (
                        <tr key={entry.id}>
                          <td>{entry.name}</td>
                          <td>{entry.url}</td>
                          <td>
                            <button className="danger" type="button" disabled={busy} onClick={() => void dropRepo(entry.id)}>Remove</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <form className="repos-add" onSubmit={(event) => void addRepo(event)}>
                <label>
                  Directory name
                  <input value={repoName} onChange={(event) => setRepoName(event.target.value)} placeholder="widget" required />
                </label>
                <label>
                  Git URL
                  <input value={repoUrl} onChange={(event) => setRepoUrl(event.target.value)} placeholder="https://github.com/org/widget.git" spellCheck={false} required />
                </label>
                <button className="primary" type="submit" disabled={busy}>Add repository</button>
              </form>
            </section>
            <footer className="agents-bar">
              {folderDirty && <p>Unsaved folder settings.</p>}
              <div className="row-actions">
                <button className="ghost" type="button" disabled={!folderDirty || busy} onClick={discardFolder}>Discard</button>
                <button className="primary" type="submit" form="repo-folder" disabled={busy}>Save folder</button>
              </div>
            </footer>
          </div>
        )}

        {tab === "users" && !selected && (
          <section className="admin-pane admin-detail" aria-label="Users">
            <UsersDirectory
              accounts={accounts}
              self={session.username}
              busy={busy}
              username={username}
              password={password}
              onUsername={setUsername}
              onPassword={setPassword}
              onAdd={(event) => void addUser(event)}
              onRefresh={() => void reloadUsers()}
              onConfigure={(name) => {
                setError("");
                setSaved("");
                setSelected(name);
              }}
              onNote={setSaved}
              onError={setError}
            />
          </section>
        )}

        {tab === "users" && selected && (
          <section className="admin-pane admin-detail" aria-label="User">
            <PersonPanel
              key={selected}
              username={selected}
              self={selected === session.username}
              onBack={() => { setError(""); setSaved(""); setSelected(""); }}
              globalAgents={inventory.length > 0 ? inventory.filter((agent) => agent.enabled).map((agent) => agent.id) : session.agents}
              globalTerminal={session.rawTerminal}
              globalFileManager={session.fileManagerOffered ?? false}
              globalFileEditor={fileEditor}
              globalFileDownload={fileDownload}
              globalFileUpload={fileUpload}
              globalProjectCreate={session.projectCreate}
              agentOptions={agentOptions}
              agentNames={names}
              catalog={catalog}
              commandBlockStyle={session.commandBlockStyle ?? "prompt"}
              busy={busy}
              onBusy={setBusy}
              onError={setError}
              onNote={setSaved}
              onRemoved={async () => {
                setSelected("");
                await refreshUsers();
              }}
              onSaved={() => {
                if (selected === session.username) onAccess();
              }}
              onIdentity={onIdentity}
            />
          </section>
        )}
      </div>
    </div>
  );
}

type DirectoryRow = {
  identity?: GitIdentity | null;
  activity?: string | null;
  activityFailed?: boolean;
};

type AccountRoleFilter = "all" | "administrator" | "user";

function identityLine(identity: GitIdentity | null | undefined): string {
  if (!identity) return "";
  const name = identity.name.trim();
  const email = identity.email.trim();
  if (name && email) return `${name} <${email}>`;
  return name || email;
}

function shellSummary(accounts: Account[]): string {
  const counts = new Map<string, number>();
  for (const account of accounts) {
    if (!account.shell) continue;
    counts.set(account.shell, (counts.get(account.shell) ?? 0) + 1);
  }
  if (counts.size === 0) return "None";
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([shell, count]) => `${shell} (${count})`)
    .join(", ");
}

function activityText(row: DirectoryRow | undefined): string {
  if (!row || row.activity === undefined) return row?.activityFailed ? "—" : "…";
  if (row.activity === null) return "No conversations";
  return relativeTime(row.activity);
}

function accountInitial(username: string): string {
  const letter = username.trim().charAt(0);
  return letter ? letter.toUpperCase() : "?";
}

function UsersDirectory({
  accounts,
  self,
  busy,
  username,
  password,
  onUsername,
  onPassword,
  onAdd,
  onRefresh,
  onConfigure,
  onNote,
  onError,
}: {
  accounts: Account[];
  self: string;
  busy: boolean;
  username: string;
  password: string;
  onUsername: (value: string) => void;
  onPassword: (value: string) => void;
  onAdd: (event: FormEvent) => void;
  onRefresh: () => void;
  onConfigure: (username: string) => void;
  onNote: (value: string) => void;
  onError: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<AccountRoleFilter>("all");
  const [rows, setRows] = useState<Record<string, DirectoryRow>>({});
  const usernameRef = useRef<HTMLInputElement>(null);
  const needle = query.trim().toLowerCase();
  const visible = accounts.filter((account) => {
    const administrator = account.username === self;
    if (role === "administrator" && !administrator) return false;
    if (role === "user" && administrator) return false;
    if (!needle) return true;
    return account.username.toLowerCase().includes(needle)
      || String(account.uid).includes(needle)
      || account.home.toLowerCase().includes(needle);
  });
  const shells = shellSummary(accounts);
  const administrators = accounts.filter((account) => account.username === self).length;

  useEffect(() => {
    if (accounts.length === 0) return;
    let cancelled = false;
    for (const account of accounts) {
      const name = account.username;
      void getUserGitIdentity(name).then((identity) => {
        if (cancelled) return;
        setRows((current) => ({ ...current, [name]: { ...current[name], identity } }));
      }).catch(() => {
        if (cancelled) return;
        setRows((current) => {
          if (current[name]?.identity !== undefined) return current;
          return { ...current, [name]: { ...current[name], identity: null } };
        });
      });
      void listUserChats(name).then((chats) => {
        if (cancelled) return;
        const newest = chats.reduce((latest, chat) => chat.updatedAt > latest ? chat.updatedAt : latest, "");
        setRows((current) => ({ ...current, [name]: { ...current[name], activity: newest || null, activityFailed: false } }));
      }).catch(() => {
        if (cancelled) return;
        setRows((current) => {
          if (current[name]?.activity !== undefined) return current;
          return { ...current, [name]: { ...current[name], activityFailed: true } };
        });
      });
    }
    return () => {
      cancelled = true;
    };
  }, [accounts]);

  function focusAddUser() {
    document.getElementById("add-user")?.scrollIntoView({ block: "nearest" });
    usernameRef.current?.focus();
  }

  async function copyHome(home: string) {
    try {
      await navigator.clipboard.writeText(home);
      onNote("Home directory copied");
    } catch {
      const area = document.createElement("textarea");
      area.value = home;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.left = "-9999px";
      document.body.append(area);
      area.select();
      const copied = document.execCommand("copy");
      area.remove();
      if (copied) onNote("Home directory copied");
      else onError("Could not copy the home directory");
    }
  }

  return (
    <div className="users-directory">
      <header className="person-bar">
        <div className="person-identity">
          <span className="person-kicker">Users</span>
          <p className="muted">Accounts on this machine. Removing one deletes the Linux user and keeps their home directory.</p>
        </div>
        <div className="person-actions">
          <button className="ghost" type="button" disabled={busy} onClick={onRefresh}>Refresh</button>
          <button className="primary" type="button" onClick={focusAddUser}>Add user</button>
        </div>
      </header>
      <div className="metric-row">
        <div className="metric">
          <span>Accounts</span>
          <strong>{accounts.length}</strong>
        </div>
        <div className="metric">
          <span>Administrators</span>
          <strong>{administrators}</strong>
        </div>
        <div className="metric">
          <span>Shells</span>
          <strong className="users-shells" title={shells}>{shells}</strong>
        </div>
      </div>
      {accounts.length === 0 ? (
        <p className="muted">No accounts yet.</p>
      ) : (
        <div className="users-board">
          <div className="users-toolbar">
            <label className="users-filter">
              <input
                aria-label="Filter by username, UID, or home directory"
                value={query}
                placeholder="Filter by username, UID, or home directory"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <label className="users-role-pick">
              Role
              <select aria-label="Role" value={role} onChange={(event) => setRole(event.target.value as AccountRoleFilter)}>
                <option value="all">All roles</option>
                <option value="administrator">Administrators</option>
                <option value="user">Users</option>
              </select>
            </label>
          </div>
          <div className="users-table-wrap">
            <table className="users-table">
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Home</th>
                  <th>Role</th>
                  <th>UID / shell</th>
                  <th>Last active</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 ? (
                  <tr>
                    <td className="users-empty" colSpan={6}>No accounts match.</td>
                  </tr>
                ) : visible.map((account) => {
                  const administrator = account.username === self;
                  const detail = rows[account.username];
                  const git = identityLine(detail?.identity);
                  const waiting = detail?.identity === undefined;
                  return (
                    <tr className={administrator ? "is-admin" : undefined} key={account.username}>
                      <td data-label="Username">
                        <div className="users-person">
                          <span className={administrator ? "users-mark admin" : "users-mark"} aria-hidden="true">{accountInitial(account.username)}</span>
                          <span>
                            <strong>{account.username}</strong>
                            {waiting ? <span className="users-pending">…</span> : git ? <span>{git}</span> : null}
                          </span>
                        </div>
                      </td>
                      <td data-label="Home">
                        <div className="users-home">
                          <code>{account.home}</code>
                          <button
                            className="users-copy"
                            type="button"
                            title="Copy path"
                            aria-label={`Copy ${account.home}`}
                            onClick={() => void copyHome(account.home)}
                          >
                            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                              <rect x="5.5" y="5.5" width="8" height="8" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
                              <path d="M10.5 5.5V3.2A1.2 1.2 0 0 0 9.3 2H3.2A1.2 1.2 0 0 0 2 3.2v6.1a1.2 1.2 0 0 0 1.2 1.2H5.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
                            </svg>
                          </button>
                        </div>
                      </td>
                      <td data-label="Role">
                        <span className={administrator ? "users-role admin" : "users-role"}>{administrator ? "Administrator" : "User"}</span>
                      </td>
                      <td data-label="UID / shell">
                        <span className="users-uid">UID: {account.uid}</span>
                        {account.shell ? <span className="users-shell">{account.shell}</span> : null}
                      </td>
                      <td data-label="Last active">{activityText(detail)}</td>
                      <td data-label="Actions">
                        <button
                          className="users-configure"
                          type="button"
                          aria-label={`Configure ${account.username}`}
                          onClick={() => onConfigure(account.username)}
                        >
                          Configure
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="users-foot">Showing {visible.length} of {accounts.length}</div>
        </div>
      )}
      <form id="add-user" className="person-card" onSubmit={onAdd}>
        <header className="person-card-head">
          <h2>Add a user</h2>
          <p className="muted">A new name creates a Linux account. An existing account is granted access and given this password.</p>
        </header>
        <div className="users-add-fields">
          <label>
            Username
            <input ref={usernameRef} autoComplete="off" value={username} onChange={(event) => onUsername(event.target.value)} required />
          </label>
          <label>
            Password
            <input type="password" autoComplete="new-password" value={password} onChange={(event) => onPassword(event.target.value)} required />
          </label>
        </div>
        <div className="users-add-actions">
          <button
            className="ghost"
            type="button"
            onClick={() => {
              onUsername("");
              onPassword("");
              usernameRef.current?.focus();
            }}
          >
            Clear
          </button>
          <button className="primary" type="submit" disabled={busy}>Add user</button>
        </div>
      </form>
    </div>
  );
}

const COMMAND_STYLES: { id: CommandBlockStyle; name: string }[] = [
  { id: "prompt", name: "Prompt" },
  { id: "window", name: "Window" },
];

function presentPersonSettings(settings: Settings, themes: ExtensionTheme[]): Settings {
  const installed = themes.map((theme) => theme.id);
  return {
    ...settings,
    theme: normalizeTheme(settings.theme, installed),
    commandBlockStyle: isCommandBlockStyle(settings.commandBlockStyle) ? settings.commandBlockStyle : "prompt",
    wrapText: Boolean(settings.wrapText),
    visibleChats: normalizeVisibleChats(settings.visibleChats),
  };
}

function normalizeVisibleChats(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 100) return 5;
  return value;
}

function UserPreferences({
  settings,
  themes,
  fileEditorAllowed,
  onChange,
}: {
  settings: Settings;
  themes: ExtensionTheme[];
  fileEditorAllowed: boolean;
  onChange: (settings: Settings) => void;
}) {
  const installedIds = themes.map((theme) => theme.id).filter((id) => !isTheme(id));
  const themeCards = [
    ...THEME_CATALOG,
    ...themes.filter((theme) => !isTheme(theme.id)).map((theme) => ({
      id: theme.id,
      name: theme.name,
      tagline: theme.tagline,
      tier: theme.tier,
      swatches: theme.swatches,
    })),
  ];
  const activeTheme = normalizeTheme(settings.theme, installedIds);
  return (
    <section className="person-card" aria-labelledby="person-appearance">
      <header className="person-card-head">
        <PersonHeading id="person-appearance">Appearance and terminal theme</PersonHeading>
        <p className="muted">Theme, command blocks, how many chats stay open, and whether long lines wrap.</p>
      </header>
      <div>
        <span className="person-label">Interface themes</span>
        <div className="theme-grid" role="radiogroup" aria-label="Theme">
        {themeCards.map((item) => {
          const picked = activeTheme === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={picked}
              className={picked ? `theme-card theme-card-${item.id} active` : `theme-card theme-card-${item.id}`}
              onClick={() => onChange({ ...settings, theme: item.id })}
            >
              <div
                className="theme-preview"
                style={{ background: item.swatches.bg, borderColor: item.swatches.border }}
                aria-hidden="true"
              >
                <div
                  className="theme-preview-sidebar"
                  style={{ background: item.swatches.sidebar, borderRightColor: item.swatches.border }}
                >
                  <span className="theme-preview-dot" style={{ background: item.swatches.accent }} />
                  <span className="theme-preview-bar" style={{ background: item.swatches.ink, opacity: 0.7 }} />
                  <span className="theme-preview-bar short" style={{ background: item.swatches.ink, opacity: 0.35 }} />
                </div>
                <div className="theme-preview-stage">
                  <div
                    className="theme-preview-hud"
                    style={{
                      background: item.swatches.panel,
                      borderColor: item.swatches.border,
                      boxShadow: item.tier === "elaborate" ? `0 0 10px -2px ${item.swatches.accent}` : "none",
                    }}
                  >
                    <span className="theme-preview-title" style={{ background: item.swatches.ink }} />
                    <span className="theme-preview-accent" style={{ background: item.swatches.accent }} />
                  </div>
                </div>
              </div>
              <div className="theme-meta">
                <div className="theme-title-row">
                  <strong>{item.name}</strong>
                  <span className={item.tier === "elaborate" ? "theme-badge elaborate" : "theme-badge"}>
                    {"default" in item && item.default ? "Default" : item.tier}
                  </span>
                </div>
                <span className="theme-tagline">{item.tagline}</span>
              </div>
            </button>
          );
        })}
        </div>
      </div>
      <div className="person-split">
      <div>
      <span className="person-label">Command blocks render style</span>
      <div className="command-style-grid" role="radiogroup" aria-label="Command blocks">
        {COMMAND_STYLES.map((item) => {
          const picked = settings.commandBlockStyle === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={picked}
              className={picked ? "command-style-card active" : "command-style-card"}
              onClick={() => onChange({ ...settings, commandBlockStyle: item.id })}
            >
              {item.id === "prompt" ? <PromptPreview /> : <WindowPreview />}
              <span className="command-style-name">
                <strong>{item.name}</strong>
                {item.id === "prompt" ? <span className="theme-badge">Default</span> : null}
              </span>
            </button>
          );
        })}
      </div>
      </div>
      <div className="person-prefs">
      <label>
        Chats shown per project
        <span className="person-inline">
        <input
          type="number"
          min={0}
          max={100}
          step={1}
          value={settings.visibleChats}
          onChange={(event) => {
            const visibleChats = Number(event.target.value);
            if (!Number.isInteger(visibleChats) || visibleChats < 0 || visibleChats > 100) return;
            onChange({ ...settings, visibleChats });
          }}
        />
        <span className="muted">Older chats stay collapsed. Use 0 to show every chat.</span>
        </span>
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.wrapText}
          onChange={(event) => onChange({ ...settings, wrapText: event.target.checked })}
        />
        <span>Wrap long lines <span className="muted">Wrap file text, diffs, and code blocks instead of scrolling sideways.</span></span>
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={!fileEditorAllowed || Boolean(settings.filesReadOnly)}
          disabled={!fileEditorAllowed}
          onChange={(event) => onChange({ ...settings, filesReadOnly: event.target.checked })}
        />
        <span>Read-only file viewer <span className="muted">Disable inline workspace edits.</span></span>
      </label>
      {!fileEditorAllowed && (
        <p className="muted">File editing is off for this person, so the viewer stays read-only.</p>
      )}
      </div>
      </div>
    </section>
  );
}

function PersonHeading({ id, children }: { id?: string; children: string }) {
  return (
    <h2 id={id}>
      <span className="person-mark" aria-hidden="true" />
      {children}
    </h2>
  );
}

function ToolChip({ checked, label, onChange }: { checked: boolean; label: string; onChange: () => void }) {
  return (
    <label className="person-chip" title={label}>
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span>{label}</span>
    </label>
  );
}

function PromptPreview() {
  return (
    <span className="command-preview command-preview-prompt" aria-hidden="true">
      <span className="command-preview-head"><span>&gt;_</span> git status</span>
      <span className="command-preview-out">clean</span>
    </span>
  );
}

function WindowPreview() {
  return (
    <span className="command-preview command-preview-window" aria-hidden="true">
      <span className="command-preview-bar">
        <span className="command-preview-lights">
          <i />
          <i />
          <i />
        </span>
        <span className="command-preview-title">terminal</span>
      </span>
      <span className="command-preview-out">$ git status</span>
    </span>
  );
}

function PersonPanel({
  username,
  self,
  onBack,
  globalAgents,
  globalTerminal,
  globalFileManager,
  globalFileEditor,
  globalFileDownload,
  globalFileUpload,
  globalProjectCreate,
  agentOptions,
  agentNames,
  catalog,
  commandBlockStyle,
  busy,
  onBusy,
  onError,
  onNote,
  onRemoved,
  onSaved,
  onIdentity,
}: {
  username: string;
  self: boolean;
  onBack: () => void;
  globalAgents: AgentId[];
  globalTerminal: boolean;
  globalFileManager: boolean;
  globalFileEditor: boolean;
  globalFileDownload: boolean;
  globalFileUpload: boolean;
  globalProjectCreate: boolean;
  agentOptions: AgentOptionsState;
  agentNames?: { id: string; label: string }[];
  catalog: CatalogEntry[];
  commandBlockStyle: CommandBlockStyle;
  busy: boolean;
  onBusy: (value: boolean) => void;
  onError: (value: string) => void;
  onNote: (value: string) => void;
  onRemoved: () => Promise<void>;
  onSaved: () => void;
  onIdentity: () => void;
}) {
  const [policy, setPolicy] = useState<UserPolicy | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [themes, setThemes] = useState<ExtensionTheme[]>([]);
  const [grants, setGrants] = useState<Set<string>>(new Set());
  const [env, setEnv] = useState<EnvEntry[] | null>(null);
  const [identity, setIdentity] = useState<GitIdentity | null>(null);
  const [gitName, setGitName] = useState("");
  const [gitEmail, setGitEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [commands, setCommands] = useState<string | null>(null);
  const [profile, setProfile] = useState<{ home: string; uid: number; shell: string } | null>(null);
  const [lastActive, setLastActive] = useState<string | null | undefined>(undefined);
  const [reloadToken, setReloadToken] = useState(0);

  const agentKey = globalAgents.join(",");
  const catalogKey = catalog.map((entry) => entry.id).join(",");
  const globalAgentsRef = useRef(globalAgents);
  const catalogRef = useRef(catalog);
  const onErrorRef = useRef(onError);
  const loadGeneration = useRef(0);
  globalAgentsRef.current = globalAgents;
  catalogRef.current = catalog;
  onErrorRef.current = onError;
  useEffect(() => {
    const generation = ++loadGeneration.current;
    let cancel = false;
    const gitPromise = getUserGitIdentity(username).catch((err: unknown) => {
      if (!cancel && generation === loadGeneration.current) onErrorRef.current(message(err));
      return { name: "", email: "" };
    });
    getUserAccess(username).then(async (bundle) => {
      if (cancel || generation !== loadGeneration.current) return;
      const offered = globalAgentsRef.current;
      const allowed = new Set(offered);
      const agents = bundle.policy.agents.filter((agent) => allowed.has(agent));
      const chosen = agents.length > 0 ? agents : offered.slice(0, 1);
      const listedThemes = bundle.themes ?? [];
      setThemes(listedThemes);
      setProfile({ home: bundle.home, uid: bundle.uid, shell: bundle.shell });
      setPolicy({ ...bundle.policy, agents: chosen });
      const fallback = chosen[0] || bundle.settings.defaultAgent;
      setSettings(presentPersonSettings({
        ...bundle.settings,
        defaultAgent: chosen.includes(bundle.settings.defaultAgent) ? bundle.settings.defaultAgent : fallback,
      }, listedThemes));
      const listed = catalogRef.current;
      setGrants(new Set(bundle.grants.filter((id) => listed.some((entry) => entry.id === id))));
      setEnv(bundle.env);
      if (chosen.includes("cursor")) {
        try {
          const listedCommands = await getUserCursorCommands(username);
          if (!cancel && generation === loadGeneration.current) setCommands(listedCommands.commands.join("\n"));
        } catch (err) {
          if (!cancel && generation === loadGeneration.current) {
            setCommands("");
            onErrorRef.current(message(err));
          }
        }
      } else if (!cancel && generation === loadGeneration.current) {
        setCommands(null);
      }
      const git = await gitPromise;
      if (cancel || generation !== loadGeneration.current) return;
      setIdentity(git);
      setGitName(git.name);
      setGitEmail(git.email);
    }).catch((err) => {
      if (!cancel && generation === loadGeneration.current) onErrorRef.current(message(err));
    });
    return () => {
      cancel = true;
    };
  }, [username, agentKey, catalogKey, reloadToken]);

  function toggleAgent(agent: AgentId) {
    if (!policy) return;
    const next = policy.agents.includes(agent) ? policy.agents.filter((item) => item !== agent) : [...policy.agents, agent];
    if (next.length === 0) {
      onError("At least one agent must stay on");
      return;
    }
    onError("");
    setPolicy({ ...policy, agents: next });
    if (settings && !next.includes(settings.defaultAgent)) setSettings({ ...settings, defaultAgent: next[0]! });
  }

  function optionChecked(agent: AgentId, kind: "modes" | "models", id: string): boolean {
    if (!policy) return false;
    const personal = policy.options?.[agent];
    if (personal) return personal[kind].includes(id);
    return agentOptions[agent]?.offered[kind].includes(id) ?? false;
  }

  function toggleOption(agent: AgentId, kind: "modes" | "models", id: string) {
    if (!policy) return;
    const current = policy.options?.[agent] ?? {
      modes: [...(agentOptions[agent]?.offered.modes ?? [])],
      models: [...(agentOptions[agent]?.offered.models ?? [])],
    };
    const nextList = current[kind].includes(id) ? current[kind].filter((item) => item !== id) : [...current[kind], id];
    const next = { ...current, [kind]: nextList };
    setPolicy({ ...policy, options: { ...policy.options, [agent]: next } });
    if (settings && kind === "models" && settings.defaultAgent === agent && !next.models.includes(settings.defaultModel)) {
      setSettings({ ...settings, defaultModel: next.models[0] || "" });
    }
  }

  function chooseDefaultAgent(agent: AgentId) {
    if (!settings || !policy) return;
    const personal = policy.options?.[agent];
    const models = personal?.models ?? agentOptions[agent]?.offered.models ?? [];
    setSettings({
      ...settings,
      defaultAgent: agent,
      defaultModel: models.includes(settings.defaultModel) ? settings.defaultModel : models[0] || "",
    });
  }

  function toggleGrant(id: string) {
    setGrants((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function saveAccess(event: FormEvent) {
    event.preventDefault();
    if (!policy || !settings) return;
    // A load started before this save must not put the previous agents back.
    loadGeneration.current += 1;
    onBusy(true);
    onNote("");
    onError("");
    try {
      const options: NonNullable<UserPolicy["options"]> = {};
      for (const agent of policy.agents) {
        options[agent] = policy.options?.[agent] ?? {
          modes: [...(agentOptions[agent]?.offered.modes ?? [])],
          models: [...(agentOptions[agent]?.offered.models ?? [])],
        };
      }
      const modelIds = options[settings.defaultAgent]?.models ?? [];
      const defaultModel = modelIds.includes(settings.defaultModel) ? settings.defaultModel : modelIds[0] || "";
      const savedPolicy = await saveUserPolicy(username, { ...policy, binaries: {}, options });
      setPolicy(savedPolicy);
      const savedSettings = await saveUserSettings(username, {
        defaultAgent: settings.defaultAgent,
        defaultModel,
        permission: settings.permission,
        theme: settings.theme,
        commandBlockStyle: settings.commandBlockStyle,
        filesReadOnly: Boolean(settings.filesReadOnly),
        wrapText: Boolean(settings.wrapText),
        visibleChats: normalizeVisibleChats(settings.visibleChats),
      });
      setSettings(presentPersonSettings({ ...savedSettings, defaultModel }, themes));
      const savedGrants = await saveUserGrants(username, [...grants]);
      setGrants(new Set(savedGrants.grants));
      onNote("Access saved");
      onSaved();
      if (savedPolicy.agents.includes("cursor") && commands == null) {
        const listedCommands = await getUserCursorCommands(username);
        setCommands(listedCommands.commands.join("\n"));
      }
    } catch (err) {
      onError(message(err));
    } finally {
      onBusy(false);
    }
  }

  async function saveCommands(event: FormEvent) {
    event.preventDefault();
    if (commands == null) return;
    onBusy(true);
    onNote("");
    onError("");
    try {
      const saved = await saveUserCursorCommands(username, commandLines(commands));
      setCommands(saved.commands.join("\n"));
      onNote("Allowed commands saved");
    } catch (err) {
      onError(message(err));
    } finally {
      onBusy(false);
    }
  }

  async function saveEnv(event: FormEvent) {
    event.preventDefault();
    if (!env) return;
    const entries = env.filter((entry) => entry.key.trim() || entry.value);
    onBusy(true);
    onNote("");
    onError("");
    try {
      setEnv(await saveUserEnv(username, entries.map((entry) => ({ key: entry.key.trim(), value: entry.value }))));
      onNote("Environment saved");
    } catch (err) {
      onError(message(err));
    } finally {
      onBusy(false);
    }
  }

  async function savePassword(event: FormEvent) {
    event.preventDefault();
    if (password !== confirm) {
      onError("Passwords do not match");
      return;
    }
    onBusy(true);
    onNote("");
    onError("");
    try {
      await changePassword(username, password);
      setPassword("");
      setConfirm("");
      onNote("Password changed");
    } catch (err) {
      onError(message(err));
    } finally {
      onBusy(false);
    }
  }

  async function saveGit(event: FormEvent) {
    event.preventDefault();
    onBusy(true);
    onNote("");
    onError("");
    try {
      const saved = await saveUserGitIdentity(username, { name: gitName.trim(), email: gitEmail.trim() });
      setIdentity(saved);
      setGitName(saved.name);
      setGitEmail(saved.email);
      onNote("Git identity saved");
      if (self) onIdentity();
    } catch (err) {
      onError(message(err));
    } finally {
      onBusy(false);
    }
  }

  async function remove() {
    onBusy(true);
    onNote("");
    onError("");
    try {
      await removeAccount(username);
      onNote(`Removed ${username}`);
      await onRemoved();
    } catch (err) {
      onError(message(err));
    } finally {
      onBusy(false);
      setConfirmRemove(false);
    }
  }

  const allowed = policy?.agents.filter((agent) => globalAgents.includes(agent)) ?? [];
  const fileEditorAllowed = policy != null && globalFileEditor && policy.fileEditor !== false;
  const ready = policy != null && settings != null && env != null && identity != null;
  const limits = [
    !globalTerminal ? "The terminal is off for everyone, so this stays off until that is turned on." : "",
    !globalFileManager ? "The file manager is off for everyone, so this stays off until that is turned on." : "",
    !globalFileEditor ? "The file editor is off for everyone, so this stays read-only until that is turned on." : "",
    !globalFileDownload ? "File download is off for everyone, so this stays off until that is turned on." : "",
    !globalFileUpload ? "File upload is off for everyone, so this stays off until that is turned on." : "",
    !globalProjectCreate ? "Creating projects is off for everyone, so this stays off until that is turned on." : "",
  ].filter(Boolean);
  return (
    <div className="person-panel">
      <header className="person-bar">
        <div className="person-identity">
          <div className="person-crumb">
            <button className="person-back" type="button" onClick={onBack}>
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path d="M10 3.5 5.5 8 10 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              All users
            </button>
            <span aria-hidden="true">/</span>
            <strong>{username}</strong>
            {profile && (
              <span className="person-crumb-meta">({self ? "Administrator" : "User"} · UID: {profile.uid})</span>
            )}
          </div>
          <div className="person-meta">
            {profile ? (
              <>
                <span><strong>Home:</strong> <code>{profile.home}</code></span>
                <span><strong>Shell:</strong> <code>{profile.shell}</code></span>
                <span><strong>Last active:</strong> {lastActive ? relativeTime(lastActive) : lastActive === null ? "No conversations" : "…"}</span>
              </>
            ) : (
              <span>Loading {username}…</span>
            )}
          </div>
        </div>
        <div className="person-actions">
          <button className="ghost" type="button" disabled={busy} onClick={() => setReloadToken((value) => value + 1)}>Refresh</button>
          <button className="primary" type="submit" form="user-access" disabled={!ready || busy || allowed.length === 0}>[ Save changes ]</button>
        </div>
      </header>
      <UserConversations
        username={username}
        agentNames={agentNames}
        commandBlockStyle={commandBlockStyle}
        reloadToken={reloadToken}
        onActivity={setLastActive}
      />
      {!ready || !policy || !settings || !env || !identity ? (
        <div className="person-card" aria-busy="true">
          <p className="muted">Loading {username}…</p>
          <div className="admin-skeleton wide" />
          <div className="admin-skeleton" />
          <div className="admin-skeleton short" />
        </div>
      ) : (
        <>
          <form id="user-access" className="person-stack" onSubmit={(event) => void saveAccess(event)}>
            <section className="person-card" aria-labelledby="person-access">
              <header className="person-card-head">
                <PersonHeading id="person-access">Agents, modes, models and tools</PersonHeading>
                <p className="muted">Agents, modes, models, the terminal, the file manager, download, upload, project creation, defaults, and repositories for this person. Saving keeps only the modes and models checked here.</p>
              </header>
              <div>
                <span className="person-label">Granted system tools</span>
                <div className="person-chips">
                  {globalAgents.map((agent) => (
                    <ToolChip
                      key={agent}
                      label={agentLabel(agent, agentNames)}
                      checked={policy.agents.includes(agent)}
                      onChange={() => toggleAgent(agent)}
                    />
                  ))}
                  <ToolChip label="Terminal" checked={policy.rawTerminal} onChange={() => setPolicy({ ...policy, rawTerminal: !policy.rawTerminal })} />
                  <ToolChip label="File manager" checked={policy.fileManager} onChange={() => setPolicy({ ...policy, fileManager: !policy.fileManager })} />
                  <ToolChip label="File editor" checked={policy.fileEditor !== false} onChange={() => setPolicy({ ...policy, fileEditor: !(policy.fileEditor !== false) })} />
                  <ToolChip label="Download" checked={policy.fileDownload !== false} onChange={() => setPolicy({ ...policy, fileDownload: !(policy.fileDownload !== false) })} />
                  <ToolChip label="Upload" checked={policy.fileUpload !== false} onChange={() => setPolicy({ ...policy, fileUpload: !(policy.fileUpload !== false) })} />
                  <ToolChip label="Projects" checked={policy.projectCreate} onChange={() => setPolicy({ ...policy, projectCreate: !policy.projectCreate })} />
                </div>
                {globalAgents.length === 0 && <p className="muted">Turn on at least one agent above before assigning any.</p>}
                {limits.map((note) => <p className="muted" key={note}>{note}</p>)}
              </div>
              <div className="person-alloc">
                {allowed.map((agent) => {
                  const config = agentOptions[agent];
                  const modes = (config?.discovered.modes ?? []).filter((mode) => config?.offered.modes.includes(mode.id));
                  const models = (config?.discovered.models ?? []).filter((model) => config?.offered.models.includes(model.id));
                  return (
                    <div className="person-alloc-card" key={`${agent}-options`}>
                      <span className="person-kicker">{agentLabel(agent, agentNames)} allocations</span>
                      {modes.length === 0 && models.length === 0 && (
                        <p className="muted">Load modes and models for {agentLabel(agent, agentNames)} on the Agents tab before choosing any for this person.</p>
                      )}
                      {modes.length > 0 && (
                        <div>
                          <span className="person-label">Modes</span>
                          <div className="person-chips">
                            {modes.map((mode) => (
                              <ToolChip key={mode.id} label={mode.name} checked={optionChecked(agent, "modes", mode.id)} onChange={() => toggleOption(agent, "modes", mode.id)} />
                            ))}
                          </div>
                        </div>
                      )}
                      {models.length > 0 && (
                        <div>
                          <span className="person-label">Allowed models</span>
                          <div className="person-chips">
                            {models.map((model) => (
                              <ToolChip
                                key={model.id}
                                label={displayModelName(model.id, model.name)}
                                checked={optionChecked(agent, "models", model.id)}
                                onChange={() => toggleOption(agent, "models", model.id)}
                              />
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="person-fields">
                <label>
                  Default agent
                  <select
                    value={settings.defaultAgent}
                    onChange={(event) => chooseDefaultAgent(event.target.value as AgentId)}
                  >
                    {allowed.map((agent) => <option key={agent} value={agent}>{agentLabel(agent, agentNames)}</option>)}
                  </select>
                </label>
                <DefaultModelField
                  agent={settings.defaultAgent}
                  model={settings.defaultModel}
                  choices={defaultModelChoices(settings.defaultAgent, policy, agentOptions)}
                  onChange={(defaultModel) => setSettings({ ...settings, defaultModel })}
                />
                <label>
                  Tool approval
                  <select
                    value={settings.permission}
                    onChange={(event) => setSettings({ ...settings, permission: event.target.value as Settings["permission"] })}
                  >
                    <option value="ask">Ask each time</option>
                    <option value="edits">Allow edits, ask for the rest</option>
                    <option value="allow">Allow everything</option>
                  </select>
                </label>
              </div>
              <div>
                <span className="person-label">Repositories</span>
                <div className="person-repos">
                  {catalog.map((entry) => (
                    <label className="person-repo" key={entry.id}>
                      <input type="checkbox" checked={grants.has(entry.id)} onChange={() => toggleGrant(entry.id)} />
                      <span>
                        <strong>{entry.name}</strong>
                        <span>{entry.url}</span>
                      </span>
                    </label>
                  ))}
                  {catalog.length === 0 && <p className="muted">Add a repository to the catalog before granting one.</p>}
                </div>
              </div>
            </section>
            <UserPreferences
              settings={settings}
              themes={themes}
              fileEditorAllowed={fileEditorAllowed}
              onChange={setSettings}
            />
          </form>

          {commands != null && allowed.includes("cursor") && (
            <form className="person-card" onSubmit={(event) => void saveCommands(event)}>
              <header className="person-card-head person-card-head-row">
                <div>
                  <PersonHeading>Cursor shell command whitelist</PersonHeading>
                  <p className="muted">Shell commands Cursor may run for {username}. Saving changes this person only. Apply to all users, or Apply to this user, on the Agents tab replaces this list when it includes them.</p>
                </div>
                <button className="primary" type="submit" disabled={busy}>[ Save commands ]</button>
              </header>
              <div className="person-terminal">
                <div className="person-terminal-bar">
                  <span>Allowed executables, one per line</span>
                  <span>{commandLines(commands).length} commands</span>
                </div>
                <textarea
                  aria-label="Allowed commands"
                  rows={8}
                  value={commands}
                  spellCheck={false}
                  onChange={(event) => setCommands(event.target.value)}
                />
                <p className="person-terminal-foot">One command per line, such as ls or npm install. These are stored as Shell entries. Write paths already in the Cursor config stay.</p>
              </div>
            </form>
          )}

          <div className="person-split">
            <form className="person-card" onSubmit={(event) => void saveEnv(event)}>
              <header className="person-card-head person-card-head-row">
                <div>
                  <PersonHeading>Environment</PersonHeading>
                  <p className="muted">Values in their ~/.env file. HOME, PATH, and loader variables are left alone when an agent starts.</p>
                </div>
                <button className="ghost" type="button" onClick={() => setEnv([...env, { key: "", value: "" }])}>Add variable</button>
              </header>
              <div className="person-env-list">
                {env.map((entry, index) => (
                  <div className="person-env" key={index}>
                    <div className="person-env-label">
                      <span>Name</span>
                      <button className="person-remove" type="button" onClick={() => setEnv(env.filter((_, itemIndex) => itemIndex !== index))}>Remove</button>
                    </div>
                    <input
                      aria-label={`Variable name ${index + 1}`}
                      value={entry.key}
                      onChange={(event) => setEnv(env.map((item, itemIndex) => itemIndex === index ? { ...item, key: event.target.value } : item))}
                    />
                    <span className="person-env-label">Value</span>
                    <input
                      aria-label={`Variable value ${index + 1}`}
                      value={entry.value}
                      onChange={(event) => setEnv(env.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item))}
                    />
                  </div>
                ))}
              </div>
              <div className="person-card-foot">
                <button className="primary" type="submit" disabled={busy}>[ Save environment ]</button>
              </div>
            </form>

            <form className="person-card" onSubmit={(event) => void saveGit(event)}>
              <header className="person-card-head">
                <PersonHeading>Git identity</PersonHeading>
                <p className="muted">Saved as their global git name and email. This does not rename the Linux account.</p>
              </header>
              <label>
                Name
                <input autoComplete="name" value={gitName} onChange={(event) => setGitName(event.target.value)} required />
              </label>
              <label>
                Email
                <input type="email" autoComplete="email" value={gitEmail} onChange={(event) => setGitEmail(event.target.value)} required />
              </label>
              <div className="person-card-foot">
                <button className="primary" type="submit" disabled={busy}>[ Save git identity ]</button>
              </div>
            </form>
          </div>

          {!self && (
            <div className="person-split">
              <form className="person-card" onSubmit={(event) => void savePassword(event)}>
                <header className="person-card-head">
                  <PersonHeading>Security and password</PersonHeading>
                  <p className="muted">Update the password for this account.</p>
                </header>
                <label>
                  New password
                  <input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
                </label>
                <label>
                  Confirm password
                  <input type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} required />
                </label>
                <div className="person-card-foot">
                  <button className="primary" type="submit" disabled={busy}>[ Change password ]</button>
                </div>
              </form>
              <div className="person-card person-danger-card">
                <header className="person-card-head person-card-head-row">
                  <div>
                    <h2>
                      <span className="person-mark person-mark-danger" aria-hidden="true" />
                      Danger zone
                    </h2>
                    <p className="muted">This deletes the Linux account for {username} and leaves their home directory in place.</p>
                  </div>
                  <span className="person-restricted">Restricted</span>
                </header>
                {confirmRemove ? (
                  <div className="row-actions">
                    <button className="danger" type="button" disabled={busy} onClick={() => void remove()}>Confirm removal</button>
                    <button className="ghost" type="button" disabled={busy} onClick={() => setConfirmRemove(false)}>Cancel</button>
                  </div>
                ) : (
                  <button className="danger person-danger-btn" type="button" disabled={busy} onClick={() => setConfirmRemove(true)}>[ Remove account ]</button>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function UserConversations({
  username,
  agentNames,
  commandBlockStyle,
  reloadToken,
  onActivity,
}: {
  username: string;
  agentNames?: AgentName[];
  commandBlockStyle: CommandBlockStyle;
  reloadToken: number;
  onActivity: (iso: string | null) => void;
}) {
  const [chats, setChats] = useState<ChatMeta[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ChatDetail | null>(null);
  const [detailFailed, setDetailFailed] = useState(false);
  const report = useReportError();
  const [detailBusy, setDetailBusy] = useState(false);
  const openRef = useRef<string | null>(null);
  const onActivityRef = useRef(onActivity);
  onActivityRef.current = onActivity;

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const next = await listUserChats(username);
      const newest = next.reduce((latest, chat) => chat.updatedAt > latest ? chat.updatedAt : latest, "");
      onActivityRef.current(newest || null);
      setChats(next);
      setOpenId((current) => {
        const kept = current && next.some((chat) => chat.id === current) ? current : null;
        if (kept !== current) openRef.current = kept;
        return kept;
      });
    } catch (err) {
      setFailed(true);
      report("Conversations", err);
    }
  }, [username, report]);

  useEffect(() => {
    openRef.current = null;
    setOpenId(null);
    setDetail(null);
    setDetailFailed(false);
    void load();
  }, [load, reloadToken]);

  const blocks = useMemo(() => groupTranscript(detail?.transcript ?? []), [detail]);

  async function open(chat: ChatMeta) {
    if (openRef.current === chat.id) {
      openRef.current = null;
      setOpenId(null);
      setDetail(null);
      setDetailFailed(false);
      setDetailBusy(false);
      return;
    }
    openRef.current = chat.id;
    setOpenId(chat.id);
    setDetail(null);
    setDetailBusy(true);
    setDetailFailed(false);
    try {
      const result = await getUserChat(username, chat.id);
      if (openRef.current !== chat.id) return;
      setDetail(result);
    } catch (err) {
      if (openRef.current !== chat.id) return;
      setDetailFailed(true);
      report("Conversation", err);
    } finally {
      if (openRef.current === chat.id) setDetailBusy(false);
    }
  }

  return (
    <section className="person-card user-conversations" aria-labelledby="person-chats">
      <header className="person-card-head person-card-head-row">
        <div>
          <PersonHeading id="person-chats">Recent user conversations</PersonHeading>
          <p className="muted">What this user asked each agent, with the agent's replies.</p>
        </div>
        {chats && <span className="person-count">{chats.length} {chats.length === 1 ? "thread" : "threads"}</span>}
      </header>
      {chats && chats.length === 0 && <p className="muted person-pad">No conversations yet.</p>}
      {!chats && !failed && <p className="muted person-pad">Loading conversations…</p>}
      {failed && !chats && <p className="muted person-pad">Conversations could not be loaded.</p>}
      <div className="user-chat-list">
        {chats?.map((chat) => (
          <div className={openId === chat.id ? "user-chat open" : "user-chat"} key={chat.id}>
            <button
              className="user-chat-pick"
              type="button"
              aria-expanded={openId === chat.id}
              onClick={() => void open(chat)}
            >
              <span className="user-chat-copy">
                <strong><span className="person-prompt" aria-hidden="true">❯</span> {chat.title}</strong>
                <span>
                  <span className="person-badge">{agentLabel(chat.agent, agentNames)} · {workspaceName(chat.workspace)}</span>
                  {chat.updatedAt ? <span>{relativeTime(chat.updatedAt)}</span> : null}
                  {chat.running ? <span>Running</span> : null}
                </span>
              </span>
              <span className="user-chat-view">{openId === chat.id ? "Hide chat" : "View chat"}</span>
            </button>
            {openId === chat.id && (
              <div className="user-transcript" aria-live="polite">
                {detailBusy && <p className="muted">Loading conversation…</p>}
                {detailFailed && !detailBusy && <p className="muted">This conversation could not be loaded.</p>}
                {detail && blocks.length === 0 && !detailBusy && <p className="muted">This conversation has no messages yet.</p>}
                {detail && blocks.map((block, index) => {
                  if (block.kind === "text") {
                    if (block.role === "user") return <div className="bubble user" key={index}>{block.text}</div>;
                    return (
                      <div className="bubble assistant" key={index}>
                        <Markdown text={block.text} />
                        <CopyResponse text={block.text} />
                      </div>
                    );
                  }
                  if (block.kind === "thinking") {
                    return (
                      <details className="thinking" key={index}>
                        <summary>Thinking</summary>
                        <p>{block.text}</p>
                      </details>
                    );
                  }
                  if (block.kind === "tool") return <ToolBlock key={index} block={block} style={commandBlockStyle} />;
                  if (block.kind === "error") return <p className="alert" key={index} role="alert">{block.text}</p>;
                  return <p className="status" key={index}>{block.text}</p>;
                })}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function workspaceName(workspace: string): string {
  return workspace.split("/").filter(Boolean).pop() || workspace || "No repository";
}

function ServerPanel() {
  const [overview, setOverview] = useState<ServerOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const report = useReportError();

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setOverview(await serverOverview());
    } catch (err) {
      report("Server", err);
    } finally {
      setBusy(false);
    }
  }, [report]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="server-strip" aria-label="This machine">
      <div className="server-identity">
        <h2>Server</h2>
        <p className="muted">{overview ? overview.host.hostname : "Checking this machine."}</p>
      </div>
      {overview ? (
        <div className="metric-row">
          <div className="metric">
            <span>System</span>
              <strong title={`${overview.host.platform} ${overview.host.arch}`}>{overview.host.platform} {overview.host.arch}</strong>
          </div>
          <div className="metric">
            <span>Node</span>
            <strong>{overview.host.node}</strong>
          </div>
          <div className="metric">
            <span>Uptime</span>
            <strong>{formatUptime(overview.host.uptimeSeconds)}</strong>
          </div>
          <div className="metric">
            <span>Memory free</span>
            <strong>{formatBytes(overview.host.memoryFree)} of {formatBytes(overview.host.memoryTotal)}</strong>
          </div>
          {overview.disks.map((disk) => (
            <div className="metric" key={disk.path}>
              <span title={disk.path}>{disk.path}</span>
              <strong>{formatBytes(disk.free)} free of {formatBytes(disk.total)}</strong>
            </div>
          ))}
          {overview.commands.map((command) => (
            <div className="metric" key={command.name}>
              <span>{command.name}</span>
              <strong className={command.available ? undefined : "missing"} title={command.path ?? "Missing"}>{command.path ?? "Missing"}</strong>
            </div>
          ))}
          <div className="metric">
            <span>Config</span>
            <strong title={overview.configFile}>{overview.configFile}</strong>
          </div>
        </div>
      ) : (
        <div className="metric-row" aria-hidden="true">
          <div className="admin-skeleton" />
          <div className="admin-skeleton" />
          <div className="admin-skeleton short" />
        </div>
      )}
      <button className="ghost server-refresh" type="button" disabled={busy} onClick={() => void load()}>{busy ? "Checking…" : "Refresh"}</button>
    </section>
  );
}

function formatBytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  const digits = index === 0 || size >= 10 ? 0 : 1;
  return `${size.toFixed(digits)} ${units[index]}`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function defaultModelChoices(agent: AgentId, policy: UserPolicy, agentOptions: AgentOptionsState): AgentOptionChoice[] {
  const config = agentOptions[agent];
  if (!config) return [];
  const personal = policy.options?.[agent]?.models;
  const allowed = new Set(personal ?? config.offered.models);
  return config.discovered.models.filter((model) => config.offered.models.includes(model.id) && allowed.has(model.id));
}

function DefaultModelField({
  agent,
  model,
  choices,
  onChange,
}: {
  agent: AgentId;
  model: string;
  choices: AgentOptionChoice[];
  onChange: (model: string) => void;
}) {
  if (choices.length === 0) return <p className="muted">No models are enabled for {agentLabel(agent)}.</p>;
  const value = choices.some((choice) => choice.id === model) ? model : choices[0]!.id;
  return (
    <label>
      Default model
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {choices.map((choice) => {
          const label = displayModelName(choice.id, choice.name);
          return <option key={choice.id} value={choice.id} title={label}>{label}</option>;
        })}
      </select>
    </label>
  );
}

function AgentOptions({
  label,
  config,
  draft,
  enabled,
  onToggle,
  onClearModels,
}: {
  label: string;
  config: AgentOptionsState[AgentId];
  draft: { modes: string[]; models: string[] };
  enabled: boolean;
  onToggle: (kind: "modes" | "models", id: string) => void;
  onClearModels: (ids: string[]) => void;
}) {
  const [filter, setFilter] = useState("");
  const modes = config?.discovered.modes ?? [];
  const models = config?.discovered.models ?? [];
  const query = filter.trim().toLowerCase();
  const visible = models.filter((model) => {
    if (!query) return true;
    const label = displayModelName(model.id, model.name);
    return label.toLowerCase().includes(query) || model.id.toLowerCase().includes(query);
  });
  const groups = groupModels(visible);
  const selectedCount = models.filter((model) => draft.models.includes(model.id)).length;
  const visibleSelected = visible.filter((model) => draft.models.includes(model.id));

  if (!config) {
    return (
      <section className="agents-card">
        <h3>Modes and models</h3>
        <p className="muted">
          {enabled
            ? `Load modes and models to choose what ${label} can use.`
            : `Save ${label} before loading its modes and models.`}
        </p>
      </section>
    );
  }
  if (modes.length === 0 && models.length === 0) {
    return (
      <section className="agents-card">
        <h3>Modes and models</h3>
        <p className="muted">This agent did not report any modes or models.</p>
      </section>
    );
  }
  return (
    <>
      {modes.length > 0 && (
        <section className="agents-card" aria-label="Execution modes">
          <div className="agents-section-head">
            <h3>Execution modes</h3>
            <p className="muted">Choose the modes allowed for {label}.</p>
          </div>
          <div className="mode-grid">
            {modes.map((mode) => (
              <label className={draft.modes.includes(mode.id) ? "choice-card on" : "choice-card"} key={mode.id}>
                <input type="checkbox" checked={draft.modes.includes(mode.id)} onChange={() => onToggle("modes", mode.id)} />
                <span className="choice-copy">
                  <strong>{mode.name}</strong>
                  {mode.description && <span className="choice-sub">{mode.description}</span>}
                </span>
              </label>
            ))}
          </div>
        </section>
      )}
      {models.length > 0 && (
        <section className="agents-card" aria-label="Models">
          <div className="model-head">
            <div className="agents-section-head">
              <h3>
                Models
                <span className="agents-count">{selectedCount} selected</span>
              </h3>
              <p className="muted">Choose which models {label} can use.</p>
            </div>
            <div className="model-tools">
              <input
                aria-label="Filter models"
                placeholder="Filter models"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.preventDefault();
                }}
              />
              <button
                className="ghost"
                type="button"
                disabled={visibleSelected.length === 0}
                onClick={() => onClearModels(visibleSelected.map((model) => model.id))}
              >
                Clear
              </button>
            </div>
          </div>
          {visible.length === 0 ? (
            <p className="muted">No models match that filter.</p>
          ) : (
            <div className="model-groups">
              {groups.map((group) => (
                <div className="model-group" key={group.label || "all"}>
                  {group.label && <h4 className="model-group-label">{group.label}</h4>}
                  <div className="model-grid">
                    {group.models.map((model) => {
                      const label = displayModelName(model.id, model.name);
                      return (
                        <label className={draft.models.includes(model.id) ? "choice-card on" : "choice-card"} key={model.id} title={label}>
                          <input type="checkbox" checked={draft.models.includes(model.id)} onChange={() => onToggle("models", model.id)} />
                          <span className="choice-copy">
                            <strong title={label}>{label}</strong>
                            {model.description && <span className="choice-sub">{model.description}</span>}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </>
  );
}

function formatApply(agent: "pi" | "cursor", result: HarnessApplyResult): string {
  const updated = result.applied.map((item) => item.username);
  const pieces = [updated.length > 0 ? `Applied to ${updated.join(", ")}` : "Applied to nobody"];
  if (agent === "cursor") {
    const held = result.applied.filter((item) => !item.model).map((item) => item.username);
    if (held.length > 0) pieces.push(`left grok-4.7 unchanged for ${held.join(", ")}`);
  }
  if (result.skipped.length > 0) {
    pieces.push(`skipped ${result.skipped.map((item) => `${item.username} (${item.reason})`).join(", ")}`);
  }
  return `${pieces.join("; ")}.`;
}

function agentFlags(agents: AgentId[]): Record<string, boolean> {
  const flags: Record<string, boolean> = {};
  for (const agent of AGENTS) flags[agent] = agents.includes(agent);
  return flags;
}

function sessionOffer(session: Session): OfferSnapshot {
  return {
    flags: agentFlags(session.agents),
    rawTerminal: session.rawTerminal,
    cliImport: session.cliImport,
    fileManager: session.fileManagerOffered ?? false,
    fileEditor: session.fileEditor ?? true,
    fileDownload: session.fileDownloadOffered ?? false,
    fileUpload: session.fileUploadOffered ?? false,
    piProvider: "",
    piModel: "",
    cursorCommands: [],
    cursorFast: false,
    offered: {},
  };
}

function cloneOffered(
  offered: Partial<Record<string, { modes: string[]; models: string[] }>>,
): Partial<Record<string, { modes: string[]; models: string[] }>> {
  const copy: Partial<Record<string, { modes: string[]; models: string[] }>> = {};
  for (const [agent, list] of Object.entries(offered)) {
    if (!list) continue;
    copy[agent] = { modes: [...list.modes], models: [...list.models] };
  }
  return copy;
}

function visibilityEqual(left: FileVisibility, right: FileVisibility): boolean {
  return left.showHidden === right.showHidden
    && left.showGitignored === right.showGitignored
    && left.showGitDir === right.showGitDir;
}

function listsEqual(left: string[] = [], right: string[] = []): boolean {
  if (left.length !== right.length) return false;
  const seen = new Set(right);
  return left.every((item) => seen.has(item));
}

function flagsEqual(left: Record<string, boolean>, right: Record<string, boolean>): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (Boolean(left[key]) !== Boolean(right[key])) return false;
  }
  return true;
}

function offersEqual(left: OfferSnapshot, right: OfferSnapshot): boolean {
  if (!flagsEqual(left.flags, right.flags)) return false;
  if (left.rawTerminal !== right.rawTerminal) return false;
  if (left.cliImport !== right.cliImport) return false;
  if (left.fileManager !== right.fileManager) return false;
  if (left.fileEditor !== right.fileEditor) return false;
  if (left.fileDownload !== right.fileDownload) return false;
  if (left.fileUpload !== right.fileUpload) return false;
  if (left.piProvider !== right.piProvider) return false;
  if (left.piModel !== right.piModel) return false;
  if (left.cursorCommands.length !== right.cursorCommands.length) return false;
  if (left.cursorCommands.some((item, index) => item !== right.cursorCommands[index])) return false;
  if (left.cursorFast !== right.cursorFast) return false;
  const keys = new Set([...Object.keys(left.offered), ...Object.keys(right.offered)]);
  for (const key of keys) {
    const a = left.offered[key] ?? { modes: [], models: [] };
    const b = right.offered[key] ?? { modes: [], models: [] };
    if (!listsEqual(a.modes, b.modes) || !listsEqual(a.models, b.models)) return false;
  }
  return true;
}

const MODEL_FAMILIES = ["claude", "gpt", "gemini", "grok", "composer", "kimi", "glm"];

function modelGroup(id: string): string {
  const slash = id.indexOf("/");
  if (slash > 0) return id.slice(0, slash);
  const lower = id.toLowerCase();
  for (const family of MODEL_FAMILIES) {
    if (lower === family || lower.startsWith(`${family}-`)) return family;
  }
  const dash = lower.indexOf("-");
  return dash > 0 ? lower.slice(0, dash) : "";
}

function groupModels(models: AgentOptionChoice[]): { label: string; models: AgentOptionChoice[] }[] {
  const order: string[] = [];
  const buckets = new Map<string, AgentOptionChoice[]>();
  for (const model of models) {
    const key = modelGroup(model.id);
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)!.push(model);
  }
  if (buckets.size <= 1) return [{ label: "", models }];
  return order.map((key) => ({ label: key || "Other", models: buckets.get(key) ?? [] }));
}
