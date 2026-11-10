import type { ChildProcess } from "node:child_process";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

export class JsonRpc {
  private next = 1;
  private pending = new Map<number, Pending>();
  private buf = "";
  private closed = false;

  private readonly child: ChildProcess;
  private readonly onRequest: (method: string, params: unknown, id: number) => Promise<unknown>;
  private readonly onNotify: (method: string, params: unknown) => void;

  constructor(
    child: ChildProcess,
    onRequest: (method: string, params: unknown, id: number) => Promise<unknown>,
    onNotify: (method: string, params: unknown) => void,
  ) {
    this.child = child;
    this.onRequest = onRequest;
    this.onNotify = onNotify;
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.feed(chunk));
    this.child.on("close", () => {
      this.closed = true;
      for (const waiter of this.pending.values()) waiter.reject(new Error("agent closed the connection"));
      this.pending.clear();
    });
  }

  request(method: string, params: unknown, timeoutMs = 0): Promise<unknown> {
    const id = this.next++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const waiter: Pending = {
        resolve: (value) => {
          if (waiter.timer) clearTimeout(waiter.timer);
          resolve(value);
        },
        reject: (error) => {
          if (waiter.timer) clearTimeout(waiter.timer);
          reject(error);
        },
      };
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          // Drop the waiter so a very late reply cannot resolve a request that
          // the caller already gave up on, and so timed-out requests do not
          // accumulate for the life of the agent process.
          this.pending.delete(id);
          reject(new Error(`agent did not answer to ${method}`));
        }, timeoutMs);
        waiter.timer.unref?.();
      }
      this.pending.set(id, waiter);
    });
  }

  notify(method: string, params: unknown) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  respond(id: number, result: unknown) {
    try {
      this.send({ jsonrpc: "2.0", id, result });
    } catch {
      /* the process closed before the reply could be written */
    }
  }

  fail(id: number, message: string) {
    try {
      this.send({ jsonrpc: "2.0", id, error: { code: -32000, message } });
    } catch {
      /* the process closed before the error could be written */
    }
  }

  private send(message: unknown) {
    if (this.closed || !this.child.stdin?.writable) throw new Error("agent is not running");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private feed(chunk: string) {
    this.buf += chunk;
    let index = this.buf.indexOf("\n");
    while (index >= 0) {
      const line = this.buf.slice(0, index);
      this.buf = this.buf.slice(index + 1);
      index = this.buf.indexOf("\n");
      if (!line.trim()) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof message.method === "string" && message.id != null) {
        void this.onRequest(message.method, message.params, message.id as number)
          .then((result) => this.respond(message.id as number, result))
          .catch((error: unknown) => this.fail(message.id as number, error instanceof Error ? error.message : "request failed"));
        continue;
      }
      if (typeof message.method === "string") {
        this.onNotify(message.method, message.params);
        continue;
      }
      if (typeof message.id === "number") {
        const waiter = this.pending.get(message.id);
        if (!waiter) continue;
        this.pending.delete(message.id);
        if (message.error) {
          const text = typeof (message.error as { message?: unknown }).message === "string"
            ? (message.error as { message: string }).message
            : "agent request failed";
          waiter.reject(new Error(text));
        } else waiter.resolve(message.result);
      }
    }
  }
}
