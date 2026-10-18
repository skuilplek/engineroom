import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  AGENTS,
  agentLabel,
  type AgentId,
  type CatalogEntry,
  type EnvEntry,
  type Settings,
  type UserPolicy,
} from "@engineroom/protocol";
import {
  addAccount,
  addCatalog,
  changePassword,
  getUserAccess,
  listAccounts,
  listCatalog,
  removeAccount,
  removeCatalog,
  saveAgents,
  saveUserEnv,
  saveUserGrants,
  saveUserPolicy,
  saveUserSettings,
  serverOverview,
  type Account,
  type ServerOverview,
  type Session,
} from "../api.ts";
import { message } from "../format.ts";

export function AdminView({
  session,
  onAgents,
  onAccess,
}: {
  session: Session;
  onAgents: (agents: AgentId[], rawTerminal: boolean) => void;
  onAccess: () => void;
}) {
  const [flags, setFlags] = useState<Record<AgentId, boolean>>(() => agentFlags(session.agents));
  const [rawTerminal, setRawTerminal] = useState(session.rawTerminal);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [selected, setSelected] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [repoName, setRepoName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
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
    listCatalog().then((body) => setCatalog(body.repositories)).catch((err) => setError(message(err)));
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
      const savedAgents = await saveAgents(flags, rawTerminal);
      onAgents(savedAgents.agents, savedAgents.rawTerminal ?? rawTerminal);
      setSaved("Agents saved");
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

  return (
    <div className="settings">
      <ServerPanel />
      <form onSubmit={(event) => void saveAgentList(event)}>
        <h2>Available agents</h2>
        <p className="muted">These are the agents this machine offers. A person can only use the ones you also allow for them.</p>
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
        <button className="primary" type="submit" disabled={busy}>Save agents</button>
      </form>

      <form onSubmit={(event) => void addRepo(event)}>
        <h2>Repository catalog</h2>
        <p className="muted">Add a git remote here, then grant it to a person. Granting clones it into their Sites directory. Removing it from the catalog leaves an existing checkout until you save that person again.</p>
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

      <section className="people">
        <h2>People</h2>
        <p className="muted">Choose a person to set their agents, terminal, repositories, environment, and password. Removing an account deletes the Linux user and keeps their home directory.</p>
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
        {selected && (
          <PersonPanel
            key={selected}
            username={selected}
            self={selected === session.username}
            globalAgents={session.agents}
            globalTerminal={session.rawTerminal}
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
        )}
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
      <p className="alert" role="alert">{error}</p>
      {saved && <p className="muted">{saved}</p>}
    </div>
  );
}

function PersonPanel({
  username,
  self,
  globalAgents,
  globalTerminal,
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
      const savedPolicy = await saveUserPolicy(username, { ...policy, binaries });
      setPolicy(savedPolicy);
      const savedSettings = await saveUserSettings(username, {
        defaultAgent: settings.defaultAgent,
        defaultModel: settings.defaultModel,
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

  if (!policy || !settings || !env) return <p className="muted">Loading {username}…</p>;
  const allowed = policy.agents.filter((agent) => globalAgents.includes(agent));
  return (
    <div className="person-panel">
      <h3>{username}</h3>
      <form onSubmit={(event) => void saveAccess(event)}>
        <p className="muted">Agents, the terminal, defaults, and repositories for this person.</p>
        {globalAgents.map((agent) => (
          <label className="check" key={agent}>
            <input type="checkbox" checked={policy.agents.includes(agent)} onChange={() => toggleAgent(agent)} />
            {agentLabel(agent)}
          </label>
        ))}
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
        <label>
          Default agent
          <select
            value={settings.defaultAgent}
            onChange={(event) => setSettings({ ...settings, defaultAgent: event.target.value as AgentId })}
          >
            {allowed.map((agent) => <option key={agent} value={agent}>{agentLabel(agent)}</option>)}
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
    <section className="server-panel">
      <p className="eyebrow">Admin</p>
      <h2>Server</h2>
      <p className="muted">
        {overview
          ? `${overview.host.hostname} · ${overview.host.platform} ${overview.host.arch} · ${overview.host.node} · up ${formatUptime(overview.host.uptimeSeconds)}`
          : "Checking this machine."}
      </p>
      {overview && (
        <div className="accounts">
          <div className="account">
            <div>
              <strong>Memory</strong>
              <span>{formatBytes(overview.host.memoryFree)} free of {formatBytes(overview.host.memoryTotal)}</span>
            </div>
          </div>
          {overview.disks.map((disk) => (
            <div className="account" key={disk.path}>
              <div>
                <strong>{disk.path}</strong>
                <span>{formatBytes(disk.free)} free of {formatBytes(disk.total)}</span>
              </div>
            </div>
          ))}
          {overview.commands.map((command) => (
            <div className="account" key={command.name}>
              <div>
                <strong>{command.name}</strong>
                <span className={command.available ? undefined : "missing"}>{command.path ?? "Missing"}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      {overview && <p className="muted">Commands are read from {overview.configFile}.</p>}
      <p className="alert" role="alert">{error}</p>
      <button className="ghost" type="button" disabled={busy} onClick={() => void load()}>{busy ? "Checking…" : "Refresh"}</button>
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

function agentFlags(agents: AgentId[]): Record<AgentId, boolean> {
  return {
    cursor: agents.includes("cursor"),
    claude: agents.includes("claude"),
    pi: agents.includes("pi"),
  };
}
