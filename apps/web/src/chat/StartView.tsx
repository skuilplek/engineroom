import { useEffect, useState, type FormEvent } from "react";
import type { AgentId, AgentOptionChoice, ChatMeta } from "@engineroom/protocol";
import { agentLabel } from "@engineroom/protocol";
import { createChat, getSettings, type Session } from "../api.ts";
import { PiSetupNotice } from "../settings/PiSetup.tsx";
import { FilesPaneToggle } from "../files/FilesPaneToggle.tsx";
import { message } from "../format.ts";
import { Composer } from "./Composer.tsx";

export function StartView({
  agents,
  agentCatalog,
  options,
  workspace,
  targetLabel,
  onStarted,
  filesOpen,
  onToggleFiles,
  username,
  piSetup = false,
  piLoginHint = false,
  onSession,
  projectCreate,
  onReposChanged,
  onBranchChanged,
}: {
  agents: AgentId[];
  agentCatalog?: { id: string; label: string }[];
  options: Partial<Record<AgentId, { modes: AgentOptionChoice[]; models: AgentOptionChoice[] }>>;
  workspace: string;
  targetLabel: string;
  onStarted: (chat: ChatMeta, prompt: string) => void;
  filesOpen?: boolean;
  onToggleFiles?: () => void;
  username: string;
  piSetup?: boolean;
  piLoginHint?: boolean;
  onSession?: (session: Session) => void;
  projectCreate: boolean;
  onReposChanged?: () => void;
  onBranchChanged?: () => void;
}) {
  const [agent, setAgent] = useState<AgentId | "">(agents[0] || "");
  const [mode, setMode] = useState("");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (agents.length === 0) {
      setAgent("");
      setMode("");
      setModel("");
      return;
    }
    getSettings().then((next) => {
      const chosen = agents.includes(next.defaultAgent) ? next.defaultAgent : agents[0];
      if (!chosen) return;
      const modes = options[chosen]?.modes ?? [];
      const models = options[chosen]?.models ?? [];
      setAgent(chosen);
      setMode(modes[0]?.id || "");
      setModel(models.some((item) => item.id === next.defaultModel) ? next.defaultModel : models[0]?.id || "");
    }).catch((err) => setError(message(err)));
  }, [agents, options]);

  const modes = options[agent]?.modes ?? [];
  const models = options[agent]?.models ?? [];

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || busy || !agent) return;
    setBusy(true);
    setError("");
    try {
      const chat = await createChat({
        agent,
        mode: modes.length > 0 ? mode : "",
        model: models.length > 0 ? model : "",
        workspace,
      });
      onStarted(chat, text);
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }

  function chooseAgent(next: AgentId) {
    const availableModes = options[next]?.modes ?? [];
    const available = options[next]?.models ?? [];
    setAgent(next);
    setMode(availableModes.some((item) => item.id === mode) ? mode : availableModes[0]?.id || "");
    setModel(available.some((item) => item.id === model) ? model : available[0]?.id || "");
  }

  return (
    <div className="start">
      {onToggleFiles && !filesOpen && (
        <div className="start-topbar">
          <FilesPaneToggle filesOpen={filesOpen} onToggle={onToggleFiles} />
        </div>
      )}
      <h1>Let's Start Building!</h1>
      <Composer
        frame="launch"
        prompt={prompt}
        onPrompt={setPrompt}
        placeholder="What do you want to build?"
        username={username}
        disabled={busy || !agent || !prompt.trim()}
        onSubmit={(event) => void submit(event)}
        modes={modes}
        mode={mode}
        onMode={setMode}
        models={models}
        model={model}
        onModel={setModel}
        workspace={workspace}
        projectCreate={projectCreate}
        onReposChanged={onReposChanged}
        onBranchChanged={onBranchChanged}
        error={error}
      >
        {agents.length === 0 && <p className="muted">No agents available</p>}
        {piSetup && onSession && <PiSetupNotice loginHint={piLoginHint} onReady={onSession} />}
        {agents.length > 1 && (
          <select aria-label="Agent" value={agent} onChange={(event) => chooseAgent(event.target.value as AgentId)}>
            {agents.map((item) => <option key={item} value={item}>{agentLabel(item, agentCatalog)}</option>)}
          </select>
        )}
      </Composer>
      <p className="context-line">{targetLabel}</p>
    </div>
  );
}
