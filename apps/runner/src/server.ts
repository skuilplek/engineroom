import { spawnSync } from "node:child_process";
import { mkdtemp, rm, chmod, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { peerCredentials } from "@engineroom/peercred";
import {
  assertChatId,
  maxSeq,
  parseRunnerRequest,
  titleFromPrompt,
  type AgentId,
  type ChatEvent,
  type ChatMeta,
  type RunnerRequest,
  type RunnerResponse,
  type StreamEvent,
} from "@engineroom/protocol";
import { AcpManager, type AcpContext } from "./acp/manager.ts";
import { AcpUnavailable } from "./acp/session.ts";
import { type BusSink, ChatBus, type PushMessage } from "./bus.ts";
import { childEnv, resolveBinary, binaryNames } from "./cli.ts";
import { gitClone } from "./clone.ts";
import { defaultDrivers, type AgentDriver, type DriverContext } from "./drivers.ts";
import { loadEnv, saveEnv } from "./envfile.ts";
import { TranscriptWriter } from "./persist.ts";
import { binaryFor, loadPolicy, savePolicy, withLocks } from "./policy.ts";
import { PtyManager, ptyCommand, type PtyProcess } from "./pty.ts";
import { loadGrants, syncGrantedRepositories, type CloneRepository } from "./repos.ts";
import { listRepositoryFiles, readRepositoryFile } from "./files.ts";
import {
  clearTranscript,
  createChat,
  getChat,
  listChats,
  detectRepositories,
  listRepositories,
  loadSettings,
  saveSettings,
  setEnabledRepositories,
  updateChat,
} from "./store.ts";

export interface RunnerOptions {
  home: string;
  socketPath?: string;
  fd?: number;
  drivers?: Record<AgentId, AgentDriver>;
  peerCheck?: (socket: Socket) => void;
  hubUser?: string;
  acp?: AcpManager | null;
  pty?: PtyManager;
  clone?: CloneRepository;
}

export interface RunningRunner {
  server: Server;
  close: () => Promise<void>;
}

interface RunState {
  busy: boolean;
  stopped: boolean;
  queue: string[];
  controller: AbortController;
}

export async function startRunner(options: RunnerOptions): Promise<RunningRunner> {
  const home = options.home;
  const drivers = options.drivers ?? defaultDrivers();
  const acp = options.acp === undefined ? (options.drivers ? null : new AcpManager()) : options.acp;
  const pty = options.pty ?? new PtyManager();
  const runs = new Map<string, RunState>();
  const bus = new ChatBus();
  const writer = new TranscriptWriter(home);
  const hubUser = options.hubUser ?? process.env.ENGINEROOM_HUB_USER ?? "engineroom";
  const clone = options.clone ?? gitClone;
  const server = createServer((socket) => {
    socket.setNoDelay(true);
    void handleConnection(socket).catch((error) => {
      write(socket, {
        id: "0",
        type: "error",
        error: error instanceof Error ? error.message : "runner error",
      });
      socket.end();
    });
  });

  await listen(server, options);

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
      if (request.type === "subscribe") {
        await handleSubscribe(socket, request.id);
        return;
      }
      if (request.type === "send" || request.type === "prompt") {
        const result = beginTurn(request.chatId, request.prompt);
        write(socket, { id: request.id, type: "ok", result });
        socket.end();
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

  async function handleSubscribe(socket: Socket, id: string) {
    const watched = new Set<string>();
    const ready = new Set<string>();
    const buffered: ChatEvent[] = [];
    const held = new Set<string>();
    const sink: BusSink = {
      send(message: PushMessage) {
        if (message.type === "chat_event") {
          if (!watched.has(message.chatId)) return;
          if (!ready.has(message.chatId)) {
            buffered.push(message);
            return;
          }
        }
        if (message.type === "pty" && !watched.has(message.chatId)) return;
        write(socket, message);
      },
    };
    const remove = bus.add(sink);
    write(socket, { id, type: "ok", result: { subscribed: true } });
    try {
      await readLines(socket, async (line) => {
        let requestId = "0";
        try {
          const raw = JSON.parse(line) as { id?: unknown };
          if (typeof raw.id === "string") requestId = raw.id;
          const request = parseRunnerRequest(raw);
          requestId = request.id;
          const result = await onSubscribed(request, watched, ready, buffered, held);
          write(socket, { id: request.id, type: "ok", result });
          if (request.type === "watch") {
            ready.add(request.chatId);
            const max = typeof (result as { seq?: number }).seq === "number" ? (result as { seq: number }).seq : 0;
            const pending = buffered.filter((item) => item.chatId === request.chatId && item.seq > max);
            for (let index = buffered.length - 1; index >= 0; index -= 1) {
              if (buffered[index]?.chatId === request.chatId) buffered.splice(index, 1);
            }
            for (const item of pending) write(socket, { id: "push", type: "chat_event", ...item });
          }
        } catch (error) {
          write(socket, {
            id: requestId,
            type: "error",
            error: error instanceof Error ? error.message : "runner error",
          });
        }
      });
    } finally {
      remove();
      for (const chatId of held) pty.release(chatId);
    }
  }

  async function onSubscribed(
    request: RunnerRequest,
    watched: Set<string>,
    ready: Set<string>,
    _buffered: ChatEvent[],
    held: Set<string>,
  ): Promise<unknown> {
    switch (request.type) {
      case "watch": {
        watched.add(request.chatId);
        ready.delete(request.chatId);
        await writer.flush(request.chatId);
        const detail = await getChat(home, request.chatId, runs.has(request.chatId));
        const seq = Math.max(maxSeq(detail.transcript), bus.current(request.chatId));
        bus.init(request.chatId, seq);
        const info = acp?.info(request.chatId);
        return {
          chat: detail.chat,
          transcript: detail.transcript,
          seq: maxSeq(detail.transcript),
          running: runs.has(request.chatId),
          modes: info?.modes,
          models: info?.models,
          scrollback: Buffer.from(pty.scrollback(request.chatId), "utf8").toString("base64"),
        };
      }
      case "unwatch":
        watched.delete(request.chatId);
        ready.delete(request.chatId);
        return { ok: true };
      case "send":
      case "prompt":
        return beginTurn(request.chatId, request.prompt);
      case "cancel":
        cancel(request.chatId);
        return { ok: true };
      case "permission_response":
        if (!acp?.respond(request.chatId, request.requestId, request.optionId)) throw new Error("no pending permission");
        return { ok: true };
      case "set_mode":
        return applyMode(request.chatId, request.modeId);
      case "set_model":
        return applyModel(request.chatId, request.modelId);
      case "pty_open":
        return openPty(request.chatId, request.cols, request.rows, held);
      case "pty_input":
        pty.write(request.chatId, Buffer.from(request.data, "base64").toString("utf8"));
        return { ok: true };
      case "pty_resize":
        pty.resize(request.chatId, request.cols, request.rows);
        return { ok: true };
      case "pty_detach":
        if (held.delete(request.chatId)) pty.release(request.chatId);
        return { ok: true };
      case "pty_close":
        return closePty(request.chatId, held);
      case "list_sessions":
        return listSessions(request.agent);
      case "import_session":
        return importSession(request.agent, request.agentSessionId, request.workspace);
      default:
        return dispatch(request);
    }
  }

  async function dispatch(request: RunnerRequest): Promise<unknown> {
    switch (request.type) {
      case "list_chats":
        return listChats(home, new Set(runs.keys()));
      case "get_chat":
        await writer.flush(request.chatId);
        return getChat(home, request.chatId, runs.has(request.chatId));
      case "get_settings":
        return withLocks(await loadSettings(home), await loadPolicy(home));
      case "put_settings":
        return saveSettings(home, request.settings);
      case "get_policy":
        return loadPolicy(home);
      case "put_policy":
        return savePolicy(home, request.policy);
      case "get_env":
        return loadEnv(home);
      case "put_env":
        return saveEnv(home, request.entries);
      case "get_access": {
        const policy = await loadPolicy(home);
        return {
          policy,
          settings: withLocks(await loadSettings(home), policy),
          grants: await loadGrants(home),
          env: await loadEnv(home),
        };
      }
      case "sync_repositories":
        return syncGrantedRepositories(home, request.repos, clone, request.directory);
      case "detect_repositories":
        return detectRepositories(home, request.directory);
      case "list_workspaces":
        return (await import("./workspace.ts")).listWorkspaces(home);
      case "list_repositories":
        return listRepositories(home);
      case "set_repositories":
        return setEnabledRepositories(home, request.enabled);
      case "create_chat": {
        const policy = await loadPolicy(home);
        const settings = await loadSettings(home);
        const agent = request.agent ?? settings.defaultAgent;
        if (!policy.agents.includes(agent)) throw new Error("invalid agent");
        return createChat(home, request);
      }
      case "set_mode":
        return applyMode(request.chatId, request.modeId);
      case "set_model":
        return applyModel(request.chatId, request.modelId);
      case "probe_agent":
        return probeAgent(request.agent);
      case "cancel":
        cancel(request.chatId);
        return { ok: true };
      case "list_sessions":
        return listSessions(request.agent);
      case "import_session":
        return importSession(request.agent, request.agentSessionId, request.workspace);
      case "list_repo_files":
        return listRepositoryFiles(home, request.workspace, request.visibility);
      case "read_repo_file":
        return readRepositoryFile(home, request.workspace, request.path, request.visibility);
      default:
        throw new Error("unsupported request");
    }
  }

  async function applyMode(chatId: string, modeId: string) {
    await assertPersonalOption(chatId, "mode", modeId);
    await updateChat(home, chatId, { mode: modeId });
    // A running turn is already inside session/prompt. Another set_mode on that
    // process waits behind the turn and blocks every other chat on this connection.
    if (modeId && !runs.get(chatId)?.busy) await acp?.setMode(chatId, modeId).catch(() => undefined);
    return { ok: true };
  }

  async function applyModel(chatId: string, modelId: string) {
    await assertPersonalOption(chatId, "model", modelId);
    await updateChat(home, chatId, { model: modelId });
    if (modelId && !runs.get(chatId)?.busy) await acp?.setModel(chatId, modelId).catch(() => undefined);
    return { ok: true };
  }

  async function assertPersonalOption(chatId: string, kind: "mode" | "model", id: string) {
    if (!id) return;
    const detail = await getChat(home, chatId, runs.has(chatId));
    const policy = await loadPolicy(home);
    const options = policy.options?.[detail.chat.agent];
    if (!options) return;
    const allowed = kind === "mode" ? options.modes : options.models;
    if (!allowed.includes(id)) throw new Error(kind === "mode" ? "invalid mode" : "invalid model");
  }

  async function probeAgent(agent: AgentId) {
    if (!acp?.supports(agent)) throw new Error("this agent does not report modes or models");
    const cwd = await mkdtemp(path.join(tmpdir(), "er-probe-"));
    try {
      return await acp.probe(agent, cwd, process.env, home);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  function beginTurn(chatId: string, prompt: string): { accepted: true; queued: boolean } {
    assertChatId(chatId);
    let state = runs.get(chatId);
    if (!state) {
      state = { busy: false, stopped: false, queue: [], controller: new AbortController() };
      runs.set(chatId, state);
    }
    if (state.busy) {
      state.queue.push(prompt);
      publish(chatId, { type: "queued", text: prompt });
      return { accepted: true, queued: true };
    }
    state.busy = true;
    state.stopped = false;
    state.controller = new AbortController();
    bus.setRunning(chatId, true);
    void executeTurn(chatId, state, prompt);
    return { accepted: true, queued: false };
  }

  function cancel(chatId: string) {
    const state = runs.get(chatId);
    if (!state) return;
    state.queue.length = 0;
    state.stopped = true;
    state.controller.abort();
    acp?.cancel(chatId);
  }

  async function executeTurn(chatId: string, state: RunState, prompt: string) {
    const signal = state.controller.signal;
    let sessionId: string | null = null;
    const publishEvent = (event: StreamEvent) => publish(chatId, event);
    try {
      if (signal.aborted) return;
      const detail = await getChat(home, chatId, true);
      const chat = detail.chat;
      sessionId = chat.agentSessionId;
      bus.init(chatId, maxSeq(detail.transcript));
      if (chat.title === "New chat") {
        const title = titleFromPrompt(prompt);
        await updateChat(home, chatId, { title });
        publishEvent({ type: "title", text: title });
      }
      publishEvent({ type: "user_message", text: prompt });
      publishEvent({ type: "turn_start" });
      const policy = await loadPolicy(home);
      if (!policy.agents.includes(chat.agent)) throw new Error("invalid agent");
      const settings = withLocks(await loadSettings(home), policy);
      const ctx: DriverContext = {
        home,
        workspace: chat.workspace,
        model: chat.model,
        prompt,
        agentSessionId: chat.agentSessionId,
        settings,
        signal,
        env: process.env,
        onEvent: (event) => {
          if (event.type === "done" && event.agentSessionId) sessionId = event.agentSessionId;
          if (event.type === "title" && event.text.trim()) {
            void updateChat(home, chatId, { title: event.text.trim().slice(0, 120) }).catch(() => undefined);
          }
          if (event.type === "mode") void updateChat(home, chatId, { mode: event.modeId }).catch(() => undefined);
          publishEvent(event);
        },
      };
      if (acp?.supports(chat.agent)) {
        const acpCtx: AcpContext = {
          agent: chat.agent,
          home,
          workspace: chat.workspace,
          model: chat.model,
          mode: chat.mode || "",
          agentSessionId: chat.agentSessionId,
          needsResync: Boolean(chat.needsResync),
          permission: settings.permission,
          env: process.env,
          onEvent: ctx.onEvent,
          onSession: async (id) => {
            sessionId = id;
            if (id !== chat.agentSessionId) await updateChat(home, chatId, { agentSessionId: id });
          },
        };
        try {
          const finished = await acp.prompt(chatId, acpCtx, prompt, signal);
          sessionId = finished.agentSessionId ?? sessionId;
          if (chat.needsResync) await updateChat(home, chatId, { needsResync: false });
        } catch (error) {
          if (!(error instanceof AcpUnavailable)) throw error;
          const finished = await drivers[chat.agent].run(ctx);
          sessionId = finished.agentSessionId ?? sessionId;
        }
      } else {
        const finished = await drivers[chat.agent].run(ctx);
        sessionId = finished.agentSessionId ?? sessionId;
      }
      if (sessionId && sessionId !== chat.agentSessionId) await updateChat(home, chatId, { agentSessionId: sessionId });
      else await updateChat(home, chatId, {});
    } catch (error) {
      const message = error instanceof Error ? error.message : "send failed";
      publishEvent({ type: "error", text: message });
    } finally {
      await writer.flush(chatId);
      state.busy = false;
      if (state.stopped || signal.aborted) {
        state.queue.length = 0;
        runs.delete(chatId);
        bus.setRunning(chatId, false);
        return;
      }
      const next = state.queue.shift();
      if (next) {
        state.busy = true;
        state.controller = new AbortController();
        void executeTurn(chatId, state, next);
        return;
      }
      runs.delete(chatId);
      bus.setRunning(chatId, false);
    }
  }

  function publish(chatId: string, event: StreamEvent) {
    const item = bus.publish(chatId, event);
    void writer.record(chatId, event, item.seq).catch(() => undefined);
  }

  async function openPty(chatId: string, cols: number, rows: number, held: Set<string>) {
    if (runs.get(chatId)?.busy) throw new Error("chat is running");
    const detail = await getChat(home, chatId, false);
    const chat = detail.chat;
    if (held.has(chatId) && pty.has(chatId)) {
      return { attached: true, scrollback: Buffer.from(pty.scrollback(chatId), "utf8").toString("base64") };
    }
    const policy = await loadPolicy(home);
    if (!policy.rawTerminal) throw new Error("terminal is not enabled");
    await acp?.stop(chatId);
    const settings = await loadSettings(home);
    const env = childEnv(process.env, home);
    env.TERM = "xterm-256color";
    const binary = await resolveBinary(binaryFor(policy, settings, chat.agent), binaryNames(chat.agent), env);
    const command = ptyCommand(chat.agent, chat.agentSessionId, chat.workspace);
    const scroll = await pty.open(
      chatId,
      { file: binary, args: command.args, cwd: chat.workspace, env, cols, rows },
      (data) => bus.pty(chatId, Buffer.from(data, "utf8").toString("base64")),
    );
    if (!held.has(chatId)) {
      held.add(chatId);
    }
    return { attached: true, scrollback: Buffer.from(scroll, "utf8").toString("base64") };
  }

  async function closePty(chatId: string, held: Set<string>) {
    if (held.delete(chatId)) pty.release(chatId);
    pty.close(chatId);
    const detail = await getChat(home, chatId, false);
    await writer.flush(chatId);
    await updateChat(home, chatId, { needsResync: true });
    if (acp?.supports(detail.chat.agent) && detail.chat.agentSessionId) {
      await clearTranscript(home, chatId);
      const settings = await loadSettings(home);
      const sessionId = await acp.resync(chatId, {
        agent: detail.chat.agent,
        home,
        workspace: detail.chat.workspace,
        model: detail.chat.model,
        mode: detail.chat.mode || "",
        agentSessionId: detail.chat.agentSessionId,
        needsResync: true,
        permission: settings.permission,
        env: process.env,
        onEvent: (event) => publish(chatId, event),
      });
      await updateChat(home, chatId, {
        needsResync: false,
        agentSessionId: sessionId || detail.chat.agentSessionId,
      });
    }
    return { ok: true };
  }

  async function listSessions(agent?: AgentId) {
    const chosen = agent ?? "cursor";
    if (!acp?.supports(chosen)) return { sessions: [] };
    const sessions = await acp.list(chosen, home, process.env, home);
    return { sessions };
  }

  async function importSession(agent: AgentId | undefined, agentSessionId: string, workspace?: string) {
    const chosen = agent ?? "cursor";
    const policy = await loadPolicy(home);
    if (!policy.agents.includes(chosen)) throw new Error("invalid agent");
    const chat = await createChat(home, { agent: chosen, workspace, title: "Imported chat" });
    return updateChat(home, chat.id, { agentSessionId, needsResync: true });
  }

  return {
    server,
    close: async () => {
      for (const state of runs.values()) {
        state.stopped = true;
        state.controller.abort();
      }
      await writer.flushAll();
      await acp?.stopAll?.();
      pty.closeAll();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function listen(server: Server, options: RunnerOptions): Promise<void> {
  return new Promise((resolve, reject) => {
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
}

function assertClient(socket: Socket, hubUser: string) {
  const peer = peerCredentials(socket);
  const self = typeof process.getuid === "function" ? process.getuid() : -1;
  if (peer.uid === self) return;
  if (peer.uid === uidOf(hubUser)) return;
  throw new Error("refusing connection from an unexpected user");
}

const uidCache = new Map<string, number>();

function uidOf(username: string): number {
  const cached = uidCache.get(username);
  if (cached !== undefined) return cached;
  const result = spawnSync("id", ["-u", username], { encoding: "utf8" });
  if (result.status !== 0) return -1;
  const uid = Number(result.stdout.trim());
  if (!Number.isInteger(uid)) return -1;
  uidCache.set(username, uid);
  return uid;
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

function readLines(socket: Socket, onLine: (line: string) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const queue: string[] = [];
    let working = false;
    let ended = false;
    const finish = () => {
      if (!working && queue.length === 0) resolve();
    };
    const pump = () => {
      if (working) return;
      const line = queue.shift();
      if (line == null) {
        if (ended) finish();
        return;
      }
      working = true;
      void onLine(line)
        .catch(() => undefined)
        .finally(() => {
          working = false;
          pump();
        });
    };
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      if (buf.length > 2_000_000) {
        socket.destroy();
        reject(new Error("request is too large"));
        return;
      }
      let index = buf.indexOf("\n");
      while (index >= 0) {
        queue.push(buf.slice(0, index));
        buf = buf.slice(index + 1);
        index = buf.indexOf("\n");
      }
      pump();
    });
    socket.on("end", () => {
      ended = true;
      finish();
    });
    socket.on("close", () => {
      ended = true;
      finish();
    });
    socket.on("error", (error) => reject(error));
  });
}

function write(socket: Socket, message: RunnerResponse | PushMessage) {
  if (socket.writable) socket.write(`${JSON.stringify(message)}\n`);
}

export type { ChatMeta, PtyProcess };
