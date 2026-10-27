import { useRef, useState } from "react";

interface PromptStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const memory = new Map<string, { prompt: string; attachments: unknown[] }>();
const STORAGE_PREFIX = "engineroom.draft.";

export function readDraft<T>(key: string): { prompt: string; attachments: T[] } {
  const cached = memory.get(key);
  if (cached) return { prompt: cached.prompt, attachments: cached.attachments as T[] };
  return { prompt: readStoredPrompt(key), attachments: [] };
}

export function writeDraft<T>(key: string, prompt: string, attachments: T[]) {
  if (!prompt && attachments.length === 0) {
    memory.delete(key);
    removeStoredPrompt(key);
    return;
  }
  memory.set(key, { prompt, attachments });
  if (prompt) storePrompt(key, prompt);
  else removeStoredPrompt(key);
}

export function clearDraft(key: string) {
  memory.delete(key);
  removeStoredPrompt(key);
}

export function useComposerDraft<T>(key: string) {
  const [storedKey, setStoredKey] = useState(key);
  const [prompt, setPromptState] = useState(() => readDraft<T>(key).prompt);
  const [attachments, setAttachmentsState] = useState(() => readDraft<T>(key).attachments);
  let shownPrompt = prompt;
  let shownAttachments = attachments;
  if (key !== storedKey) {
    const draft = readDraft<T>(key);
    shownPrompt = draft.prompt;
    shownAttachments = draft.attachments;
    setStoredKey(key);
    setPromptState(draft.prompt);
    setAttachmentsState(draft.attachments);
  }
  const promptRef = useRef(shownPrompt);
  const attachmentsRef = useRef(shownAttachments);
  promptRef.current = shownPrompt;
  attachmentsRef.current = shownAttachments;

  function setPrompt(value: string) {
    promptRef.current = value;
    setPromptState(value);
    writeDraft(key, value, attachmentsRef.current);
  }

  function setAttachments(items: T[]) {
    attachmentsRef.current = items;
    setAttachmentsState(items);
    writeDraft(key, promptRef.current, items);
  }

  function clear() {
    promptRef.current = "";
    attachmentsRef.current = [];
    setPromptState("");
    setAttachmentsState([]);
    clearDraft(key);
  }

  return { prompt: shownPrompt, setPrompt, attachments: shownAttachments, setAttachments, clear };
}

function promptStorage(): PromptStorage | null {
  const host = globalThis as { sessionStorage?: PromptStorage };
  return host.sessionStorage ?? null;
}

function storageKey(key: string) {
  return `${STORAGE_PREFIX}${key}`;
}

function readStoredPrompt(key: string): string {
  try {
    return promptStorage()?.getItem(storageKey(key)) ?? "";
  } catch {
    return "";
  }
}

function storePrompt(key: string, prompt: string) {
  try {
    promptStorage()?.setItem(storageKey(key), prompt);
  } catch {
    /* storage can be blocked */
  }
}

function removeStoredPrompt(key: string) {
  try {
    promptStorage()?.removeItem(storageKey(key));
  } catch {
    /* storage can be blocked */
  }
}
