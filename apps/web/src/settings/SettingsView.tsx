import { useEffect, useState, type FormEvent } from "react";
import type { AgentId, Settings } from "@engineroom/protocol";
import { agentLabel } from "@engineroom/protocol";
import { getSettings, saveSettings } from "../api.ts";
import { message } from "../format.ts";

export function SettingsView({ agents }: { agents: AgentId[] }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getSettings().then((next) => {
      const agent = agents.includes(next.defaultAgent) ? next.defaultAgent : agents[0] || next.defaultAgent;
      setSettings({ ...next, defaultAgent: agent, permission: next.permission || "ask" });
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
