import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AgentId, ChatMeta } from "@engineroom/protocol";
import { agentLabel } from "@engineroom/protocol";
import { createChat, getSettings } from "../api.ts";
import { message } from "../format.ts";
import { IconArrow } from "../icons.tsx";

export function StartView({
  agents,
  workspace,
  targetLabel,
  onStarted,
}: {
  agents: AgentId[];
  workspace: string;
  targetLabel: string;
  onStarted: (chat: ChatMeta, prompt: string) => void;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  const [agent, setAgent] = useState<AgentId>(agents[0] || "cursor");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getSettings().then((next) => {
      setAgent(agents.includes(next.defaultAgent) ? next.defaultAgent : agents[0] || next.defaultAgent);
      setModel(next.defaultModel);
    }).catch((err) => setError(message(err)));
  }, [agents]);

  useEffect(() => {
    box.current?.focus();
  }, [workspace]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || busy) return;
    setBusy(true);
    setError("");
    try {
      const chat = await createChat({ agent, model, workspace });
      onStarted(chat, text);
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }

  return (
    <div className="start">
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
              <select aria-label="Agent" value={agent} onChange={(event) => setAgent(event.target.value as AgentId)}>
                {agents.map((item) => <option key={item} value={item}>{agentLabel(item)}</option>)}
              </select>
            </label>
          )}
          <label className="chip">
            Model
            <input aria-label="Model" value={model} placeholder="default" onChange={(event) => setModel(event.target.value)} />
          </label>
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
