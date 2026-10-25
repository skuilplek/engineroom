import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AgentId, AgentOptionChoice, ChatMeta } from "@engineroom/protocol";
import { agentLabel } from "@engineroom/protocol";
import { createChat, getSettings } from "../api.ts";
import { FilesPaneToggle } from "../files/FilesPaneToggle.tsx";
import { message } from "../format.ts";
import { IconArrow } from "../icons.tsx";
import { usePromptHeight } from "./promptHeight.ts";

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
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  const promptHeight = usePromptHeight(username);
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

  useEffect(() => {
    box.current?.focus();
  }, [workspace]);

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
      <form className="launch" onSubmit={(event) => void submit(event)}>
        <textarea
          ref={box}
          style={promptHeight.style}
          value={prompt}
          placeholder="What do you want to build?"
          aria-label="What do you want to build?"
          onPointerDown={promptHeight.onPointerDown}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="launch-bar">
          {agents.length === 0 && <p className="muted">No agents available</p>}
          {agents.length > 1 && (
            <label className="chip">
              <select aria-label="Agent" value={agent} onChange={(event) => chooseAgent(event.target.value as AgentId)}>
                {agents.map((item) => <option key={item} value={item}>{agentLabel(item, agentCatalog)}</option>)}
              </select>
            </label>
          )}
          {modes.length > 0 && (
            <label className="chip">
              Mode
              <select aria-label="Mode" value={mode} onChange={(event) => setMode(event.target.value)}>
                {modes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
          )}
          {models.length > 0 && (
            <label className="chip">
              Model
              <select aria-label="Model" value={model} onChange={(event) => setModel(event.target.value)}>
                {models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
          )}
          <button className="send" type="submit" disabled={busy || !agent || !prompt.trim()} aria-label="Send">
            <IconArrow />
          </button>
        </div>
        {error && <p className="alert" role="alert">{error}</p>}
      </form>
      <p className="context-line">{targetLabel}</p>
    </div>
  );
}
