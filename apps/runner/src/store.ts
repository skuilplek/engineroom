import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applySettings,
  CHAT_ID_RE,
  cleanModel,
  DEFAULT_SETTINGS,
  isAgentId,
  type AgentId,
  type ChatDetail,
  type ChatMeta,
  type RepositoryEntry,
  type Settings,
  type SettingsPatch,
  type TranscriptEntry,
} from "@engineroom/protocol";
import { isGitRepository, listGitRepositories, repositoryPathAllowed, resolveWorkspace } from "./workspace.ts";

export function dataRoot(home: string): string {
  return path.join(home, ".engineroom");
}

export async function ensureRoot(home: string): Promise<string> {
  const root = dataRoot(home);
  await mkdir(path.join(root, "chats"), { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  return root;
}

export async function loadSettings(home: string): Promise<Settings> {
  const file = path.join(dataRoot(home), "settings.json");
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<Settings>;
    const patch: SettingsPatch = {};
    if (isAgentId(parsed.defaultAgent)) patch.defaultAgent = parsed.defaultAgent;
    if (typeof parsed.defaultModel === "string") {
      try {
        patch.defaultModel = cleanModel(parsed.defaultModel);
      } catch {
        patch.defaultModel = "";
      }
    }
    if (parsed.binaries && typeof parsed.binaries === "object") patch.binaries = parsed.binaries;
    return applySettings(DEFAULT_SETTINGS, patch);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_SETTINGS, binaries: {} };
    if (error instanceof SyntaxError) return { ...DEFAULT_SETTINGS, binaries: {} };
    throw error;
  }
}

export async function saveSettings(home: string, patch: SettingsPatch): Promise<Settings> {
  await ensureRoot(home);
  const next = applySettings(await loadSettings(home), patch);
  await writeAtomic(path.join(dataRoot(home), "settings.json"), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export async function listRepositories(home: string): Promise<RepositoryEntry[]> {
  const [found, enabled] = await Promise.all([listGitRepositories(home), loadEnabledRepositories(home)]);
  return found.map((entry) => ({ ...entry, enabled: enabled.has(entry.path) }));
}

export async function setEnabledRepositories(home: string, requested: string[]): Promise<RepositoryEntry[]> {
  const homeReal = await realpath(home);
  const enabled: string[] = [];
  for (const raw of requested) {
    const resolved = await resolveWorkspace(home, raw);
    if (resolved === homeReal || !repositoryPathAllowed(homeReal, resolved) || !(await isGitRepository(resolved))) {
      throw new Error("invalid repository");
    }
    if (!enabled.includes(resolved)) enabled.push(resolved);
  }
  await ensureRoot(home);
  await writeAtomic(repositoriesFile(home), `${JSON.stringify({ enabled }, null, 2)}\n`);
  return listRepositories(home);
}

export async function createChat(
  home: string,
  input: { agent?: AgentId; model?: string; workspace?: string; title?: string },
): Promise<ChatMeta> {
  const settings = await loadSettings(home);
  const workspace = await resolveChatWorkspace(home, input.workspace);
  const now = new Date().toISOString();
  const agent = input.agent ?? settings.defaultAgent;
  const chat: ChatMeta = {
    id: randomUUID(),
    title: input.title?.trim() || "New chat",
    agent,
    model: input.model ?? settings.defaultModel,
    workspace,
    agentSessionId: agent === "pi" ? newPiSessionId() : null,
    createdAt: now,
    updatedAt: now,
  };
  const dir = chatDir(home, chat.id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeAtomic(path.join(dir, "meta.json"), `${JSON.stringify(chat, null, 2)}\n`);
  await writeFile(path.join(dir, "transcript.jsonl"), "", { mode: 0o600 });
  return chat;
}

export async function listChats(home: string, running: Set<string>): Promise<ChatMeta[]> {
  const dir = path.join(dataRoot(home), "chats");
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const chats: ChatMeta[] = [];
  for (const name of names) {
    if (!CHAT_ID_RE.test(name)) continue;
    try {
      const chat = await readMeta(home, name);
      chat.running = running.has(chat.id);
      chats.push(chat);
    } catch {
      continue;
    }
  }
  chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return chats;
}

export async function getChat(home: string, chatId: string, running: boolean): Promise<ChatDetail> {
  const chat = await readMeta(home, chatId);
  chat.running = running;
  const transcript = await readTranscript(home, chatId);
  return { chat, transcript };
}

export async function updateChat(home: string, chatId: string, patch: Partial<ChatMeta>): Promise<ChatMeta> {
  const chat = await readMeta(home, chatId);
  const next: ChatMeta = {
    ...chat,
    ...patch,
    id: chat.id,
    agent: chat.agent,
    createdAt: chat.createdAt,
    updatedAt: new Date().toISOString(),
  };
  delete next.running;
  await writeAtomic(path.join(chatDir(home, chatId), "meta.json"), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export async function appendTranscript(home: string, chatId: string, entry: TranscriptEntry): Promise<void> {
  await appendFile(path.join(chatDir(home, chatId), "transcript.jsonl"), `${JSON.stringify(entry)}\n`, {
    mode: 0o600,
  });
}

async function readMeta(home: string, chatId: string): Promise<ChatMeta> {
  const raw = await readFile(path.join(chatDir(home, chatId), "meta.json"), "utf8");
  const chat = JSON.parse(raw) as ChatMeta;
  if (chat.id !== chatId) throw new Error("chat id mismatch");
  return chat;
}

async function readTranscript(home: string, chatId: string): Promise<TranscriptEntry[]> {
  const file = path.join(chatDir(home, chatId), "transcript.jsonl");
  let raw: string;
  try {
    const info = await stat(file);
    if (info.size > 8_000_000) {
      const handle = await readFile(file);
      raw = handle.subarray(handle.length - 8_000_000).toString("utf8");
      const cut = raw.indexOf("\n");
      raw = cut >= 0 ? raw.slice(cut + 1) : raw;
    } else {
      raw = await readFile(file, "utf8");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries: TranscriptEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as TranscriptEntry);
    } catch {
      continue;
    }
  }
  return entries;
}

async function resolveChatWorkspace(home: string, requested?: string): Promise<string> {
  const homeReal = await realpath(home);
  const workspace = await resolveWorkspace(home, requested);
  if (workspace === homeReal) return workspace;
  const enabled = await loadEnabledRepositories(home);
  if (!repositoryPathAllowed(homeReal, workspace) || !enabled.has(workspace) || !(await isGitRepository(workspace))) {
    throw new Error("repository is not enabled");
  }
  return workspace;
}

async function loadEnabledRepositories(home: string): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(await readFile(repositoriesFile(home), "utf8")) as { enabled?: unknown };
    if (!Array.isArray(parsed.enabled)) return new Set();
    return new Set(parsed.enabled.filter((item): item is string => typeof item === "string" && item.startsWith("/")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    if (error instanceof SyntaxError) return new Set();
    throw error;
  }
}

function repositoriesFile(home: string): string {
  return path.join(dataRoot(home), "repositories.json");
}

function chatDir(home: string, chatId: string): string {
  if (!CHAT_ID_RE.test(chatId)) throw new Error("invalid chat id");
  return path.join(dataRoot(home), "chats", chatId);
}

async function writeAtomic(file: string, contents: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, contents, { mode: 0o600 });
  await rename(tmp, file);
}

function newPiSessionId(): string {
  return `er${randomUUID().replace(/-/g, "")}`;
}
