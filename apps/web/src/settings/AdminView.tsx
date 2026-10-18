import { useEffect, useState, type FormEvent } from "react";
import { AGENTS, agentLabel, type AgentId } from "@engineroom/protocol";
import {
  addAccount,
  listAccounts,
  listUserRepositories,
  revokeAccount,
  saveAgents,
  saveUserRepositories,
  type Account,
  type Session,
} from "../api.ts";
import { message } from "../format.ts";
import type { RepositoryEntry } from "@engineroom/protocol";

export function AdminView({
  session,
  onAgents,
  onRepos,
}: {
  session: Session;
  onAgents: (agents: AgentId[], rawTerminal: boolean) => void;
  onRepos: () => void;
}) {
  const [flags, setFlags] = useState<Record<AgentId, boolean>>(() => agentFlags(session.agents));
  const [rawTerminal, setRawTerminal] = useState(session.rawTerminal);
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
      const savedAgents = await saveAgents(flags, rawTerminal);
      onAgents(savedAgents.agents, savedAgents.rawTerminal ?? rawTerminal);
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
        <label className="check">
          <input type="checkbox" checked={rawTerminal} onChange={() => setRawTerminal((value) => !value)} />
          Raw terminal
        </label>
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
          <input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
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
