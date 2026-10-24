import assert from "node:assert/strict";
import test from "node:test";
import { AgentSocket, type AgentTransport } from "../apps/web/src/socket.ts";

const alice = "11111111-1111-1111-1111-111111111111";
const bob = "22222222-2222-2222-2222-222222222222";

class FakeSocket implements AgentTransport {
  readyState = 0;
  binaryType = "";
  sent: Array<string | Uint8Array> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;

  send(data: string | Uint8Array) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const later: Array<() => void> = [];
  const link = new AgentSocket(
    () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    () => "ws://hub/api/ws",
    (fn) => {
      later.push(fn);
    },
  );
  return { link, sockets, later };
}

test("sign-out drops the previous user's socket, watches, and queued commands", () => {
  const { link, sockets } = harness();
  link.watchChat(alice, 4);
  link.sendCommand({ type: "prompt", chatId: alice, prompt: "old" });
  link.start();
  sockets[0]?.open();
  assert.equal(sockets[0]?.sent.some((item) => String(item).includes(alice)), true);

  link.stop();
  assert.equal(sockets[0]?.readyState, 3);

  link.watchChat(bob, 0);
  link.start();
  assert.equal(sockets.length, 2);
  sockets[1]?.open();
  const next = sockets[1]?.sent.map(String).join("\n") ?? "";
  assert.equal(next.includes(alice), false);
  assert.equal(next.includes("old"), false);
  assert.equal(next.includes(bob), true);
});

test("a dropped connection reconnects, and sign-out cancels that reconnect", () => {
  const { link, sockets, later } = harness();
  link.start();
  sockets[0]?.open();
  link.watchChat(alice, 0);
  sockets[0]?.close();
  assert.equal(later.length, 1);

  later[0]?.();
  assert.equal(sockets.length, 2);
  sockets[1]?.open();
  assert.equal(sockets[1]?.sent.some((item) => String(item).includes(alice)), true);

  sockets[1]?.close();
  assert.equal(later.length, 2);
  link.stop();
  later[1]?.();
  assert.equal(sockets.length, 2);
});
