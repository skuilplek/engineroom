import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isInsidePath, type AgentOptionChoice, type PermissionOption, type PermissionPolicy, type StreamEvent } from "@engineroom/protocol";
import type { AgentContentBlock } from "../prompt-content.ts";
import { mapUpdate } from "./map.ts";
import { JsonRpc } from "./rpc.ts";

// The agent handshake is not instant. cursor-agent validates the saved login
// over the network during authenticate, which regularly takes 10-20 seconds
// and can be slower on a busy machine. These timeouts only guard against a
// process that never answers; a normal turn is not bounded by them.
export const ACP_HANDSHAKE_TIMEOUT_MS = 60_000;
export const ACP_CONTROL_TIMEOUT_MS = 20_000;

export class AcpUnavailable extends Error {
  constructor(message = "acp adapter is not installed") {
    super(message);
    this.name = "AcpUnavailable";
  }
}

export interface AcpMcpServer {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
}

export interface AcpStart {
  binary: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  sessionId: string | null;
  model: string;
  mode: string;
  needsResync: boolean;
  permission: PermissionPolicy;
  mcpServers?: AcpMcpServer[];
  onEvent: (event: StreamEvent) => void;
}

interface LiveTerminal {
  child: ChildProcess;
  output: string;
  exit: Promise<{ exitCode: number }>;
}

export interface PendingPermission {
  requestId: string;
  title?: string;
  options: PermissionOption[];
}

