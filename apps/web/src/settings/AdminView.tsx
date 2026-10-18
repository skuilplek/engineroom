import { useCallback, useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  AGENTS,
  agentLabel,
  DEFAULT_FILE_VISIBILITY,
  type AgentId,
  type AgentOptionChoice,
  type CatalogEntry,
  type EnvEntry,
  type FileVisibility,
  type Settings,
  type UserPolicy,
} from "@engineroom/protocol";
import {
  addAccount,
  addCatalog,
  changePassword,
  getAgentOptions,
  getRepoDirectory,
  getUserAccess,
  listAccounts,
  listCatalog,
  probeAgentOptions,
  removeAccount,
  removeCatalog,
  saveAgentOptions,
  saveAgents,
  saveBranding,
  saveUserEnv,
  saveUserGrants,
  saveUserPolicy,
  saveUserSettings,
  saveRepoDirectory,
  serverOverview,
  type Account,
  type AgentOptionsState,
  type ServerOverview,
  type Session,
} from "../api.ts";
import { message } from "../format.ts";

type AdminTab = "overview" | "agents" | "repositories" | "people";

const TABS: { id: AdminTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "agents", label: "Agents" },
  { id: "repositories", label: "Repositories" },
  { id: "people", label: "People" },
];

export function AdminView({
  session,
  onAgents,
  onBranding,
  onAccess,
}: {
  session: Session;
  onAgents: (agents: AgentId[], rawTerminal: boolean, cliImport: boolean) => void;
  onBranding: (appName: string) => void;
  onAccess: () => void;
}) {
  const [flags, setFlags] = useState<Record<AgentId, boolean>>(() => agentFlags(session.agents));
  const [rawTerminal, setRawTerminal] = useState(session.rawTerminal);
  const [cliImport, setCliImport] = useState(session.cliImport);
  const [appName, setAppName] = useState(session.appName || "AgentWrapper");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [selected, setSelected] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [repoName, setRepoName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [repoFolder, setRepoFolder] = useState("Sites");
  const [fileVisibility, setFileVisibility] = useState<FileVisibility>(() => ({
    ...(session.fileVisibility ?? DEFAULT_FILE_VISIBILITY),
  }));
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
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
    return next;
  }

  useEffect(() => {
    refreshUsers().catch((err) => setError(message(err)));
    listCatalog().then((body) => setCatalog(body.repositories)).catch((err) => setError(message(err)));
    getRepoDirectory().then((body) => {
      setRepoFolder(body.directory);
      if (body.visibility) setFileVisibility(body.visibility);
    }).catch((err) => setError(message(err)));
    getAgentOptions().then((options) => {
      setAgentOptions(options);
      const draft: Partial<Record<AgentId, { modes: string[]; models: string[] }>> = {};
      for (const agent of AGENTS) {
        if (options[agent]) draft[agent] = options[agent].offered;
      }
      setOfferedDraft(draft);
    }).catch((err) => setError(message(err)));
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
      const savedAgents = await saveAgents(flags, rawTerminal, cliImport);
      onAgents(savedAgents.agents, savedAgents.rawTerminal ?? rawTerminal, savedAgents.cliImport ?? cliImport);
      if (Object.keys(offeredDraft).length > 0) {
        const savedOptions = await saveAgentOptions(offeredDraft);
        setAgentOptions(savedOptions);
      }
      onAccess();
      setSaved("Agents saved");
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

  async function loadOptions(agent: AgentId) {
    setBusy(true);
    setSaved("");
    setError("");
    try {
      const record = await probeAgentOptions(agent);
      setAgentOptions((current) => ({ ...current, [agent]: record }));
      setOfferedDraft((current) => ({ ...current, [agent]: record.offered }));
      setSaved(`Loaded ${agentLabel(agent)} modes and models`);
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
      const savedFolder = await saveRepoDirectory(repoFolder.trim(), fileVisibility);
      setRepoFolder(savedFolder.directory);
      if (savedFolder.visibility) setFileVisibility(savedFolder.visibility);
      onAccess();
      setSaved("Repository folder saved");
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

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

  const offered = AGENTS.filter((agent) => flags[agent]).map((agent) => agentLabel(agent));

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
        <p className="alert" role="alert">{error}</p>
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
                <span className="muted">{offered.length ? offered.join(", ") : "None offered"}. {rawTerminal ? "Terminal on." : "Terminal off."} {cliImport ? "CLI import on." : "CLI import off."}</span>
              </button>
              <button className="overview-link" type="button" onClick={() => openTab("repositories")}>
                <span>Repositories</span>
                <strong>{catalog.length}</strong>
                <span className="muted">{catalog.length === 0 ? "Nothing in the catalog yet." : "Ready to grant."}</span>
              </button>
              <button className="overview-link" type="button" onClick={() => openTab("people")}>
                <span>People</span>
                <strong>{accounts.length}</strong>
                <span className="muted">{accounts.length === 0 ? "No accounts yet." : "Linux accounts on this machine."}</span>
              </button>
            </div>
          </div>
        )}

        {tab === "agents" && (
          <form className="admin-pane" onSubmit={(event) => void saveAgentList(event)}>
            <h2>Available agents</h2>
            <p className="muted">These are the agents this machine offers. A person can only use the ones you also allow for them. Load an agent, then choose the modes and models people can use. Nothing is offered until you save a selection.</p>
            <div className="admin-checks">
              {AGENTS.map((agent) => (
                <label className="check" key={agent}>
                  <input type="checkbox" checked={flags[agent]} onChange={() => toggle(agent)} />
                  {agentLabel(agent)}
                </label>
              ))}
              <label className="check">
                <input type="checkbox" checked={rawTerminal} onChange={() => setRawTerminal((value) => !value)} />
                Raw terminal
              </label>
              <label className="check">
                <input type="checkbox" checked={cliImport} onChange={() => setCliImport((value) => !value)} />
                Import CLI sessions
              </label>
            </div>
            {AGENTS.filter((agent) => flags[agent] && agent !== "pi").map((agent) => {
              const config = agentOptions[agent];
              const draft = offeredDraft[agent] ?? { modes: [], models: [] };
              const enabled = session.agents.includes(agent);
              return (
                <div className="option-block" key={agent}>
                  <h3>{agentLabel(agent)}</h3>
                  {enabled ? (
                    <button className="ghost" type="button" disabled={busy} onClick={() => void loadOptions(agent)}>
                      Load modes and models
                    </button>
                  ) : (
                    <p className="muted">Save this agent before loading its modes and models.</p>
                  )}
                  {config && config.discovered.modes.length === 0 && config.discovered.models.length === 0 && (
                    <p className="muted">This agent did not report any modes or models.</p>
                  )}
                  {config && config.discovered.modes.length > 0 && (
                    <div className="admin-checks">
                      <span className="muted">Modes</span>
                      {config.discovered.modes.map((mode) => (
                        <label className="check" key={mode.id}>
                          <input
                            type="checkbox"
                            checked={draft.modes.includes(mode.id)}
                            onChange={() => toggleOffered(agent, "modes", mode.id)}
                          />
                          {mode.name}
                        </label>
                      ))}
                    </div>
                  )}
                  {config && config.discovered.models.length > 0 && (
                    <div className="admin-checks">
                      <span className="muted">Models</span>
                      {config.discovered.models.map((model) => (
                        <label className="check" key={model.id}>
                          <input
                            type="checkbox"
                            checked={draft.models.includes(model.id)}
                            onChange={() => toggleOffered(agent, "models", model.id)}
                          />
                          {model.name}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {flags.pi && <p className="muted">Pi does not report modes or models.</p>}
            <button className="primary" type="submit" disabled={busy}>Save agents</button>
          </form>
        )}

        {tab === "repositories" && (
          <>
          <form className="admin-pane" onSubmit={(event) => void saveFolder(event)}>
            <h2>Repository folder</h2>
            <p className="muted">People can start a chat in any git repository inside this folder of their home, including ones they add themselves. The folder is scanned when they sign in. The default is Sites.</p>
            <label>
              Folder
              <input value={repoFolder} onChange={(event) => setRepoFolder(event.target.value)} placeholder="Sites" required />
            </label>
            <h3>File manager visibility</h3>
            <p className="muted">Choose which repository files are visible in the right-hand file manager. Hidden dotfiles, gitignored files, and .git/ are hidden by default.</p>
            <div className="admin-checks">
              <label className="check">
                <input
                  type="checkbox"
                  checked={fileVisibility.showHidden}
                  onChange={() => setFileVisibility((current) => ({ ...current, showHidden: !current.showHidden }))}
                />
                Show hidden files (dotfiles)
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={fileVisibility.showGitignored}
                  onChange={() => setFileVisibility((current) => ({ ...current, showGitignored: !current.showGitignored }))}
                />
                Show gitignored files
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={fileVisibility.showGitDir}
                  onChange={() => setFileVisibility((current) => ({ ...current, showGitDir: !current.showGitDir }))}
                />
                Show .git directory
              </label>
            </div>
            <button className="primary" type="submit" disabled={busy}>Save folder</button>
          </form>
          <form className="admin-pane" onSubmit={(event) => void addRepo(event)}>
            <h2>Repository catalog</h2>
            <p className="muted">These remotes are what a person can install. Granting one clones it into their repository folder. A checkout that is already there stays available for chats.</p>
            <div className="repo-admin">
              {catalog.map((entry) => (
                <div className="account" key={entry.id}>
                  <div>
                    <strong>{entry.name}</strong>
                    <span>{entry.url}</span>
                  </div>
                  <button className="danger" type="button" disabled={busy} onClick={() => void dropRepo(entry.id)}>Remove</button>
                </div>
              ))}
              {catalog.length === 0 && <p className="muted">No repositories in the catalog yet.</p>}
            </div>
            <label>
              Directory name
              <input value={repoName} onChange={(event) => setRepoName(event.target.value)} placeholder="widget" required />
            </label>
            <label>
              Git URL
              <input value={repoUrl} onChange={(event) => setRepoUrl(event.target.value)} placeholder="https://github.com/org/widget.git" required />
            </label>
            <button className="primary" type="submit" disabled={busy}>Add repository</button>
          </form>
          </>
        )}

        {tab === "people" && (
          <div className="admin-people-layout">
            <section className="admin-pane" aria-label="People">
              <h2>People</h2>
              <p className="muted">Accounts on this machine. Removing one deletes the Linux user and keeps their home directory.</p>
              <div className="accounts">
                {accounts.map((account) => (
                  <div className={account.username === selected ? "account active" : "account"} key={account.username}>
                    <button className="account-pick" type="button" onClick={() => setSelected(account.username)} aria-pressed={account.username === selected}>
                      <strong>{account.username}</strong>
                      <span>{account.home}</span>
                    </button>
                    {account.username === session.username && <span className="muted">Administrator</span>}
                  </div>
                ))}
                {accounts.length === 0 && <p className="muted">No accounts yet.</p>}
              </div>
              <form onSubmit={(event) => void addUser(event)}>
                <h3>Add a person</h3>
                <p className="muted">A new name creates a Linux account. An existing account is granted access and given this password.</p>
                <label>
                  Username
                  <input autoComplete="off" value={username} onChange={(event) => setUsername(event.target.value)} required />
                </label>
                <label>
                  Password
                  <input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
                </label>
                <button className="primary" type="submit" disabled={busy}>Add user</button>
              </form>
            </section>
            <section className="admin-pane admin-detail" aria-label="Person">
              {selected ? (
                <PersonPanel
                  key={selected}
                  username={selected}
                  self={selected === session.username}
                  globalAgents={session.agents}
                  globalTerminal={session.rawTerminal}
                  agentOptions={agentOptions}
                  catalog={catalog}
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
                />
              ) : (
                <div className="admin-empty">
                  <h2>No person selected</h2>
                  <p className="muted">Choose a person to set their agents, modes, models, terminal, repositories, environment, and password.</p>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function PersonPanel({
  username,
  self,
  globalAgents,
  globalTerminal,
  agentOptions,
  catalog,
  busy,
  onBusy,
  onError,
  onNote,
  onRemoved,
  onSaved,
}: {
  username: string;
  self: boolean;
  globalAgents: AgentId[];
  globalTerminal: boolean;
  agentOptions: AgentOptionsState;
  catalog: CatalogEntry[];
  busy: boolean;
  onBusy: (value: boolean) => void;
  onError: (value: string) => void;
  onNote: (value: string) => void;
  onRemoved: () => Promise<void>;
  onSaved: () => void;
}) {
  const [policy, setPolicy] = useState<UserPolicy | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [grants, setGrants] = useState<Set<string>>(new Set());
  const [env, setEnv] = useState<EnvEntry[] | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);

  const agentKey = globalAgents.join(",");
  const catalogKey = catalog.map((entry) => entry.id).join(",");
  useEffect(() => {
    let cancel = false;
    getUserAccess(username).then((bundle) => {
      if (cancel) return;
      const allowed = new Set(globalAgents);
      const agents = bundle.policy.agents.filter((agent) => allowed.has(agent));
      const chosen = agents.length > 0 ? agents : globalAgents.slice(0, 1);
      setPolicy({ ...bundle.policy, agents: chosen });
      const fallback = chosen[0] || bundle.settings.defaultAgent;
      setSettings({
        ...bundle.settings,
        defaultAgent: chosen.includes(bundle.settings.defaultAgent) ? bundle.settings.defaultAgent : fallback,
      });
      setGrants(new Set(bundle.grants.filter((id) => catalog.some((entry) => entry.id === id))));
      setEnv(bundle.env);
    }).catch((err) => {
      if (!cancel) onError(message(err));
    });
    return () => {
      cancel = true;
    };
  }, [username, agentKey, catalogKey, globalAgents, catalog, onError]);

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
    onBusy(true);
    onNote("");
    onError("");
    try {
      const binaries: UserPolicy["binaries"] = {};
      for (const agent of policy.agents) {
        const value = (policy.binaries[agent] || "").trim();
        if (value) binaries[agent] = value;
      }
      const options: NonNullable<UserPolicy["options"]> = {};
      for (const agent of policy.agents) {
        options[agent] = policy.options?.[agent] ?? {
          modes: [...(agentOptions[agent]?.offered.modes ?? [])],
          models: [...(agentOptions[agent]?.offered.models ?? [])],
        };
      }
      const modelIds = options[settings.defaultAgent]?.models ?? [];
      const defaultModel = modelIds.includes(settings.defaultModel) ? settings.defaultModel : modelIds[0] || "";
      const savedPolicy = await saveUserPolicy(username, { ...policy, binaries, options });
      setPolicy(savedPolicy);
      const savedSettings = await saveUserSettings(username, {
        defaultAgent: settings.defaultAgent,
        defaultModel,
        permission: settings.permission,
      });
      setSettings(savedSettings);
      const savedGrants = await saveUserGrants(username, [...grants]);
      setGrants(new Set(savedGrants.grants));
      onNote("Access saved");
      onSaved();
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

  if (!policy || !settings || !env) {
    return (
      <div className="person-panel" aria-busy="true">
        <h2>{username}</h2>
        <p className="muted">Loading {username}…</p>
        <div className="admin-skeleton wide" />
        <div className="admin-skeleton" />
        <div className="admin-skeleton short" />
      </div>
    );
  }
  const allowed = policy.agents.filter((agent) => globalAgents.includes(agent));
  return (
    <div className="person-panel">
      <h2>{username}</h2>
      <form onSubmit={(event) => void saveAccess(event)}>
        <p className="muted">Agents, modes, models, the terminal, defaults, and repositories for this person. Saving keeps only the modes and models checked here.</p>
        <div className="admin-checks">
          {globalAgents.map((agent) => (
            <label className="check" key={agent}>
              <input type="checkbox" checked={policy.agents.includes(agent)} onChange={() => toggleAgent(agent)} />
              {agentLabel(agent)}
            </label>
          ))}
        </div>
        {globalAgents.length === 0 && <p className="muted">Turn on at least one agent above before assigning any.</p>}
        {allowed.map((agent) => (
          <label key={agent}>
            {agentLabel(agent)} path
            <input
              value={policy.binaries[agent] || ""}
              placeholder="Absolute path, or blank to use their own"
              onChange={(event) => setPolicy({ ...policy, binaries: { ...policy.binaries, [agent]: event.target.value } })}
            />
          </label>
        ))}
        <label className="check">
          <input
            type="checkbox"
            checked={policy.rawTerminal}
            onChange={() => setPolicy({ ...policy, rawTerminal: !policy.rawTerminal })}
          />
          Terminal
        </label>
        {!globalTerminal && <p className="muted">The terminal is off for everyone, so this stays off until that is turned on.</p>}
        {allowed.map((agent) => {
          const config = agentOptions[agent];
          const modes = (config?.discovered.modes ?? []).filter((mode) => config?.offered.modes.includes(mode.id));
          const models = (config?.discovered.models ?? []).filter((model) => config?.offered.models.includes(model.id));
          if (agent === "pi") {
            return <p className="muted" key={`${agent}-options`}>Pi does not report modes or models.</p>;
          }
          if (modes.length === 0 && models.length === 0) {
            return <p className="muted" key={`${agent}-options`}>Load modes and models for {agentLabel(agent)} on the Agents tab before choosing any for this person.</p>;
          }
          return (
            <div className="option-block" key={`${agent}-options`}>
              <h3>{agentLabel(agent)}</h3>
              {modes.length > 0 && (
                <div className="admin-checks">
                  <span className="muted">Modes</span>
                  {modes.map((mode) => (
                    <label className="check" key={mode.id}>
                      <input type="checkbox" checked={optionChecked(agent, "modes", mode.id)} onChange={() => toggleOption(agent, "modes", mode.id)} />
                      {mode.name}
                    </label>
                  ))}
                </div>
              )}
              {models.length > 0 && (
                <div className="admin-checks">
                  <span className="muted">Models</span>
                  {models.map((model) => (
                    <label className="check" key={model.id}>
                      <input type="checkbox" checked={optionChecked(agent, "models", model.id)} onChange={() => toggleOption(agent, "models", model.id)} />
                      {model.name}
                    </label>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        <label>
          Default agent
          <select
            value={settings.defaultAgent}
            onChange={(event) => chooseDefaultAgent(event.target.value as AgentId)}
          >
            {allowed.map((agent) => <option key={agent} value={agent}>{agentLabel(agent)}</option>)}
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
        <div className="repo-admin">
          {catalog.map((entry) => (
            <label className="check repo-choice" key={entry.id}>
              <input type="checkbox" checked={grants.has(entry.id)} onChange={() => toggleGrant(entry.id)} />
              <span>
                <strong>{entry.name}</strong>
                <span>{entry.url}</span>
              </span>
            </label>
          ))}
          {catalog.length === 0 && <p className="muted">Add a repository to the catalog before granting one.</p>}
        </div>
        <button className="primary" type="submit" disabled={busy || allowed.length === 0}>Save access</button>
      </form>

      <form onSubmit={(event) => void saveEnv(event)}>
        <h3>Environment</h3>
        <p className="muted">Values in their ~/.env file. HOME, PATH, and loader variables are left alone when an agent starts.</p>
        {env.map((entry, index) => (
          <div className="env-row" key={index}>
            <label>
              Name
              <input
                value={entry.key}
                onChange={(event) => setEnv(env.map((item, itemIndex) => itemIndex === index ? { ...item, key: event.target.value } : item))}
              />
            </label>
            <label>
              Value
              <input
                value={entry.value}
                onChange={(event) => setEnv(env.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item))}
              />
            </label>
            <button className="ghost" type="button" onClick={() => setEnv(env.filter((_, itemIndex) => itemIndex !== index))}>Remove</button>
          </div>
        ))}
        <div className="row-actions">
          <button className="ghost" type="button" onClick={() => setEnv([...env, { key: "", value: "" }])}>Add variable</button>
          <button className="primary" type="submit" disabled={busy}>Save environment</button>
        </div>
      </form>

      {!self && (
        <form onSubmit={(event) => void savePassword(event)}>
          <h3>Password</h3>
          <label>
            New password
            <input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          </label>
          <label>
            Confirm password
            <input type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} required />
          </label>
          <button className="primary" type="submit" disabled={busy}>Change password</button>
        </form>
      )}

      {!self && (
        <div className="remove-account">
          <h3>Remove account</h3>
          <p className="muted">This deletes the Linux account for {username} and leaves their home directory in place.</p>
          {confirmRemove ? (
            <div className="row-actions">
              <button className="danger" type="button" disabled={busy} onClick={() => void remove()}>Confirm removal</button>
              <button className="ghost" type="button" disabled={busy} onClick={() => setConfirmRemove(false)}>Cancel</button>
            </div>
          ) : (
            <button className="danger" type="button" disabled={busy} onClick={() => setConfirmRemove(true)}>Remove account</button>
          )}
        </div>
      )}
    </div>
  );
}

function ServerPanel() {
  const [overview, setOverview] = useState<ServerOverview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      setOverview(await serverOverview());
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }, []);

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
      <p className="alert" role="alert">{error}</p>
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
        {choices.map((choice) => <option key={choice.id} value={choice.id}>{choice.name}</option>)}
      </select>
    </label>
  );
}

function agentFlags(agents: AgentId[]): Record<AgentId, boolean> {
  return {
    cursor: agents.includes("cursor"),
    claude: agents.includes("claude"),
    pi: agents.includes("pi"),
  };
}
