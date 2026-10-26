import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMeta } from "@engineroom/protocol";
import { mapUpdate } from "../apps/runner/src/acp/map.ts";
import { applyEvent, applySnapshot, emptyLive } from "../apps/web/src/chat/state.ts";

const chat: ChatMeta = {
  id: "chat",
  title: "Hello",
  agent: "cursor",
  model: "",
  workspace: "/tmp",
  agentSessionId: null,
  createdAt: "",
  updatedAt: "",
  mode: "agent",
};

test("a late snapshot keeps agent text that already arrived", () => {
  let live = emptyLive(chat);
  live = applyEvent(live, { type: "user_message", text: "hi" }, 1);
  live = applyEvent(live, { type: "turn_start" }, 2);
  live = applyEvent(live, { type: "text_delta", text: "answer" }, 3);
  live = applySnapshot(live, {
    transcript: [{ kind: "user", text: "hi", at: "", seq: 1 }],
    seq: 1,
    running: true,
    chat,
  });
  assert.equal(live.ready, true);
  assert.equal(live.title, "Hello");
  assert.equal(live.seq, 3);
  assert.equal(live.running, true);
  assert.deepEqual(
    live.entries.map((entry) => ("text" in entry ? entry.text : entry.kind)),
    ["hi", "answer"],
  );
  live = applyEvent(live, { type: "turn_end" }, 4);
  live = applySnapshot(live, {
    transcript: [{ kind: "user", text: "hi", at: "", seq: 1 }],
    seq: 1,
    running: true,
    chat,
  });
  assert.equal(live.running, false);
  assert.equal(live.entries.some((entry) => entry.kind === "text" && entry.text === "answer"), true);
});

test("tool updates keep nested result text and file locations", () => {
  assert.deepEqual(
    mapUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      status: "completed",
      kind: "search",
      title: "Find `**/*.log`",
      content: [{ type: "content", content: { type: "text", text: "a.log\nb.log" } }],
      locations: [{ path: "a.log" }, { path: "b.log" }],
    }),
    [{
      type: "tool",
      id: "call-1",
      name: "Find `**/*.log`",
      phase: "done",
      input: undefined,
      output: "a.log\nb.log",
      toolKind: "search",
      title: "Find `**/*.log`",
      status: "completed",
      locations: ["a.log", "b.log"],
      content: [{ type: "text", text: "a.log\nb.log" }],
    }],
  );
});

test("agent text chunks accept a list of blocks", () => {
  assert.deepEqual(
    mapUpdate({
      sessionUpdate: "agent_message_chunk",
      content: [
        { type: "text", text: "hello " },
        { type: "text", text: "there" },
      ],
    }),
    [{ type: "text_delta", text: "hello there" }],
  );
});
