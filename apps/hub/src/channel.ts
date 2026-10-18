import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import type { RunnerRequest, StreamEvent } from "@engineroom/protocol";
import { openRunnerSocket, type RunnerLink } from "./runner-client.ts";

export type PushMessage =
  | { id: "push"; type: "chat_event"; chatId: string; seq: number; at: string; event: StreamEvent }
  | { id: "push"; type: "chats_changed" }
  | { id: "push"; type: "pty"; chatId: string; data: string };

interface RunnerLine {
  id?: string;
  type?: string;
  result?: unknown;
  error?: string;
  event?: StreamEvent;
  chatId?: string;
  seq?: number;
  at?: string;
  data?: string;
}

export class RunnerChannel {
  private buf = "";
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  private readonly socket: Socket;
  private readonly onPush: (message: PushMessage) => void;

  private constructor(socket: Socket, onPush: (message: PushMessage) => void) {
    this.socket = socket;
    this.onPush = onPush;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.feed(chunk));
    socket.on("error", () => this.failAll(new Error("runner closed the connection")));
    socket.on("end", () => this.failAll(new Error("runner closed the connection")));
  }

  static async open(link: RunnerLink, username: string, uid: number, onPush: (message: PushMessage) => void): Promise<RunnerChannel> {
    const socket = await openRunnerSocket(link, username, uid);
    const channel = new RunnerChannel(socket, onPush);
    try {
      await channel.request({ id: randomUUID(), type: "subscribe" });
    } catch (error) {
      channel.close();
      throw error;
    }
    return channel;
  }

  request(request: RunnerRequest): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject });
      this.socket.write(`${JSON.stringify(request)}\n`);
    });
  }

  close() {
    this.socket.end();
  }

  private feed(chunk: string) {
    this.buf += chunk;
    let index = this.buf.indexOf("\n");
    while (index >= 0) {
      const line = this.buf.slice(0, index);
      this.buf = this.buf.slice(index + 1);
      index = this.buf.indexOf("\n");
      if (!line.trim()) continue;
      let message: RunnerLine;
      try {
        message = JSON.parse(line) as RunnerLine;
      } catch {
        continue;
      }
      if (message.id === "push") {
        if (message.type === "chat_event" && message.chatId && message.event && typeof message.seq === "number") {
          this.onPush({
            id: "push",
            type: "chat_event",
            chatId: message.chatId,
            seq: message.seq,
            at: message.at || new Date().toISOString(),
            event: message.event,
          });
        } else if (message.type === "chats_changed") {
          this.onPush({ id: "push", type: "chats_changed" });
        } else if (message.type === "pty" && message.chatId && typeof message.data === "string") {
          this.onPush({ id: "push", type: "pty", chatId: message.chatId, data: message.data });
        }
        continue;
      }
      if (!message.id) continue;
      const waiter = this.pending.get(message.id);
      if (!waiter) continue;
      this.pending.delete(message.id);
      if (message.type === "ok") waiter.resolve(message.result);
      else waiter.reject(new Error(message.error || "runner error"));
    }
  }

  private failAll(error: Error) {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
}
