import { useEffect, useState, type FormEvent } from "react";
import type { AgentId, AgentOptionChoice, Settings, SettingsPatch, ThemePreference } from "@engineroom/protocol";
import { agentLabel } from "@engineroom/protocol";
import { getSettings, saveSettings } from "../api.ts";
import { message } from "../format.ts";
import { normalizeTheme, THEME_CATALOG } from "../theme.ts";

export function SettingsView({
  agents,
  agentCatalog,
  options,
  fileEditorAllowed = true,
  onTheme,
  onSaved,
}: {
  agents: AgentId[];
  agentCatalog?: { id: string; label: string }[];
  options: Partial<Record<AgentId, { modes: AgentOptionChoice[]; models: AgentOptionChoice[] }>>;
  fileEditorAllowed?: boolean;
  onTheme: (theme: ThemePreference) => void;
  onSaved: (theme: ThemePreference, filesReadOnly: boolean) => void;
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
        theme: normalizeTheme(next.theme),
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
      const savedSettings = await saveSettings(settingsPayload(settings, agents));
      const nextTheme = normalizeTheme(savedSettings.theme);
      setSettings({ ...savedSettings, theme: nextTheme });
      onSaved(nextTheme, Boolean(savedSettings.filesReadOnly));
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

  function selectTheme(theme: ThemePreference) {
    if (!settings) return;
    setSettings({ ...settings, theme });
    onTheme(theme);
  }

  if (!settings) return <p className="settings muted">Loading settings…</p>;
  const models = options[settings.defaultAgent]?.models ?? [];
  const activeTheme = normalizeTheme(settings.theme);

  return (
    <form className="settings" onSubmit={submit}>
      <p className="eyebrow">Customize</p>
      <h2>Appearance</h2>
      <p className="muted theme-lede">
        Choose a prebuilt theme for your workspace. Select any simple or elaborate theme and save to make it your default.
      </p>
      <div className="theme-grid" role="radiogroup" aria-label="Theme">
        {THEME_CATALOG.map((item) => {
          const selected = activeTheme === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={selected}
              className={selected ? `theme-card theme-card-${item.id} active` : `theme-card theme-card-${item.id}`}
              onClick={() => selectTheme(item.id)}
            >
              <div
                className="theme-preview"
                style={{
                  background: item.swatches.bg,
                  borderColor: item.swatches.border,
                }}
                aria-hidden="true"
              >
                <div
                  className="theme-preview-sidebar"
                  style={{
                    background: item.swatches.sidebar,
                    borderRightColor: item.swatches.border,
                  }}
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
                    {item.default ? "Default" : item.tier}
                  </span>
                </div>
                <span className="theme-tagline">{item.tagline}</span>
              </div>
            </button>
          );
        })}
      </div>
      <h2>Defaults for new chats</h2>
      {agents.length === 0 ? (
        <p className="muted">No agents available</p>
      ) : (
        <>
          <label>
            Default agent
            <select
              value={agents.includes(settings.defaultAgent) ? settings.defaultAgent : agents[0]}
              onChange={(event) => chooseAgent(event.target.value as Settings["defaultAgent"])}
            >
              {agents.map((item) => <option key={item} value={item}>{agentLabel(item, agentCatalog)}</option>)}
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
        </>
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
      <label className="check">
        <input
          type="checkbox"
          checked={!fileEditorAllowed || Boolean(settings.filesReadOnly)}
          disabled={!fileEditorAllowed}
          onChange={(event) => setSettings({ ...settings, filesReadOnly: event.target.checked })}
        />
        Read-only file viewer
      </label>
      {!fileEditorAllowed && (
        <p className="muted">File editing is turned off by your administrator.</p>
      )}
      <details>
        <summary>CLI paths</summary>
        {agents.map((agent) => {
          const locked = settings.lockedBinaries?.includes(agent) ?? false;
          return (
            <label key={agent}>
              {agentLabel(agent, agentCatalog)}
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

function settingsPayload(settings: Settings, agents: AgentId[]): SettingsPatch {
  const { defaultAgent, defaultModel, lockedBinaries: _locked, ...rest } = settings;
  if (!agents.includes(defaultAgent)) return rest;
  return { ...rest, defaultAgent, defaultModel };
}
