import assert from "node:assert/strict";
import test from "node:test";
import {
  applySettings,
  DEFAULT_SETTINGS,
  isInsidePath,
  loginAllowed,
  parseRunnerRequest,
  socketPathForUser,
} from "@engineroom/protocol";
import { createCliParser } from "@engineroom/protocol";
import { readSession, signSession } from "../apps/hub/src/session.ts";
import { claudeArgs, cursorArgs, piArgs } from "../apps/runner/src/cli.ts";
import { socketIdentityOk } from "../apps/hub/src/runner-client.ts";

test("login is limited to real user accounts in the group", () => {
  assert.equal(loginAllowed({ uid: 1000, shell: "/bin/bash", groups: ["engineroom-users"] }), true);
  assert.equal(loginAllowed({ uid: 0, shell: "/bin/bash", groups: ["engineroom-users"] }), false);
  assert.equal(loginAllowed({ uid: 1000, shell: "/usr/sbin/nologin", groups: ["engineroom-users"] }), false);
  assert.equal(loginAllowed({ uid: 1000, shell: "/bin/bash", groups: ["users"] }), false);
});

test("paths stay inside the home directory", () => {
  assert.equal(isInsidePath("/home/alice", "/home/alice"), true);
  assert.equal(isInsidePath("/home/alice", "/home/alice/proj"), true);
  assert.equal(isInsidePath("/home/alice", "/home/alice-evil"), false);
  assert.equal(isInsidePath("/home/alice", "/tmp/out"), false);
});

test("socket paths cannot escape the socket directory", () => {
  assert.equal(socketPathForUser("/run/engineroom", "alice"), "/run/engineroom/alice.sock");
  assert.throws(() => socketPathForUser("/run/engineroom", "../alice"));
  assert.throws(() => socketPathForUser("relative", "alice"));
});

test("runner requests reject a chat id that is not a uuid", () => {
  assert.throws(() => parseRunnerRequest({ id: "1", type: "get_chat", chatId: "../secret" }));
  const request = parseRunnerRequest({
    id: "1",
    type: "create_chat",
    agent: "cursor",
    model: "gpt",
  });
  assert.equal(request.type, "create_chat");
  const listed = parseRunnerRequest({ id: "2", type: "list_repositories" });
  assert.equal(listed.type, "list_repositories");
  const enabled = parseRunnerRequest({ id: "3", type: "set_repositories", enabled: ["/home/alice/proj"] });
  assert.equal(enabled.type, "set_repositories");
  if (enabled.type === "set_repositories") assert.deepEqual(enabled.enabled, ["/home/alice/proj"]);
  assert.throws(() => parseRunnerRequest({ id: "4", type: "set_repositories", enabled: "proj" }));
  assert.throws(() => parseRunnerRequest({ id: "5", type: "set_repositories", enabled: [""] }));
});

test("settings patch keeps the chosen agent and clears a blank binary", () => {
  const next = applySettings(DEFAULT_SETTINGS, {
    defaultAgent: "claude",
    defaultModel: "sonnet",
    binaries: { claude: null },
  });
  assert.equal(next.defaultAgent, "claude");
  assert.equal(next.defaultModel, "sonnet");
  assert.equal(next.binaries.claude, undefined);
});

test("session cookies are signed and expire", () => {
  const secret = Buffer.from("session-secret-value");
  const token = signSession("alice", secret, 1_700_000_000_000);
  assert.equal(readSession(token, secret, 1_700_000_000_000), "alice");
  assert.equal(readSession(`${token}x`, secret, 1_700_000_000_000), null);
  assert.equal(readSession(token, secret, 1_700_000_000_000 + 13 * 60 * 60 * 1000), null);
});

test("cli arguments match the headless auto-run contract", () => {
  assert.deepEqual(cursorArgs("/home/alice", "chat-1", "gpt", "hello"), [
    "-p",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--force",
    "--trust",
    "--workspace",
    "/home/alice",
    "--resume",
    "chat-1",
    "--model",
    "gpt",
    "--",
    "hello",
  ]);
  assert.ok(claudeArgs("", "sid", "hello").includes("bypassPermissions"));
  assert.ok(claudeArgs("", "sid", "hello").includes("--resume"));
  assert.deepEqual(piArgs("erabc123", "", "hello").slice(0, 4), ["--mode", "json", "--session-id", "erabc123"]);
});

test("claude resume keeps the original session id", () => {
  const parser = createCliParser("claude", "original-session");
  const events = parser.push({ type: "system", subtype: "init", session_id: "invocation-tag", model: "opus" });
  assert.equal(parser.sessionId, "original-session");
  assert.equal(events[0]?.type, "status");
  parser.push({ type: "result", subtype: "success", session_id: "invocation-tag", result: "" });
  assert.equal(parser.sessionId, "original-session");
});

test("cursor partial text is not repeated when a later snapshot arrives", () => {
  const parser = createCliParser("cursor", "chat-1");
  const first = parser.push({
    type: "assistant",
    message: { content: [{ type: "text", text: "hel" }] },
  });
  const second = parser.push({
    type: "assistant",
    message: { content: [{ type: "text", text: "lo" }] },
  });
  const flush = parser.push({
    type: "assistant",
    message: { content: [{ type: "text", text: "hello" }] },
  });
  assert.deepEqual(
    [...first, ...second, ...flush].filter((event) => event.type === "text_delta"),
    [
      { type: "text_delta", text: "hel" },
      { type: "text_delta", text: "lo" },
    ],
  );
  assert.equal(parser.sessionId, "chat-1");
});

test("cursor thinking and connection lines stay in the live stream", () => {
  const parser = createCliParser("cursor", "chat-1");
  const thinking = parser.push({ type: "thinking", subtype: "delta", text: "Looking at the file" });
  const done = parser.push({ type: "thinking", subtype: "completed" });
  const retry = parser.push({ type: "connection", subtype: "retrying" });
  assert.deepEqual(thinking, [{ type: "thinking", text: "Looking at the file" }]);
  assert.deepEqual(done, []);
  assert.deepEqual(retry, [{ type: "status", text: "connection · retrying" }]);
});

test("claude thinking deltas are kept", () => {
  const parser = createCliParser("claude", null);
  const events = parser.push({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } },
  });
  assert.deepEqual(events, [{ type: "thinking", text: "hmm" }]);
});

test("a fresh claude run records the first session id", () => {
  const parser = createCliParser("claude", null);
  parser.push({ type: "system", subtype: "init", session_id: "fresh" });
  assert.equal(parser.sessionId, "fresh");
});

test("socket identity accepts the user and a systemd listener, and rejects a swap", () => {
  assert.equal(socketIdentityOk(1000, 1000, 1000), true);
  assert.equal(socketIdentityOk(1000, 0, 1000), true);
  assert.equal(socketIdentityOk(1001, 1001, 1000), false);
  assert.equal(socketIdentityOk(1000, 1001, 1000), false);
});
