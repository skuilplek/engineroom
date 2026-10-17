import { spawnSync } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { chmod, unlink } from "node:fs/promises";
import { peerCredentials } from "@engineroom/peercred";
import {
  assertChatId,
  parseRunnerRequest,
  titleFromPrompt,
  type AgentId,
  type ChatMeta,
  type RunnerResponse,
  type StreamEvent,
  type TranscriptEntry,
} from "@engineroom/protocol";
import { defaultDrivers, type AgentDriver } from "./drivers.ts";
import { appendTranscript, createChat, getChat, listChats, loadSettings, saveSettings, updateChat } from "./store.ts";
import { listWorkspaces } from "./workspace.ts";

export interface RunnerOptions {
  home: string;
  socketPath?: string;
  fd?: number;
  drivers?: Record<AgentId, AgentDriver>;
  peerCheck?: (socket: Socket) => void;
  hubUser?: string;
}

export interface RunningRunner {
  server: Server;
  close: () => Promise<void>;
}

export async function startRunner(options: RunnerOptions): Promise<RunningRunner> {
  const home = options.home;
  const drivers = options.drivers ?? defaultDrivers();
  const runs = new Map<string, AbortController>();
  const hubUser = options.hubUser ?? process.env.ENGINEROOM_HUB_USER ?? "engineroom";

  const server = createServer((socket) => {
    void handleConnection(socket).catch((error) => {
      write(socket, {
        id: "0",
        type: "error",
        error: error instanceof Error ? error.message : "runner error",
      });
      socket.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    if (options.fd != null) {
      server.listen({ fd: options.fd }, () => {
        server.off("error", reject);
        resolve();
      });
      return;
    }
    if (!options.socketPath) {
      reject(new Error("runner needs a socket path or a systemd listen fd"));
      return;
    }
    void unlink(options.socketPath)
      .catch(() => undefined)
      .then(() => {
        server.listen(options.socketPath, () => {
          server.off("error", reject);
          void chmod(options.socketPath!, 0o660)
            .catch(() => undefined)
            .finally(() => resolve());
        });
      });
  });

  async function handleConnection(socket: Socket) {
    if (options.peerCheck) options.peerCheck(socket);
    else assertClient(socket, hubUser);
    const line = await readRequest(socket);
    let requestId = "0";
    try {
      const raw = JSON.parse(line) as { id?: unknown };
      if (typeof raw.id === "string") requestId = raw.id;
      const request = parseRunnerRequest(raw);
      requestId = request.id;
      if (request.type === "send") {
        await handleSend(socket, request.id, request.chatId, request.prompt);
        return;
      }
      const result = await dispatch(request);
      write(socket, { id: request.id, type: "ok", result });
      socket.end();
    } catch (error) {
      write(socket, {
        id: requestId,
        type: "error",
        error: error instanceof Error ? error.message : "runner error",
      });
      socket.end();
    }
  }

  async function dispatch(request: ReturnType<typeof parseRunnerRequest>): Promise<unknown> {
    switch (request.type) {
      case "list_chats":
        return listChats(home, new Set(runs.keys()));
      case "get_chat":
        return getChat(home, request.chatId, runs.has(request.chatId));
      case "create_chat":
        return createChat(home, request);
      case "get_settings":
        return loadSettings(home);
      case "put_settings":
        return saveSettings(home, request.settings);
      case "list_workspaces":
        return listWorkspaces(home);
      case "cancel":
        runs.get(request.chatId)?.abort();
        return { ok: true };
      default:
        throw new Error("unsupported request");
    }
  }

  async function handleSend(socket: Socket, id: string, chatId: string, prompt: string) {
    assertChatId(chatId);
    if (runs.has(chatId)) throw new Error("this chat is already running");
    const detail = await getChat(home, chatId, false);
    const chat = detail.chat;
    const controller = new AbortController();
    runs.set(chatId, controller);
    const at = () => new Date().toISOString();
    let sessionId = chat.agentSessionId;
    let writes = Promise.resolve();
    try {
      if (chat.title === "New chat") {
        await updateChat(home, chatId, { title: titleFromPrompt(prompt) });
      }
      await appendTranscript(home, chatId, { kind: "user", text: prompt, at: at() });
      const driver = drivers[chat.agent];
      const settings = await loadSettings(home);
      const finished = await driver.run({
        home,
        workspace: chat.workspace,
        model: chat.model,
        prompt,
        agentSessionId: chat.agentSessionId,
        settings,
        signal: controller.signal,
        env: process.env,
        onEvent: (event) => {
          writes = writes.then(() => record(home, chatId, event)).catch(() => undefined);
          write(socket, { id, type: "event", event });
        },
      });
      await writes;
      sessionId = finished.agentSessionId ?? sessionId;
      if (sessionId && sessionId !== chat.agentSessionId) {
        await updateChat(home, chatId, { agentSessionId: sessionId });
      } else {
        await updateChat(home, chatId, {});
      }
      write(socket, { id, type: "ok", result: { agentSessionId: sessionId } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "send failed";
      const event: StreamEvent = { type: "error", text: message };
      await record(home, chatId, event).catch(() => undefined);
      write(socket, { id, type: "event", event });
      write(socket, { id, type: "error", error: message });
    } finally {
      runs.delete(chatId);
      socket.end();
    }
  }

  return {
    server,
    close: () =>
      new Promise((resolve, reject) => {
        for (const controller of runs.values()) controller.abort();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function assertClient(socket: Socket, hubUser: string) {
  const peer = peerCredentials(socket);
  const self = typeof process.getuid === "function" ? process.getuid() : -1;
  if (peer.uid === self) return;
  if (peer.uid === uidOf(hubUser)) return;
  throw new Error("refusing connection from an unexpected user");
}

function uidOf(username: string): number {
  const result = spawnSync("id", ["-u", username], { encoding: "utf8" });
  if (result.status !== 0) return -1;
  const uid = Number(result.stdout.trim());
  return Number.isInteger(uid) ? uid : -1;
}

function readRequest(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for a request"));
    }, 20_000);
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const index = buf.indexOf("\n");
      if (index >= 0) {
        cleanup();
        resolve(buf.slice(0, index));
      } else if (buf.length > 1_500_000) {
        cleanup();
        reject(new Error("request is too large"));
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

async function record(home: string, chatId: string, event: StreamEvent) {
  const at = new Date().toISOString();
  let entry: TranscriptEntry | null = null;
  if (event.type === "text_delta") entry = { kind: "text", text: event.text, at };
  else if (event.type === "tool") {
    entry = {
      kind: "tool",
      id: event.id,
      name: event.name,
      phase: event.phase,
      input: event.input,
      output: event.output,
      at,
    };
  }
  else if (event.type === "error") entry = { kind: "error", text: event.text, at };
  else if (event.type === "status") entry = { kind: "status", text: event.text, at };
  if (entry) await appendTranscript(home, chatId, entry);
}

function write(socket: Socket, message: RunnerResponse) {
  if (socket.writable) socket.write(`${JSON.stringify(message)}\n`);
}

export type { ChatMeta };
