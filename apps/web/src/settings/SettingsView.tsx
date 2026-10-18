import { useEffect, useState, type FormEvent } from "react";
import type { AgentId, AgentOptionChoice, Settings, ThemePreference } from "@engineroom/protocol";
import { agentLabel } from "@engineroom/protocol";
import { getSettings, saveSettings } from "../api.ts";
import { message } from "../format.ts";

export function SettingsView({
  agents,
  options,
  onTheme,
  onSaved,
}: {
  agents: AgentId[];
  options: Partial<Record<AgentId, { modes: AgentOptionChoice[]; models: AgentOptionChoice[] }>>;
  onTheme: (theme: ThemePreference) => void;
  onSaved: (theme: ThemePreference) => void;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getSettings().then((next) => {
      const agent = agents.includes(next.defaultAgent) ? next.defaultAgent : agents[0] || next.defaultAgent;
      const models = options[agent]?.models ?? [];
      const defaultModel = models.some((model) => model.id === next.defaultModel) ? next.defaultModel : models[0]?.id || "";
      setSettings({
        ...next,
        defaultAgent: agent,
        defaultModel,
        permission: next.permission || "ask",
        theme: next.theme === "light" ? "light" : "dark",
      });
    }).catch((err) => setError(message(err)));
  }, [agents, options]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!settings) return;
    setBusy(true);
    setSaved("");
    setError("");
    try {
      const savedSettings = await saveSettings(settings);
      setSettings(savedSettings);
      onSaved(savedSettings.theme === "light" ? "light" : "dark");
      setSaved("Saved");
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  function chooseAgent(agent: Settings["defaultAgent"]) {
    if (!settings) return;
    const models = options[agent]?.models ?? [];
    const defaultModel = models.some((model) => model.id === settings.defaultModel) ? settings.defaultModel : models[0]?.id || "";
    setSettings({ ...settings, defaultAgent: agent, defaultModel });
  }

  if (!settings) return <p className="settings muted">Loading settings…</p>;
  const models = options[settings.defaultAgent]?.models ?? [];
  return (
    <form className="settings" onSubmit={submit}>
      <p className="eyebrow">Customize</p>
      <h2>Appearance</h2>
      <label>
        Theme
        <select
          value={settings.theme === "light" ? "light" : "dark"}
          onChange={(event) => {
            const theme: ThemePreference = event.target.value === "light" ? "light" : "dark";
            setSettings({ ...settings, theme });
            onTheme(theme);
          }}
        >
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </label>
      <h2>Defaults for new chats</h2>
      <label>
        Default agent
        <select
          value={settings.defaultAgent}
          onChange={(event) => chooseAgent(event.target.value as Settings["defaultAgent"])}
        >
          {agents.map((item) => <option key={item} value={item}>{agentLabel(item)}</option>)}
        </select>
      </label>
      {models.length > 0 && (
        <label>
          Default model
          <select
            value={settings.defaultModel}
            onChange={(event) => setSettings({ ...settings, defaultModel: event.target.value })}
          >
            {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
          </select>
        </label>
      )}
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
        {agents.map((agent) => {
          const locked = settings.lockedBinaries?.includes(agent) ?? false;
          return (
            <label key={agent}>
              {agentLabel(agent)}
              <input
                value={settings.binaries[agent] || ""}
                placeholder="Absolute path, or blank to use PATH"
                disabled={locked}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    binaries: { ...settings.binaries, [agent]: event.target.value },
                  })
                }
              />
              {locked && <span className="muted">Set by the administrator</span>}
            </label>
          );
        })}
      </details>
      <p className="alert" role="alert">{error}</p>
      {saved && <p className="muted">{saved}</p>}
      <button className="primary" type="submit" disabled={busy}>Save</button>
    </form>
  );
}
