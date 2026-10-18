import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ChatBus } from "../apps/runner/src/bus.ts";
import { TranscriptWriter } from "../apps/runner/src/persist.ts";
import { createChat, getChat } from "../apps/runner/src/store.ts";

test("the bus numbers events and replays after a cursor", () => {
  const bus = new ChatBus(3);
  const seen: number[] = [];
  bus.add({
    send(message) {
      if (message.type === "chat_event") seen.push(message.seq);
    },
  });
  const chat = "11111111-1111-1111-1111-111111111111";
  bus.init(chat, 4);
  bus.publish(chat, { type: "status", text: "a" });
  bus.publish(chat, { type: "status", text: "b" });
  bus.publish(chat, { type: "status", text: "c" });
  bus.publish(chat, { type: "status", text: "d" });
  assert.deepEqual(seen, [5, 6, 7, 8]);
  assert.deepEqual(bus.since(chat, 6).map((item) => item.seq), [7, 8]);
  assert.equal(bus.since(chat, 4).some((item) => item.seq === 5), false);
});

test("text deltas collapse into one transcript line", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "er-bus-"));
  try {
    const chat = await createChat(home, { title: "notes" });
    const writer = new TranscriptWriter(home);
    await writer.record(chat.id, { type: "user_message", text: "hi" }, 1);
    await writer.record(chat.id, { type: "text_delta", text: "hel" }, 2);
    await writer.record(chat.id, { type: "text_delta", text: "lo" }, 3);
    await writer.record(chat.id, { type: "tool", id: "t", name: "read", phase: "start" }, 4);
    await writer.flush(chat.id);
    const detail = await getChat(home, chat.id, false);
    assert.equal(detail.transcript.filter((entry) => entry.kind === "text").length, 1);
    assert.equal(detail.transcript.find((entry) => entry.kind === "text" && entry.text === "hello")?.seq, 3);
    assert.equal(detail.transcript.at(-1)?.seq, 4);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
