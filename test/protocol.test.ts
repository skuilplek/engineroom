import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applySettings,
  assertGitUrl,
  DEFAULT_SETTINGS,
  isInsidePath,
  loginAllowed,
  parseCatalogEntries,
  parseEnvEntries,
  effectiveAgentOptions,
  parseClientCommand,
  parseRunnerRequest,
  parseSettingsPatch,
  parseUserPolicy,
  socketPathForUser,
} from "@engineroom/protocol";
import { createCliParser } from "@engineroom/protocol";
import { readSession, signSession } from "../apps/hub/src/session.ts";
import { childEnv, claudeArgs, cursorArgs, piArgs } from "../apps/runner/src/cli.ts";
import { applyEnvEntries } from "../apps/runner/src/envfile.ts";
import { socketIdentityOk } from "../apps/hub/src/runner-client.ts";

test("login is limited to real user accounts in the group", () => {
  assert.equal(loginAllowed({ uid: 1000, shell: "/bin/bash", groups: ["engineroom-users"] }), true);
  assert.equal(loginAllowed({ uid: 501, shell: "/bin/bash", groups: ["engineroom-users"] }), true);
  assert.equal(loginAllowed({ uid: 499, shell: "/bin/bash", groups: ["engineroom-users"] }), false);
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
  const watched = parseRunnerRequest({
    id: "6",
    type: "watch",
    chatId: "11111111-1111-1111-1111-111111111111",
    lastSeq: 3,
  });
  assert.equal(watched.type, "watch");
  assert.throws(() => parseRunnerRequest({ id: "7", type: "pty_open", chatId: "11111111-1111-1111-1111-111111111111", cols: 0, rows: 24 }));
  const command = parseClientCommand({ type: "prompt", chatId: "11111111-1111-1111-1111-111111111111", prompt: "hi" });
  assert.equal(command.type, "prompt");
});

