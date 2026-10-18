import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AgentId, AgentOptionChoice, ChatMeta } from "@engineroom/protocol";
import { agentLabel } from "@engineroom/protocol";
import { createChat, getSettings } from "../api.ts";
import { message } from "../format.ts";
import { IconArrow, IconPanelRight } from "../icons.tsx";

export function StartView({
  agents,
  options,
  workspace,
  targetLabel,
  onStarted,
  filesOpen,
  onToggleFiles,
}: {
  agents: AgentId[];
  options: Partial<Record<AgentId, { modes: AgentOptionChoice[]; models: AgentOptionChoice[] }>>;
  workspace: string;
  targetLabel: string;
  onStarted: (chat: ChatMeta, prompt: string) => void;
  filesOpen?: boolean;
  onToggleFiles?: () => void;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  const [agent, setAgent] = useState<AgentId>(agents[0] || "cursor");
  const [mode, setMode] = useState("");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getSettings().then((next) => {
      const chosen = agents.includes(next.defaultAgent) ? next.defaultAgent : agents[0] || next.defaultAgent;
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
    if (!text || busy) return;
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
      {onToggleFiles && (
        <div className="start-topbar">
          <button
            className={filesOpen ? "ghost icon-toggle active" : "ghost icon-toggle"}
            type="button"
            aria-pressed={Boolean(filesOpen)}
            aria-label={filesOpen ? "Hide repository files" : "Show repository files"}
            title={filesOpen ? "Hide repository files" : "Show repository files"}
            onClick={onToggleFiles}
          >
            <IconPanelRight />
            <span>Files</span>
          </button>
        </div>
      )}
      <h1>Let's Start Building!</h1>
      <form className="launch" onSubmit={(event) => void submit(event)}>
        <textarea
          ref={box}
          value={prompt}
          placeholder="What do you want to build?"
          aria-label="What do you want to build?"
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="launch-bar">
          {agents.length > 1 && (
            <label className="chip">
              <select aria-label="Agent" value={agent} onChange={(event) => chooseAgent(event.target.value as AgentId)}>
                {agents.map((item) => <option key={item} value={item}>{agentLabel(item)}</option>)}
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
          <button className="send" type="submit" disabled={busy || !prompt.trim()} aria-label="Send">
            <IconArrow />
          </button>
        </div>
        {error && <p className="alert" role="alert">{error}</p>}
      </form>
      <p className="context-line">{targetLabel}</p>
    </div>
  );
}