interface PermissionWaiter {
  resolve: (optionId: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class AcpSession {
  readonly id: string;
  sessionId: string | null = null;
  modes: { currentModeId: string; availableModes: { id: string; name: string; description?: string }[] } | null = null;
  models: { currentModelId: string; availableModels: { modelId: string; name: string }[] } | null = null;
  acceptsImages = false;
  alive = true;
  pendingPermission: PendingPermission | null = null;
  private rpc!: JsonRpc;
  private child!: ChildProcess;
  private suppress = false;
  private ignoreUser = false;
  private accepting = false;
  private cancelled = false;
  private onEvent: (event: StreamEvent) => void;
  private permissions = new Map<string, PermissionWaiter>();
  private terminals = new Map<string, LiveTerminal>();
  private workspace = "";

  private readonly start: AcpStart;

  constructor(start: AcpStart) {
    this.start = start;
    this.onEvent = start.onEvent;
    this.id = randomUUID();
  }

  async open(): Promise<string> {
    this.workspace = this.start.cwd;
    let child: ChildProcess;
    try {
      child = spawn(this.start.binary, this.start.args, {
        cwd: this.start.cwd,
        env: this.start.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw new AcpUnavailable(error instanceof Error ? error.message : "could not start acp");
    }
    this.child = child;
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on("close", () => {
      this.alive = false;
    });
    this.rpc = new JsonRpc(child, (method, params, id) => this.incoming(method, params, id), (method, params) => {
      this.note(method, params);
    });
    const initialized = (await this.rpc.request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
        clientInfo: { name: "engineroom", version: "0.1.0" },
      },
      ACP_HANDSHAKE_TIMEOUT_MS,
    )) as { authMethods?: { id: string }[]; agentCapabilities?: { promptCapabilities?: { image?: boolean } } };
    this.acceptsImages = initialized.agentCapabilities?.promptCapabilities?.image === true;
    const method = initialized.authMethods?.[0]?.id;
    if (method) await this.rpc.request("authenticate", { methodId: method }, ACP_HANDSHAKE_TIMEOUT_MS);
    if (this.start.needsResync) this.suppress = false;
    else this.suppress = Boolean(this.start.sessionId);
    const mcpServers = this.start.mcpServers ?? [];
    const openNew = () =>
      this.rpc.request("session/new", { cwd: this.start.cwd, mcpServers }, ACP_HANDSHAKE_TIMEOUT_MS) as Promise<Record<string, unknown>>;
    let created: Record<string, unknown>;
    if (this.start.sessionId) {
      try {
        created = (await this.rpc.request(
          "session/load",
          {
            sessionId: this.start.sessionId,
            cwd: this.start.cwd,
            mcpServers,
          },
          ACP_HANDSHAKE_TIMEOUT_MS,
        )) as Record<string, unknown>;
      } catch {
        // The saved agent session can disappear after an upgrade. Continue in a new one.
        this.suppress = false;
        created = await openNew();
      }
    } else {
      created = await openNew();
    }
    this.suppress = false;
    this.sessionId = typeof created.sessionId === "string" ? created.sessionId : this.start.sessionId;
    if (!this.sessionId) throw new Error(stderr.trim() || "agent did not open a session");
    this.modes = readModes(created.modes);
    this.models = readModels(created.models);
    if (this.start.mode) await this.setMode(this.start.mode).catch(() => undefined);
    if (this.start.model) await this.setModel(this.start.model).catch(() => undefined);
    return this.sessionId;
  }

  async prompt(
    blocks: AgentContentBlock[],
    signal: AbortSignal,
    onEvent: (event: StreamEvent) => void,
  ): Promise<{ stopReason?: string }> {
    if (!this.sessionId) throw new Error("session is not open");
    this.onEvent = onEvent;
    const onAbort = () => this.cancel();
    this.accepting = true;
    this.cancelled = false;
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    this.ignoreUser = true;
    try {
      const result = (await this.rpc.request("session/prompt", {
        sessionId: this.sessionId,
        prompt: blocks,
      })) as { stopReason?: string };
      this.onEvent({ type: "turn_end", stopReason: result.stopReason });
      this.onEvent({ type: "done", agentSessionId: this.sessionId });
      return result;
    } finally {
      this.accepting = false;
      this.ignoreUser = false;
      signal.removeEventListener("abort", onAbort);
    }
  }

  cancel() {
    this.accepting = false;
    this.cancelled = true;
    if (!this.sessionId || !this.alive) return;
    try {
      this.rpc.notify("session/cancel", { sessionId: this.sessionId });
    } catch {
      /* the process is already gone */
    }
  }

  respond(requestId: string, optionId: string): boolean {
    const waiter = this.permissions.get(requestId);
    if (!waiter) return false;
    this.permissions.delete(requestId);
    clearTimeout(waiter.timer);
    if (this.pendingPermission?.requestId === requestId) this.pendingPermission = null;
    waiter.resolve(optionId);
    this.onEvent({ type: "permission_resolved", requestId, optionId });
    return true;
  }

  async setMode(modeId: string) {
    if (!this.sessionId) return;
    await this.rpc.request("session/set_mode", { sessionId: this.sessionId, modeId }, ACP_CONTROL_TIMEOUT_MS);
    if (this.modes) this.modes = { ...this.modes, currentModeId: modeId };
    this.onEvent({ type: "mode", modeId });
  }

  async setModel(modelId: string) {
    if (!this.sessionId || !modelId) return;
    await this.rpc.request("session/set_model", { sessionId: this.sessionId, modelId }, ACP_CONTROL_TIMEOUT_MS);
    if (this.models) this.models = { ...this.models, currentModelId: modelId };
  }

  async stop() {
    this.alive = false;
    this.accepting = false;
    this.cancelled = true;
    this.rejectPermissions(new Error("session stopped"));
    await Promise.all([...this.terminals.values()].map((terminal) => stopChild(terminal.child)));
    this.terminals.clear();
    await stopChild(this.child);
  }

  private note(method: string, params: unknown) {
    if (method !== "session/update" || !params || typeof params !== "object") return;
    if (!this.alive || !this.accepting || this.cancelled) return;
    const update = (params as { update?: unknown }).update;
    if (this.suppress) return;
    for (const event of mapUpdate(update)) {
      if (event.type === "user_message" && this.ignoreUser) continue;
      if (event.type === "mode") {
        if (this.modes?.currentModeId === event.modeId) continue;
        if (this.modes) this.modes = { ...this.modes, currentModeId: event.modeId };
      }
      this.onEvent(event);
    }
  }

  private async incoming(method: string, params: unknown, _id: number): Promise<unknown> {
    if (method === "session/request_permission") return this.permission(params);
    if (method === "fs/read_text_file") return this.readFile(params);
    if (method === "fs/write_text_file") return this.writeFile(params);
    if (method === "terminal/create") return this.createTerminal(params);
    if (method === "terminal/output") return this.terminalOutput(params);
    if (method === "terminal/wait_for_exit") return this.waitTerminal(params);
    if (method === "terminal/kill" || method === "terminal/release") return this.stopTerminal(params, method.endsWith("kill"));
    return {};
  }

  private async permission(params: unknown): Promise<unknown> {
    if (!this.accepting || this.cancelled) return { outcome: { outcome: "cancelled" } };
    const body = (params ?? {}) as { toolCall?: { toolCallId?: string; title?: string; kind?: string }; options?: PermissionOption[] };
    const options = Array.isArray(body.options) ? body.options.filter((item) => item && item.optionId) : [];
    const allow = options.find((item) => item.kind === "allow_once" || item.kind === "allow_always") ?? options[0];
    const kind = body.toolCall?.kind ?? "";
    const policy = this.start.permission;
    const auto = policy === "allow" || (policy === "edits" && (kind === "edit" || kind === "write" || kind === "delete"));
    if (auto && allow) {
      return { outcome: { outcome: "selected", optionId: allow.optionId } };
    }
    const requestId = randomUUID();
    const pending: PendingPermission = {
      requestId,
      title: body.toolCall?.title,
      options: options.map((item) => ({ optionId: item.optionId, name: item.name || item.optionId, kind: item.kind || "allow_once" })),
    };
    this.pendingPermission = pending;
    this.onEvent({
      type: "permission_request",
      requestId,
      toolCallId: body.toolCall?.toolCallId,
      title: pending.title,
      options: pending.options,
    });
    const optionId = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.permissions.delete(requestId);
        if (this.pendingPermission?.requestId === requestId) this.pendingPermission = null;
        reject(new Error("permission timed out"));
      }, 120_000);
      timer.unref?.();
      this.permissions.set(requestId, {
        resolve: (selected) => resolve(selected),
        reject,
        timer,
      });
    });
    if (this.pendingPermission?.requestId === requestId) this.pendingPermission = null;
    return { outcome: { outcome: "selected", optionId } };
  }

  private rejectPermissions(error: Error) {
    for (const waiter of this.permissions.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.permissions.clear();
    this.pendingPermission = null;
  }

  private async readFile(params: unknown): Promise<unknown> {
    const file = await this.confine(pathOf(params));
    const content = await readFile(file, "utf8");
    return { content: content.slice(0, 1_000_000) };
  }

  private async writeFile(params: unknown): Promise<unknown> {
    const body = (params ?? {}) as { path?: string; content?: string };
    const file = await this.confine(body.path || "");
    await writeFile(file, typeof body.content === "string" ? body.content : "", "utf8");
    return {};
  }

  private async createTerminal(params: unknown): Promise<unknown> {
    const body = (params ?? {}) as { command?: string; args?: string[]; cwd?: string };
    if (!body.command || body.command.includes("\0")) throw new Error("invalid command");
    const cwd = body.cwd ? await this.confine(body.cwd) : this.workspace;
    const child = spawn(body.command, Array.isArray(body.args) ? body.args.map(String) : [], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const id = randomUUID();
    const record: LiveTerminal = {
      child,
      output: "",
      exit: new Promise<{ exitCode: number }>((resolve) => {
        child.on("error", () => resolve({ exitCode: 1 }));
        child.on("close", (code) => resolve({ exitCode: code ?? 1 }));
      }),
    };
    const push = (chunk: Buffer) => {
      const data = chunk.toString("utf8");
      record.output = (record.output + data).slice(-64_000);
      this.onEvent({ type: "terminal_output", terminalId: id, data });
    };
    child.stdout?.on("data", push);
    child.stderr?.on("data", push);
    this.terminals.set(id, record);
    return { terminalId: id };
  }

  private terminalOutput(params: unknown): unknown {
    const id = idOf(params);
    return { output: this.terminals.get(id)?.output ?? "", truncated: false };
  }

  private async waitTerminal(params: unknown): Promise<unknown> {
    const terminal = this.terminals.get(idOf(params));
    if (!terminal) return { exitStatus: { exitCode: 1 } };
    const status = await terminal.exit;
    return { exitStatus: status, output: terminal.output };
  }

  private stopTerminal(params: unknown, kill: boolean): unknown {
    const id = idOf(params);
    const terminal = this.terminals.get(id);
    if (kill) terminal?.child.kill("SIGTERM");
    if (!kill) this.terminals.delete(id);
    return {};
  }

  private async confine(file: string): Promise<string> {
    if (!file || file.includes("\0")) throw new Error("invalid path");
    const root = await realpath(this.workspace);
    const resolved = path.resolve(root, file);
    try {
      const real = await realpath(resolved);
      if (!isInsidePath(root, real)) throw new Error("path is outside the workspace");
      return real;
    } catch (error) {
      if (error instanceof Error && error.message === "path is outside the workspace") throw error;
      const parent = await realpath(path.dirname(resolved));
      if (!isInsidePath(root, parent)) throw new Error("path is outside the workspace");
      return path.join(parent, path.basename(resolved));
    }
  }
}

function pathOf(params: unknown): string {
  if (!params || typeof params !== "object") return "";
  const value = (params as { path?: unknown }).path;
  return typeof value === "string" ? value : "";
}

function idOf(params: unknown): string {
  if (!params || typeof params !== "object") return "";
  const value = (params as { terminalId?: unknown }).terminalId;
  return typeof value === "string" ? value : "";
}

export function catalogFromSession(created: unknown): { modes: AgentOptionChoice[]; models: AgentOptionChoice[] } {
  const body = created && typeof created === "object" ? (created as { modes?: unknown; models?: unknown }) : {};
  const modes = readModes(body.modes);
  const models = readModels(body.models);
  return {
    modes: (modes?.availableModes ?? []).map((mode) => ({
      id: mode.id,
      name: mode.name,
      ...(mode.description ? { description: mode.description } : {}),
    })),
    models: (models?.availableModels ?? []).map((model) => ({ id: model.modelId, name: model.name })),
  };
}

export async function stopChild(child: ChildProcess | undefined) {
  if (!child?.pid) return;
  if (child.exitCode != null || child.signalCode != null) return;
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 500))]);
  if (child.exitCode == null && child.signalCode == null) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function readModes(value: unknown): AcpSession["modes"] {
  if (!value || typeof value !== "object") return null;
  const body = value as { currentModeId?: unknown; availableModes?: unknown };
  const available = Array.isArray(body.availableModes)
    ? body.availableModes
        .filter((item) => item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string")
        .map((item) => {
          const mode = item as { id: string; name?: string; description?: string };
          return { id: mode.id, name: mode.name || mode.id, description: mode.description };
        })
    : [];
  return { currentModeId: typeof body.currentModeId === "string" ? body.currentModeId : available[0]?.id || "agent", availableModes: available };
}

function readModels(value: unknown): AcpSession["models"] {
  if (!value || typeof value !== "object") return null;
  const body = value as { currentModelId?: unknown; availableModels?: unknown };
  const available = Array.isArray(body.availableModels)
    ? body.availableModels
        .filter((item) => item && typeof item === "object")
        .map((item) => {
          const model = item as { modelId?: unknown; id?: unknown; name?: string };
          const modelId = typeof model.modelId === "string" && model.modelId
            ? model.modelId
            : typeof model.id === "string"
              ? model.id
              : "";
          return { modelId, name: model.name || modelId };
        })
        .filter((model) => model.modelId)
    : [];
  const currentModelId = typeof body.currentModelId === "string" && body.currentModelId
    ? body.currentModelId
    : available[0]?.modelId || "";
  return { currentModelId, availableModels: available };
}