test("catalog urls and names stay on a remote", async () => {
  const { assertRepoDirectory } = await import("@engineroom/protocol");
  assert.equal(assertRepoDirectory("Sites"), "Sites");
  assert.equal(assertRepoDirectory(" work/repos "), "work/repos");
  assert.throws(() => assertRepoDirectory("../Sites"));
  assert.throws(() => assertRepoDirectory("/tmp/repos"));
  assert.throws(() => assertRepoDirectory(".hidden"));
  const detected = parseRunnerRequest({ id: "8", type: "detect_repositories", directory: "Sites" });
  assert.equal(detected.type, "detect_repositories");
  assert.throws(() => parseRunnerRequest({ id: "9", type: "detect_repositories", directory: "node_modules" }));
  assert.equal(assertGitUrl("https://github.com/org/repo.git"), "https://github.com/org/repo.git");
  assert.equal(assertGitUrl("ssh://git@github.com/org/repo.git"), "ssh://git@github.com/org/repo.git");
  assert.equal(assertGitUrl("git@github.com:org/repo.git"), "git@github.com:org/repo.git");
  assert.throws(() => assertGitUrl("file:///tmp/repo.git"));
  assert.throws(() => assertGitUrl("https://user:secret@github.com/org/repo.git"));
  assert.throws(() => assertGitUrl("ext::sh -c evil"));
  assert.throws(() => parseCatalogEntries([{ id: "11111111-1111-1111-1111-111111111111", name: ".hidden", url: "https://github.com/org/repo.git" }]));
  const policy = parseUserPolicy({ agents: ["cursor"], rawTerminal: false, binaries: { cursor: "/usr/bin/agent" } });
  assert.deepEqual(policy.agents, ["cursor"]);
  assert.equal(policy.rawTerminal, false);
  assert.throws(() => parseUserPolicy({ agents: [], rawTerminal: true }));
  assert.throws(() => parseEnvEntries([{ key: "HOME", value: "ok\nno" }]));
  const rewritten = applyEnvEntries("# keep\nOLD=1\nANTHROPIC_API_KEY=before\n", [{ key: "ANTHROPIC_API_KEY", value: "secret" }]);
  assert.match(rewritten, /# keep/);
  assert.equal(rewritten.includes("OLD="), false);
  assert.match(rewritten, /ANTHROPIC_API_KEY=secret/);
});

test("child env takes ~/.env values except identity and loader variables", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "er-env-"));
  try {
    await writeFile(path.join(home, ".env"), "HOME=/tmp/elsewhere\nPATH=/tmp/bin\nLD_PRELOAD=/tmp/lib.so\nLISTEN_FDS=3\nANTHROPIC_API_KEY=secret\nCUSTOM=1\n");
    const env = childEnv({ PATH: "/usr/bin" }, home);
    assert.equal(env.HOME, home);
    assert.equal(env.PATH?.startsWith("/tmp/bin"), false);
    assert.equal(env.LD_PRELOAD, undefined);
    assert.equal(env.LISTEN_FDS, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, "secret");
    assert.equal(env.CUSTOM, "1");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("policy options stay optional and narrow the offered catalog", () => {
  const inherited = parseUserPolicy({ agents: ["cursor"], rawTerminal: true });
  assert.equal(inherited.options, undefined);
  const narrowed = parseUserPolicy({
    agents: ["cursor"],
    rawTerminal: false,
    options: { cursor: { modes: ["agent", "plan"], models: ["gpt-5"] } },
  });
  assert.deepEqual(narrowed.options?.cursor, { modes: ["agent", "plan"], models: ["gpt-5"] });
  assert.throws(() => parseUserPolicy({
    agents: ["cursor"],
    rawTerminal: true,
    options: { cursor: { modes: ["bad\nmode"], models: [] } },
  }));
  const effective = effectiveAgentOptions(
    {
      modes: [{ id: "agent", name: "Agent" }, { id: "plan", name: "Plan" }],
      models: [{ id: "gpt-5", name: "GPT" }, { id: "opus", name: "Opus" }],
    },
    { modes: ["agent", "plan"], models: ["gpt-5"] },
    { modes: ["plan", "ask"], models: ["opus", "gpt-5"] },
  );
  assert.deepEqual(effective.modes.map((mode) => mode.id), ["plan"]);
  assert.deepEqual(effective.models.map((model) => model.id), ["gpt-5"]);
  const open = effectiveAgentOptions(
    { modes: [{ id: "agent", name: "Agent" }], models: [] },
    { modes: ["agent"], models: [] },
    undefined,
  );
  assert.deepEqual(open.modes.map((mode) => mode.id), ["agent"]);
  const probed = parseRunnerRequest({ id: "1", type: "probe_agent", agent: "cursor" });
  assert.equal(probed.type, "probe_agent");
  assert.throws(() => parseRunnerRequest({ id: "2", type: "probe_agent", agent: "nope" }));
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
  assert.equal(next.theme, "dark");
  const themed = applySettings(next, { theme: "light" });
  assert.equal(themed.theme, "light");
  assert.equal(applySettings(themed, { defaultModel: "opus" }).theme, "light");
  assert.throws(() => parseSettingsPatch({ theme: "sepia" }), /invalid theme/);
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

test("repository file requests validate relative paths and visibility flags", async () => {
  const { assertRepoRelativePath, parseFileVisibility } = await import("@engineroom/protocol");
  assert.equal(assertRepoRelativePath("src/index.ts"), "src/index.ts");
  assert.equal(assertRepoRelativePath(" .env "), ".env");
  assert.throws(() => assertRepoRelativePath(""));
  assert.throws(() => assertRepoRelativePath("/etc/passwd"));
  assert.throws(() => assertRepoRelativePath("../secret.txt"));
  assert.throws(() => assertRepoRelativePath("a/../b"));
  assert.throws(() => assertRepoRelativePath("a\\b"));

  assert.deepEqual(parseFileVisibility(undefined), {
    showHidden: false,
    showGitignored: false,
    showGitDir: false,
  });
  assert.deepEqual(parseFileVisibility({ showHidden: true }), {
    showHidden: true,
    showGitignored: false,
    showGitDir: false,
  });
  assert.throws(() => parseFileVisibility({ showHidden: "yes" }));

  const listReq = parseRunnerRequest({
    id: "10",
    type: "list_repo_files",
    workspace: "/home/alice/Sites/proj",
    visibility: { showHidden: true, showGitignored: false, showGitDir: false },
  });
  assert.equal(listReq.type, "list_repo_files");

  const readReq = parseRunnerRequest({
    id: "11",
    type: "read_repo_file",
    workspace: "/home/alice/Sites/proj",
    path: "src/app.ts",
  });
  assert.equal(readReq.type, "read_repo_file");
  assert.throws(() =>
    parseRunnerRequest({
      id: "12",
      type: "read_repo_file",
      workspace: "/home/alice/Sites/proj",
      path: "../outside.ts",
    }),
  );
});

