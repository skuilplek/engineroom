import { MAX_PI_SYSTEM_PROMPT_BYTES } from "@engineroom/protocol";

export interface PiSystemPromptDraft {
  systemPrompt: string;
  appendSystemPrompt: string;
}

function size(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function PromptSize({ text }: { text: string }) {
  const bytes = size(text);
  const tooLarge = bytes > MAX_PI_SYSTEM_PROMPT_BYTES;
  return (
    <p className={tooLarge ? "muted danger" : "muted"}>
      {bytes} of {MAX_PI_SYSTEM_PROMPT_BYTES} bytes{tooLarge ? ". Shorten this before saving." : ""}
    </p>
  );
}

/**
 * Pi reads SYSTEM.md and APPEND_SYSTEM.md from its agent directory. SYSTEM.md
 * replaces the built-in prompt, so an empty box leaves Pi's own prompt alone.
 */
export function PiSystemPromptFields({
  value,
  onChange,
}: {
  value: PiSystemPromptDraft;
  onChange: (value: PiSystemPromptDraft) => void;
}) {
  return (
    <>
      <label>
        System prompt
        <textarea
          aria-label="Pi system prompt"
          rows={10}
          value={value.systemPrompt}
          spellCheck={false}
          onChange={(event) => onChange({ ...value, systemPrompt: event.target.value })}
        />
      </label>
      <PromptSize text={value.systemPrompt} />
      <p className="muted">
        Replaces the instructions Pi starts with. Leave it empty to keep Pi's own prompt. A trusted project with
        its own .pi/SYSTEM.md takes precedence over this file.
      </p>
      <label>
        Appended instructions
        <textarea
          aria-label="Pi appended system prompt"
          rows={8}
          value={value.appendSystemPrompt}
          spellCheck={false}
          onChange={(event) => onChange({ ...value, appendSystemPrompt: event.target.value })}
        />
      </label>
      <PromptSize text={value.appendSystemPrompt} />
      <p className="muted">
        Added after the system prompt, so Pi's default instructions stay. Both files live in ~/.pi/agent. Each
        prompt starts Pi again, so a save applies to the next prompt you send.
      </p>
    </>
  );
}
