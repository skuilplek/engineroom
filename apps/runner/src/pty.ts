import type { AgentId } from "@engineroom/protocol";

const SCROLL_LIMIT = 256 * 1024;
const IDLE_MS = 10 * 60 * 1000;

export interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: () => void): void;
}

export interface PtyLaunch {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
}

interface LivePty {
  proc: PtyProcess;
  scroll: string;
  refs: number;
  timer: NodeJS.Timeout | null;
  listeners: Set<(data: string) => void>;
}

export function ptyCommand(agent: AgentId, sessionId: string | null, workspace: string): { args: string[] } {
  if (agent === "cursor") {
    const args = ["--workspace", workspace];
    if (sessionId) args.push("--resume", sessionId);
    return { args };
  }
  if (agent === "claude") return { args: sessionId ? ["--resume", sessionId] : [] };
  return { args: sessionId ? ["--session-id", sessionId] : [] };
}

export class PtyManager {
  private sessions = new Map<string, LivePty>();

  private readonly spawn: (launch: PtyLaunch) => Promise<PtyProcess> | PtyProcess;

  constructor(spawn: (launch: PtyLaunch) => Promise<PtyProcess> | PtyProcess = defaultSpawn) {
    this.spawn = spawn;
  }

  has(chatId: string): boolean {
    return this.sessions.has(chatId);
  }

  scrollback(chatId: string): string {
    return this.sessions.get(chatId)?.scroll ?? "";
  }

  async open(chatId: string, launch: PtyLaunch, onData: (data: string) => void): Promise<string> {
    let live = this.sessions.get(chatId);
    if (!live) {
      const proc = await this.spawn(launch);
      live = { proc, scroll: "", refs: 0, timer: null, listeners: new Set() };
      proc.onData((data) => {
        if (!live) return;
        live.scroll = (live.scroll + data).slice(-SCROLL_LIMIT);
        for (const listener of live.listeners) listener(data);
      });
      proc.onExit(() => {
        this.sessions.delete(chatId);
      });
      live.listeners.add(onData);
      this.sessions.set(chatId, live);
    }
    this.retain(chatId);
    return live.scroll;
  }

  retain(chatId: string) {
    const live = this.sessions.get(chatId);
    if (!live) return;
    live.refs += 1;
    if (live.timer) clearTimeout(live.timer);
    live.timer = null;
  }

  release(chatId: string) {
    const live = this.sessions.get(chatId);
    if (!live) return;
    live.refs = Math.max(0, live.refs - 1);
    if (live.refs > 0) return;
    if (live.timer) clearTimeout(live.timer);
    live.timer = setTimeout(() => this.close(chatId), IDLE_MS);
    live.timer.unref?.();
  }

  write(chatId: string, data: string) {
    this.sessions.get(chatId)?.proc.write(data);
  }

  resize(chatId: string, cols: number, rows: number) {
    this.sessions.get(chatId)?.proc.resize(cols, rows);
  }

  closeAll() {
    for (const chatId of [...this.sessions.keys()]) this.close(chatId);
  }

  close(chatId: string) {
    const live = this.sessions.get(chatId);
    if (!live) return;
    if (live.timer) clearTimeout(live.timer);
    this.sessions.delete(chatId);
    try {
      live.proc.kill("SIGHUP");
    } catch {
      /* already gone */
    }
  }
}

declare module "node-pty" {
  export function spawn(
    file: string,
    args: string[],
    options: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv },
  ): {
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
    onData(cb: (data: string) => void): void;
    onExit(cb: (code: number) => void): void;
  };
}

async function defaultSpawn(launch: PtyLaunch): Promise<PtyProcess> {
  const pty = await import("node-pty").catch(() => {
    throw new Error("node-pty is not installed");
  });
  const term = pty.spawn(launch.file, launch.args, {
    name: "xterm-256color",
    cols: launch.cols,
    rows: launch.rows,
    cwd: launch.cwd,
    env: { ...launch.env, TERM: "xterm-256color" },
  });
  return {
    write: (data) => term.write(data),
    resize: (cols, rows) => term.resize(cols, rows),
    kill: (signal) => term.kill(signal),
    onData: (cb) => term.onData(cb),
    onExit: (cb) => term.onExit(() => cb()),
  };
}
