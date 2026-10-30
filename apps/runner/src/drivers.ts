import { agentLabel, createCliParser, type AgentId, type BuiltinAgentId, type Settings, type StreamEvent } from "@engineroom/protocol";
import {
  binaryNames,
  childEnv,
  cursorArgs,
  parseCliId,
  piArgs,
  resolveBinary,
  runCapture,
  runCli,
} from "./cli.ts";
import { binaryFor, loadPolicy } from "./policy.ts";

export interface DriverContext {
  home: string;
  workspace: string;
  model: string;
  prompt: string;
  agentSessionId: string | null;
  settings: Settings;
  signal: AbortSignal;
  onEvent: (event: StreamEvent) => void;
  env?: NodeJS.ProcessEnv;
}

export interface AgentDriver {
  id: BuiltinAgentId;
  run(ctx: DriverContext): Promise<{ agentSessionId: string | null }>;
}

export function defaultDrivers(): Record<BuiltinAgentId, AgentDriver> {
  return {
    cursor: { id: "cursor", run: runCursor },
    pi: { id: "pi", run: runPi },
  };
}

async function prepare(agent: AgentId, ctx: DriverContext) {
  const env = childEnv(ctx.env ?? process.env, ctx.home);
  const policy = await loadPolicy(ctx.home);
  const binary = await resolveBinary(binaryFor(policy, ctx.settings, agent, ctx.home), binaryNames(agent), env);
  return { env, binary };
}

async function runCursor(ctx: DriverContext): Promise<{ agentSessionId: string | null }> {
  const { env, binary } = await prepare("cursor", ctx);
  let sessionId = ctx.agentSessionId;
  if (!sessionId) {
    ctx.onEvent({ type: "status", text: "Opening an agent session" });
    const created = await runCapture({
      binary,
      args: ["create-chat"],
      cwd: ctx.workspace,
      env,
      signal: ctx.signal,
    });
    if (ctx.signal.aborted) {
      ctx.onEvent({ type: "status", text: "Stopped" });
      ctx.onEvent({ type: "done", agentSessionId: null });
      return { agentSessionId: null };
    }
    if (created.code !== 0) {
      throw new Error(created.stderr.trim() || "agent create-chat failed");
    }
    sessionId = parseCliId(created.stdout);
  }
  return streamAgent({
    agent: "cursor",
    binary,
    args: cursorArgs(ctx.workspace, sessionId, ctx.model, ctx.prompt, ctx.settings.permission),
    sessionId,
    ctx,
    env,
  });
}

async function runPi(ctx: DriverContext): Promise<{ agentSessionId: string | null }> {
  const { env, binary } = await prepare("pi", ctx);
  if (!ctx.agentSessionId) throw new Error("pi chat is missing a session id");
  return streamAgent({
    agent: "pi",
    binary,
    args: piArgs(ctx.agentSessionId, ctx.model, ctx.prompt),
    sessionId: ctx.agentSessionId,
    ctx,
    env,
  });
}

async function streamAgent(options: {
  agent: AgentId;
  binary: string;
  args: string[];
  sessionId: string | null;
  ctx: DriverContext;
  env: NodeJS.ProcessEnv;
}): Promise<{ agentSessionId: string | null }> {
  const parser = createCliParser(options.agent, options.sessionId);
  let sawDone = false;
  const emit = (event: StreamEvent) => {
    if (sawDone) return;
    if (event.type === "done") sawDone = true;
    options.ctx.onEvent(event);
  };
  emit({
    type: "status",
    text: options.ctx.model
      ? `${agentLabel(options.agent)} · ${options.ctx.model}. Starting. The first output can take a minute.`
      : `${agentLabel(options.agent)}. Starting. The first output can take a minute.`,
  });
  const result = await runCli({
    binary: options.binary,
    args: options.args,
    cwd: options.ctx.workspace,
    env: options.env,
    signal: options.ctx.signal,
    onLine: (line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      for (const event of parser.push(parsed)) emit(event);
    },
  });
  if (options.ctx.signal.aborted) {
    emit({ type: "status", text: "Stopped" });
    emit({ type: "done", agentSessionId: parser.sessionId });
    return { agentSessionId: parser.sessionId ?? options.sessionId };
  }
  const flushed = parser.finish();
  for (const event of flushed) emit(event);
  if (result.code !== 0 && !sawDone && !flushed.some((event) => event.type === "error")) {
    const detail = result.stderr.trim().split("\n").slice(-4).join("\n");
    emit({ type: "error", text: detail || `${options.agent} exited with code ${result.code}` });
  }
  emit({ type: "done", agentSessionId: parser.sessionId ?? options.sessionId });
  return { agentSessionId: parser.sessionId ?? options.sessionId };
}
