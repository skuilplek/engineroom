import type { AgentId, ListedSession, PermissionPolicy, StreamEvent } from "@engineroom/protocol";
import { childEnv, resolveBinary } from "../cli.ts";
import { AcpSession, AcpUnavailable, type AcpStart } from "./session.ts";

const IDLE_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 4;

export interface AcpLaunch {
  binary: string;
  args: string[];
}

export interface AcpContext {
  agent: AgentId;
  home: string;
  workspace: string;
  model: string;
  mode: string;
  agentSessionId: string | null;
  needsResync: boolean;
  permission: PermissionPolicy;
  env?: NodeJS.ProcessEnv;
  onEvent: (event: StreamEvent) => void;
  onSession?: (sessionId: string) => void | Promise<void>;
}

export class AcpManager {
  private sessions = new Map<string, AcpSession>();
  private starting = new Map<string, Promise<AcpSession>>();
  private idle = new Map<string, NodeJS.Timeout>();
  private order: string[] = [];

  private readonly options: {
    launch?: (agent: AgentId, ctx: AcpContext) => Promise<AcpLaunch>;
  };

  constructor(options: { launch?: (agent: AgentId, ctx: AcpContext) => Promise<AcpLaunch> } = {}) {
    this.options = options;
  }

  supports(agent: AgentId): boolean {
    return agent === "cursor" || agent === "claude";
  }

  info(chatId: string): { modes: AcpSession["modes"]; models: AcpSession["models"] } | null {
    const session = this.sessions.get(chatId);
    if (!session) return null;
    return { modes: session.modes, models: session.models };
  }

  async prompt(chatId: string, ctx: AcpContext, text: string, signal: AbortSignal): Promise<{ agentSessionId: string | null }> {
    this.clearIdle(chatId);
    const session = await this.ensure(chatId, ctx);
    if (session.sessionId) await ctx.onSession?.(session.sessionId);
    if (signal.aborted) {
      ctx.onEvent({ type: "status", text: "Stopped" });
      ctx.onEvent({ type: "done", agentSessionId: session.sessionId });
      return { agentSessionId: session.sessionId };
    }
    try {
      await session.prompt(text, signal);
    } catch (error) {
      if (signal.aborted) {
        ctx.onEvent({ type: "status", text: "Stopped" });
        ctx.onEvent({ type: "done", agentSessionId: session.sessionId });
        return { agentSessionId: session.sessionId };
      }
      throw error;
    } finally {
      this.scheduleIdle(chatId);
    }
    return { agentSessionId: session.sessionId };
  }

  async resync(chatId: string, ctx: AcpContext): Promise<string | null> {
    await this.stop(chatId);
    ctx.needsResync = true;
    const session = await this.ensure(chatId, ctx);
    this.scheduleIdle(chatId);
    return session.sessionId;
  }

  respond(chatId: string, requestId: string, optionId: string): boolean {
    return this.sessions.get(chatId)?.respond(requestId, optionId) ?? false;
  }

  async setMode(chatId: string, modeId: string) {
    const session = this.sessions.get(chatId);
    if (session?.alive) await session.setMode(modeId);
  }

  async setModel(chatId: string, modelId: string) {
    const session = this.sessions.get(chatId);
    if (session?.alive) await session.setModel(modelId);
  }

  cancel(chatId: string) {
    this.sessions.get(chatId)?.cancel();
  }

  async stopAll() {
    for (const chatId of [...this.sessions.keys()]) await this.stop(chatId);
  }

  async stop(chatId: string) {
    this.clearIdle(chatId);
    const session = this.sessions.get(chatId);
    this.sessions.delete(chatId);
    this.order = this.order.filter((id) => id !== chatId);
    await session?.stop();
  }

