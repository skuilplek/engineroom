import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isInsidePath, type AgentOptionChoice, type PermissionOption, type PermissionPolicy, type StreamEvent } from "@engineroom/protocol";
import { mapUpdate } from "./map.ts";
import { JsonRpc } from "./rpc.ts";

export class AcpUnavailable extends Error {
  constructor(message = "acp adapter is not installed") {
    super(message);
    this.name = "AcpUnavailable";
  }
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
  onEvent: (event: StreamEvent) => void;
}

interface LiveTerminal {
  child: ChildProcess;
  output: string;
  exit: Promise<{ exitCode: number }>;
}

export class AcpSession {
  readonly id: string;
  sessionId: string | null = null;
  modes: { currentModeId: string; availableModes: { id: string; name: string; description?: string }[] } | null = null;
  models: { currentModelId: string; availableModels: { modelId: string; name: string }[] } | null = null;
  alive = true;
  private rpc!: JsonRpc;
  private child!: ChildProcess;
  private suppress = false;
  private ignoreUser = false;
  private permissions = new Map<string, (optionId: string) => void>();
  private terminals = new Map<string, LiveTerminal>();
  private workspace = "";

  private readonly start: AcpStart;

  constructor(start: AcpStart) {
    this.start = start;
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
    const initialized = (await rpcTimeout(
      this.rpc.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
        clientInfo: { name: "engineroom", version: "0.1.0" },
      }),
    )) as { authMethods?: { id: string }[] };
    const method = initialized.authMethods?.[0]?.id;
    if (method) await rpcTimeout(this.rpc.request("authenticate", { methodId: method }));
    if (this.start.needsResync) this.suppress = false;
    else this.suppress = Boolean(this.start.sessionId);
    const created = this.start.sessionId
      ? ((await rpcTimeout(
          this.rpc.request("session/load", {
            sessionId: this.start.sessionId,
            cwd: this.start.cwd,
            mcpServers: [],
          }),
        )) as Record<string, unknown>)
      : ((await rpcTimeout(this.rpc.request("session/new", { cwd: this.start.cwd, mcpServers: [] }))) as Record<string, unknown>);
    this.suppress = false;
    this.sessionId = typeof created.sessionId === "string" ? created.sessionId : this.start.sessionId;
    if (!this.sessionId) throw new Error(stderr.trim() || "agent did not open a session");
    this.modes = readModes(created.modes);
    this.models = readModels(created.models);
    if (this.start.mode) await this.setMode(this.start.mode).catch(() => undefined);
    if (this.start.model) await this.setModel(this.start.model).catch(() => undefined);
    return this.sessionId;
  }

  async prompt(text: string, signal: AbortSignal): Promise<{ stopReason?: string }> {
    if (!this.sessionId) throw new Error("session is not open");
    const onAbort = () => this.cancel();
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    this.ignoreUser = true;
    try {
      const result = (await this.rpc.request("session/prompt", {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text }],
      })) as { stopReason?: string };
      this.start.onEvent({ type: "turn_end", stopReason: result.stopReason });
      this.start.onEvent({ type: "done", agentSessionId: this.sessionId });
      return result;
    } finally {
      this.ignoreUser = false;
      signal.removeEventListener("abort", onAbort);
    }
  }

  cancel() {
    if (!this.sessionId || !this.alive) return;
    try {
      this.rpc.notify("session/cancel", { sessionId: this.sessionId });
    } catch {
      /* the process is already gone */
    }
  }

  respond(requestId: string, optionId: string): boolean {
    const resolve = this.permissions.get(requestId);
    if (!resolve) return false;
    this.permissions.delete(requestId);
    resolve(optionId);
    this.start.onEvent({ type: "permission_resolved", requestId, optionId });
    return true;
  }

  async setMode(modeId: string) {
    if (!this.sessionId) return;
    await rpcTimeout(this.rpc.request("session/set_mode", { sessionId: this.sessionId, modeId }));
    if (this.modes) this.modes = { ...this.modes, currentModeId: modeId };
    this.start.onEvent({ type: "mode", modeId });
  }

  async setModel(modelId: string) {
    if (!this.sessionId || !modelId) return;
    await rpcTimeout(this.rpc.request("session/set_model", { sessionId: this.sessionId, modelId }));
    if (this.models) this.models = { ...this.models, currentModelId: modelId };
  }

  async stop() {
    this.alive = false;
    await Promise.all([...this.terminals.values()].map((terminal) => stopChild(terminal.child)));
    this.terminals.clear();
    await stopChild(this.child);
  }

  private note(method: string, params: unknown) {
    if (method !== "session/update" || !params || typeof params !== "object") return;
    const update = (params as { update?: unknown }).update;
    if (this.suppress) return;
    for (const event of mapUpdate(update)) {
      if (event.type === "user_message" && this.ignoreUser) continue;
      this.start.onEvent(event);
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
    this.start.onEvent({
      type: "permission_request",
      requestId,
      toolCallId: body.toolCall?.toolCallId,
      title: body.toolCall?.title,
      options: options.map((item) => ({ optionId: item.optionId, name: item.name || item.optionId, kind: item.kind || "allow_once" })),
    });
    const optionId = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.permissions.delete(requestId);
        reject(new Error("permission timed out"));
      }, 120_000);
      timer.unref?.();
      this.permissions.set(requestId, (selected) => {
        clearTimeout(timer);
        resolve(selected);
      });
    });
    return { outcome: { outcome: "selected", optionId } };
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
      this.start.onEvent({ type: "terminal_output", terminalId: id, data });
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

export function rpcTimeout<T>(work: Promise<T>, ms = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("agent did not answer")), ms);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("agent request failed"));
      },
    );
  });
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
        .filter((item) => item && typeof item === "object" && typeof (item as { modelId?: unknown }).modelId === "string")
        .map((item) => {
          const model = item as { modelId: string; name?: string };
          return { modelId: model.modelId, name: model.name || model.modelId };
        })
    : [];
  return { currentModelId: typeof body.currentModelId === "string" ? body.currentModelId : "", availableModels: available };
}