  async list(agent: AgentId, cwd: string, env: NodeJS.ProcessEnv, home: string): Promise<ListedSession[]> {
    const launch = await this.launch(agent, {
      agent,
      home,
      workspace: cwd,
      model: "",
      mode: "",
      agentSessionId: null,
      needsResync: false,
      permission: "ask",
      env,
      onEvent: () => undefined,
    });
    const { spawn } = await import("node:child_process");
    const child = spawn(launch.binary, launch.args, { cwd, env: childEnv(env, home), stdio: ["pipe", "pipe", "pipe"] });
    const { JsonRpc } = await import("./rpc.ts");
    const rpc = new JsonRpc(child, async () => ({}), () => undefined);
    try {
      const initialized = (await rpc.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "engineroom", version: "0.1.0" },
      })) as { authMethods?: { id: string }[] };
      const method = initialized.authMethods?.[0]?.id;
      if (method) await rpc.request("authenticate", { methodId: method });
      const listed = (await rpc.request("session/list", { cwd })) as { sessions?: ListedSession[] } | ListedSession[];
      const sessions = Array.isArray(listed) ? listed : listed.sessions ?? [];
      return sessions
        .filter((item) => item && typeof item.sessionId === "string")
        .map((item) => ({
          sessionId: item.sessionId,
          cwd: typeof item.cwd === "string" ? item.cwd : undefined,
          updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : undefined,
          title: typeof item.title === "string" ? item.title : undefined,
        }));
    } finally {
      child.kill("SIGTERM");
    }
  }

  private async ensure(chatId: string, ctx: AcpContext): Promise<AcpSession> {
    const existing = this.sessions.get(chatId);
    if (existing?.alive && !ctx.needsResync) return existing;
    if (existing && ctx.needsResync) await this.stop(chatId);
    const pending = this.starting.get(chatId);
    if (pending) return pending;
    const opening = this.open(chatId, ctx);
    this.starting.set(chatId, opening);
    try {
      return await opening;
    } finally {
      this.starting.delete(chatId);
    }
  }

  private async open(chatId: string, ctx: AcpContext): Promise<AcpSession> {
    await this.reap();
    const launch = await this.launch(ctx.agent, ctx);
    const session = new AcpSession({
      binary: launch.binary,
      args: launch.args,
      cwd: ctx.workspace,
      env: childEnv(ctx.env ?? process.env, ctx.home),
      sessionId: ctx.agentSessionId,
      model: ctx.model,
      mode: ctx.mode,
      needsResync: ctx.needsResync,
      permission: ctx.permission,
      onEvent: ctx.onEvent,
    } satisfies AcpStart);
    const sessionId = await session.open();
    session.sessionId = sessionId;
    this.sessions.set(chatId, session);
    this.order.push(chatId);
    ctx.needsResync = false;
    return session;
  }

  private async launch(agent: AgentId, ctx: AcpContext): Promise<AcpLaunch> {
    if (this.options.launch) return this.options.launch(agent, ctx);
    if (agent === "cursor") {
      const binary = await resolveBinary(undefined, ["agent"], childEnv(ctx.env ?? process.env, ctx.home)).catch(() => {
        throw new AcpUnavailable("could not find agent on PATH");
      });
      return { binary, args: ["acp"] };
    }
    if (agent === "claude") {
      const binary = await resolveBinary(undefined, ["claude-agent-acp"], childEnv(ctx.env ?? process.env, ctx.home)).catch(() => {
        throw new AcpUnavailable("could not find claude-agent-acp on PATH");
      });
      return { binary, args: [] };
    }
    throw new AcpUnavailable();
  }

  private scheduleIdle(chatId: string) {
    this.clearIdle(chatId);
    const timer = setTimeout(() => {
      void this.stop(chatId);
    }, IDLE_MS);
    timer.unref?.();
    this.idle.set(chatId, timer);
  }

  private clearIdle(chatId: string) {
    const timer = this.idle.get(chatId);
    if (timer) clearTimeout(timer);
    this.idle.delete(chatId);
  }

  private async reap() {
    if (this.sessions.size < MAX_SESSIONS) return;
    const idle = this.order.find((chatId) => this.idle.has(chatId));
    if (idle) await this.stop(idle);
  }
}
