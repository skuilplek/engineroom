import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  agentLabel,
  agentSlug,
  applySettings,
  assertBranchName,
  assertGitUrl,
  DEFAULT_SETTINGS,
  isCommandBlockStyle,
  isInsidePath,
  isTheme,
  isThemeId,
  resolveTheme,
  loginAllowed,
  parseCatalogEntries,
  parseEnvEntries,
  effectiveAgentOptions,
  mergeCursorConfig,
  mergePiDefaults,
  parseClientCommand,
  piDefaultAllowed,
  readShellCommands,
  parseAgentCatalog,
  parseAgentCommand,
  parseRunnerRequest,
  parseSettingsPatch,
  parseTransferBase64,
  repoUploadPath,
  defaultPolicy,
  parseUserPolicy,
  socketPathForUser,
  THEMES,
} from "@engineroom/protocol";
import { createCliParser } from "@engineroom/protocol";
import { readSession, signSession } from "../apps/hub/src/session.ts";
import { childEnv, claudeArgs, cursorArgs, parseLoginPath, parsePiModelList, piArgs, resolveBinary } from "../apps/runner/src/cli.ts";
import { applyEnvEntries } from "../apps/runner/src/envfile.ts";
import { socketIdentityOk } from "../apps/hub/src/runner-client.ts";

test("agent labels follow the catalog and custom slugs stay separate from commands", () => {
  assert.equal(agentLabel("cursor"), "Cursor");
  assert.equal(agentLabel("claude"), "Claude");
  assert.equal(agentLabel("pi"), "Pi");
  assert.equal(agentLabel("codex", [{ id: "codex", label: "Codex" }]), "Codex");
  assert.equal(agentSlug("Codex CLI"), "codex-cli");
  assert.throws(() => agentSlug("123"), /invalid agent/);
  const catalog = parseAgentCatalog([{ id: "codex", label: "Codex", binary: "codex" }]);
  assert.deepEqual(catalog, [{ id: "codex", label: "Codex", binary: "codex" }]);
  assert.throws(() => parseAgentCatalog([{ id: "cursor", label: "Cursor", binary: "agent" }]), /invalid agents/);
  assert.throws(() => parseAgentCatalog([{ id: "codex", label: "Codex", binary: "../codex" }]), /absolute path/);
  assert.equal(parseAgentCommand("/usr/local/bin/codex"), "/usr/local/bin/codex");
  const policy = parseUserPolicy({ agents: ["cursor", "codex"], rawTerminal: true, binaries: { codex: "/opt/codex" } });
  assert.deepEqual(policy.agents, ["cursor", "codex"]);
  assert.equal(policy.binaries.codex, "/opt/codex");
});

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
  assert.equal(isInsidePath("/home/alice", "/home/alice/../../etc/passwd"), false);
  assert.equal(isInsidePath("/home/alice", "/home/alice/proj/../notes"), true);
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
    mode: "plan",
  });
  assert.equal(request.type, "create_chat");
  if (request.type === "create_chat") assert.equal(request.mode, "plan");
  const blankMode = parseRunnerRequest({ id: "1b", type: "create_chat", mode: "" });
  if (blankMode.type === "create_chat") assert.equal(blankMode.mode, "");
  assert.throws(() => parseRunnerRequest({ id: "1c", type: "create_chat", mode: "bad mode" }));
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
  assert.equal(policy.fileManager, true);
  assert.equal(policy.fileDownload, true);
  assert.equal(policy.fileUpload, true);
  assert.equal(policy.projectCreate, true);
  assert.equal(defaultPolicy().fileManager, true);
  assert.equal(defaultPolicy().fileDownload, true);
  assert.equal(defaultPolicy().fileUpload, true);
  assert.equal(defaultPolicy().projectCreate, true);
  assert.equal(parseUserPolicy({ agents: ["cursor"], rawTerminal: true, fileManager: true }).fileManager, true);
  assert.equal(parseUserPolicy({ agents: ["cursor"], rawTerminal: true, fileManager: false }).fileManager, false);
  assert.equal(parseUserPolicy({ agents: ["cursor"], rawTerminal: true, fileDownload: false, fileUpload: false }).fileDownload, false);
  assert.equal(parseUserPolicy({ agents: ["cursor"], rawTerminal: true, fileDownload: false, fileUpload: false }).fileUpload, false);
  assert.equal(parseUserPolicy({ agents: ["cursor"], rawTerminal: true, projectCreate: false }).projectCreate, false);
  assert.throws(() => parseUserPolicy({ agents: ["cursor"], rawTerminal: true, fileDownload: "yes" }));
  assert.throws(() => parseUserPolicy({ agents: ["cursor"], rawTerminal: true, projectCreate: "yes" }));
  const initialized = parseRunnerRequest({ id: "10", type: "create_repository", name: " widget ", directory: "Sites" });
  assert.equal(initialized.type, "create_repository");
  if (initialized.type === "create_repository") {
    assert.equal(initialized.name, "widget");
    assert.equal(initialized.directory, "Sites");
    assert.equal(initialized.url, undefined);
  }
  const cloned = parseRunnerRequest({
    id: "11",
    type: "create_repository",
    name: "widget",
    directory: "Sites",
    url: "https://github.com/org/repo.git",
  });
  if (cloned.type === "create_repository") assert.equal(cloned.url, "https://github.com/org/repo.git");
  assert.throws(() => parseRunnerRequest({ id: "12", type: "create_repository", name: "../widget", directory: "Sites" }));
  assert.throws(() => parseRunnerRequest({ id: "13", type: "create_repository", name: "widget", directory: "Sites", url: "file:///tmp/repo.git" }));
  assert.equal(repoUploadPath("src", "notes.txt"), "src/notes.txt");
  assert.equal(repoUploadPath("", "notes.txt"), "notes.txt");
  assert.throws(() => repoUploadPath("src", "../secret"));
  assert.equal(parseTransferBase64("aGVsbG8="), "aGVsbG8=");
  assert.throws(() => parseTransferBase64("%%%"));
  assert.throws(() => parseUserPolicy({ agents: [], rawTerminal: true }));
  assert.throws(() => parseEnvEntries([{ key: "HOME", value: "ok\nno" }]));
  const rewritten = applyEnvEntries("# keep\nOLD=1\nANTHROPIC_API_KEY=before\n", [{ key: "ANTHROPIC_API_KEY", value: "secret" }]);
  assert.match(rewritten, /# keep/);
  assert.equal(rewritten.includes("OLD="), false);
  assert.match(rewritten, /ANTHROPIC_API_KEY=secret/);
});

test("login path marker ignores shell noise and keeps absolute directories", () => {
  const dirs = parseLoginPath("welcome\n__ENGINEROOM_PATH__/home/zoe/tools:/usr/bin:/home/zoe/tools\n");
  assert.deepEqual(dirs, ["/home/zoe/tools", "/usr/bin"]);
  assert.deepEqual(parseLoginPath("no marker"), []);
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
    assert.equal(childEnv({ PATH: "/usr/bin", PI_CODING_AGENT_DIR: "/tmp/ignore" }, home).PI_CODING_AGENT_DIR, "/tmp/ignore");
    assert.equal(childEnv({ PATH: "/usr/bin", PI_CODING_AGENT_DIR: "/usr/local/share/pi/agent" }, home).PI_CODING_AGENT_DIR, undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a managed Pi launcher without current-version runs the installed release", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "er-pi-launch-"));
  const binDir = path.join(home, ".local", "bin");
  const install = path.join(home, ".local", "install");
  const older = path.join(install, "releases", "1.2.0", "node_modules", ".bin", "pi");
  const releaseBin = path.join(install, "releases", "1.4.0", "node_modules", ".bin", "pi");
  const plainDir = path.join(home, "plain");
  const plain = path.join(plainDir, "pi");
  const launcher = `#!/bin/sh
pi_current_file="$HOME/.local/install/current-version"
if ! IFS= read -r pi_current_version < "$pi_current_file"; then
  printf 'Could not read managed Pi version from %s.\\n' "$pi_current_file" >&2
  exit 1
fi
`;
  try {
    await mkdir(path.dirname(older), { recursive: true });
    await mkdir(path.dirname(releaseBin), { recursive: true });
    await writeFile(older, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(releaseBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await mkdir(binDir, { recursive: true });
    await writeFile(path.join(binDir, "pi"), launcher, { mode: 0o755 });
    const resolved = await resolveBinary(undefined, ["pi"], { HOME: home, PATH: binDir });
    assert.equal(resolved, releaseBin);
    await writeFile(path.join(install, "current-version"), "1.2.0\n");
    const pinned = await resolveBinary(undefined, ["pi"], { HOME: home, PATH: binDir });
    assert.equal(pinned, older);

    await rm(install, { recursive: true, force: true });
    await mkdir(plainDir, { recursive: true });
    await writeFile(plain, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const fallback = await resolveBinary(undefined, ["pi"], { HOME: home, PATH: `${binDir}:${plainDir}` });
    assert.equal(fallback, plain);
    await assert.rejects(
      () => resolveBinary(undefined, ["pi"], { HOME: home, PATH: binDir }),
      /Could not read managed Pi version from/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("policy options stay optional and narrow the offered catalog", () => {
  const inherited = parseUserPolicy({ agents: ["cursor"], rawTerminal: true });
  assert.equal(inherited.options, undefined);
  assert.equal(inherited.fileManager, true);
  const ownLogin = parseUserPolicy({ agents: ["cursor"], rawTerminal: true, piAuth: "shared" });
  assert.equal("piAuth" in ownLogin, false);
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
  const unoffered = effectiveAgentOptions(
    {
      modes: [{ id: "agent", name: "Agent" }, { id: "plan", name: "Plan" }],
      models: [{ id: "gpt-5", name: "GPT" }],
    },
    { modes: [], models: [] },
    undefined,
  );
  assert.deepEqual(unoffered.modes, []);
  assert.deepEqual(unoffered.models, []);
  const probed = parseRunnerRequest({ id: "1", type: "probe_agent", agent: "cursor" });
  assert.equal(probed.type, "probe_agent");
  assert.throws(() => parseRunnerRequest({ id: "2", type: "probe_agent", agent: "Nope" }));
  assert.equal(parseRunnerRequest({ id: "3", type: "probe_agent", agent: "codex" }).type, "probe_agent");
  const resolved = parseRunnerRequest({ id: "4", type: "resolve_commands", names: ["agent", "agent", "/usr/local/bin/codex"] });
  if (resolved.type === "resolve_commands") assert.deepEqual(resolved.names, ["agent", "/usr/local/bin/codex"]);
  assert.throws(() => parseRunnerRequest({ id: "5", type: "resolve_commands", names: [] }));
  assert.throws(() => parseRunnerRequest({ id: "6", type: "put_pi_site", install: "global", auth: "shared" }));
  const setup = parseRunnerRequest({ id: "7", type: "setup_pi", provider: "openrouter", model: "recursive/flint-v1.0:free" });
  if (setup.type === "setup_pi") assert.equal(setup.model, "recursive/flint-v1.0:free");
  assert.throws(() => parseRunnerRequest({ id: "8", type: "setup_pi", provider: "bad provider", model: "ok" }));
  const applied = parseRunnerRequest({
    id: "9",
    type: "apply_harness_defaults",
    agent: "cursor",
    writeModel: true,
    commands: ["ls", "npm install", "ls"],
  });
  if (applied.type === "apply_harness_defaults" && applied.agent === "cursor") {
    assert.equal(applied.writeModel, true);
    assert.deepEqual(applied.commands, ["ls", "npm install"]);
  }
  assert.throws(() => parseRunnerRequest({ id: "10", type: "apply_harness_defaults", agent: "cursor", writeModel: true, commands: ["rm -rf /"] }));
  assert.throws(() => parseRunnerRequest({ id: "11", type: "put_cursor_commands", commands: ["bad!"] }));
});

test("harness defaults keep personal cursor config and force fast off", () => {
  const pi = mergePiDefaults({ lastChangelogVersion: "1.4.0", defaultProvider: "old" }, "openrouter", "recursive/flint-v1.0:free");
  assert.equal(pi.lastChangelogVersion, "1.4.0");
  assert.equal(pi.defaultProvider, "openrouter");
  assert.equal(pi.defaultModel, "recursive/flint-v1.0:free");
  assert.equal(piDefaultAllowed([{ id: "openrouter/recursive/flint-v1.0:free" }], "openrouter", "recursive/flint-v1.0:free"), true);
  assert.equal(piDefaultAllowed([{ id: "anthropic/claude-sonnet-4" }], "openrouter", "recursive/flint-v1.0:free"), false);

  const cursor = mergeCursorConfig({
    authInfo: { email: "ada@example.com" },
    permissions: { allow: ["Shell(old)", "Write(/tmp/x)"], deny: ["Shell(rm)"] },
    modelParameters: {
      "grok-4.7": [{ id: "fast", value: "true" }],
      "gemini-4-argon": [{ id: "reasoning_effort", value: "medium" }],
    },
    sandbox: { mode: "disabled" },
  }, { writeModel: true, commands: ["ls", "npm install"] });
  const model = cursor.model as { modelId: string; displayName: string; maxMode: boolean };
  const selected = cursor.selectedModel as { parameters: { id: string; value: string }[] };
  const parameters = cursor.modelParameters as Record<string, { id: string; value: string }[]>;
  const permissions = cursor.permissions as { allow: string[]; deny: string[] };
  assert.equal(model.modelId, "grok-4.7");
  assert.equal(model.displayName, "Grok 4.7 256K High");
  assert.equal(model.maxMode, false);
  assert.equal(selected.parameters.find((item) => item.id === "fast")?.value, "false");
  assert.equal(selected.parameters.find((item) => item.id === "reasoning_effort")?.value, "high");
  assert.equal(parameters["grok-4.7"]?.find((item) => item.id === "fast")?.value, "false");
  assert.deepEqual(parameters["gemini-4-argon"], [{ id: "reasoning_effort", value: "medium" }]);
  assert.deepEqual(permissions.allow, ["Shell(ls)", "Shell(npm install)", "Write(/tmp/x)"]);
  assert.deepEqual(permissions.deny, ["Shell(rm)"]);
  assert.deepEqual(cursor.authInfo, { email: "ada@example.com" });
  assert.deepEqual(cursor.sandbox, { mode: "disabled" });
  assert.equal(cursor.hasChangedDefaultModel, true);

  const commandsOnly = mergeCursorConfig(cursor, { commands: ["cat"] });
  const keptModel = commandsOnly.model as { modelId: string };
  const keptAllow = (commandsOnly.permissions as { allow: string[] }).allow;
  assert.equal(keptModel.modelId, "grok-4.7");
  assert.deepEqual(keptAllow, ["Shell(cat)", "Write(/tmp/x)"]);
  assert.deepEqual(readShellCommands(commandsOnly), ["cat"]);
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
  assert.deepEqual(THEMES, ["dark", "light", "haxor", "midnight", "engine", "pi"]);
  for (const theme of THEMES) {
    assert.equal(isTheme(theme), true);
    assert.equal(parseSettingsPatch({ theme }).theme, theme);
    assert.equal(applySettings(next, { theme }).theme, theme);
  }
  const themed = applySettings(next, { theme: "engine" });
  assert.equal(themed.theme, "engine");
  assert.equal(applySettings(themed, { defaultModel: "opus" }).theme, "engine");
  assert.equal(isTheme("sepia"), false);
  assert.equal(isTheme(""), false);
  assert.equal(isThemeId("sepia"), true);
  assert.equal(parseSettingsPatch({ theme: "sepia" }).theme, "sepia");
  assert.equal(resolveTheme("sepia", []), "dark");
  assert.equal(resolveTheme("sepia", ["sepia"]), "sepia");
  assert.equal(resolveTheme("engine", []), "engine");
  assert.throws(() => parseSettingsPatch({ theme: "Sepia" }), /invalid theme/);
  assert.throws(() => parseSettingsPatch({ theme: "../custom" }), /invalid theme/);
  assert.equal(next.visibleChats, 5);
  assert.equal(parseSettingsPatch({ visibleChats: 0 }).visibleChats, 0);
  assert.equal(parseSettingsPatch({ visibleChats: 100 }).visibleChats, 100);
  assert.equal(applySettings(next, { visibleChats: 12 }).visibleChats, 12);
  assert.equal(applySettings(applySettings(next, { visibleChats: 12 }), { theme: "light" }).visibleChats, 12);
  assert.throws(() => parseSettingsPatch({ visibleChats: -1 }), /invalid visibleChats/);
  assert.throws(() => parseSettingsPatch({ visibleChats: 101 }), /invalid visibleChats/);
  assert.throws(() => parseSettingsPatch({ visibleChats: 1.5 }), /invalid visibleChats/);
  assert.throws(() => parseSettingsPatch({ visibleChats: "5" }), /invalid visibleChats/);
  assert.equal(next.commandBlockStyle, "prompt");
  assert.equal(isCommandBlockStyle("prompt"), true);
  assert.equal(isCommandBlockStyle("window"), true);
  assert.equal(isCommandBlockStyle("card"), false);
  assert.equal(parseSettingsPatch({ commandBlockStyle: "window" }).commandBlockStyle, "window");
  assert.equal(parseSettingsPatch({ commandBlockStyle: "prompt" }).commandBlockStyle, "prompt");
  assert.equal(applySettings(next, { commandBlockStyle: "window" }).commandBlockStyle, "window");
  assert.equal(applySettings(applySettings(next, { commandBlockStyle: "window" }), { theme: "light" }).commandBlockStyle, "window");
  assert.throws(() => parseSettingsPatch({ commandBlockStyle: "card" }), /invalid commandBlockStyle/);
  assert.throws(() => parseSettingsPatch({ commandBlockStyle: "" }), /invalid commandBlockStyle/);
  assert.equal(next.wrapText, false);
  assert.equal(parseSettingsPatch({ wrapText: true }).wrapText, true);
  assert.equal(applySettings(next, { wrapText: true }).wrapText, true);
  assert.equal(applySettings(applySettings(next, { wrapText: true }), { theme: "light" }).wrapText, true);
  assert.throws(() => parseSettingsPatch({ wrapText: "yes" }), /invalid wrapText/);
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
  assert.equal(cursorArgs("/home/alice", "chat-1", "gpt", "hello", "ask").includes("--force"), false);
  assert.equal(cursorArgs("/home/alice", "chat-1", "gpt", "hello", "edits").includes("--force"), true);
  assert.ok(claudeArgs("", "sid", "hello").includes("bypassPermissions"));
  assert.ok(claudeArgs("", "sid", "hello", "edits").includes("acceptEdits"));
  assert.ok(claudeArgs("", "sid", "hello", "ask").includes("default"));
  assert.ok(claudeArgs("", "sid", "hello").includes("--resume"));
  assert.deepEqual(piArgs("erabc123", "", "hello").slice(0, 4), ["--mode", "json", "--session-id", "erabc123"]);
});

test("pi model list keeps provider and model columns, including ids with slashes", () => {
  const rows = [
    { provider: "anthropic", model: "claude-sonnet-4", context: "200K", maxOut: "16K", thinking: "yes", images: "yes" },
    { provider: "openrouter", model: "recursive/flint-v1.0:free", context: "128K", maxOut: "8K", thinking: "no", images: "no" },
  ];
  const headers = { provider: "provider", model: "model", context: "context", maxOut: "max-out", thinking: "thinking", images: "images" };
  const width = (key: keyof typeof headers) => Math.max(headers[key].length, ...rows.map((row) => row[key].length));
  const line = (row: typeof headers) =>
    [row.provider.padEnd(width("provider")), row.model.padEnd(width("model")), row.context.padEnd(width("context")), row.maxOut.padEnd(width("maxOut")), row.thinking.padEnd(width("thinking")), row.images.padEnd(width("images"))].join(" ");
  const table = ["Warning: ignored before the table", line(headers), ...rows.map(line)].join("\n");
  assert.deepEqual(parsePiModelList(table), [
    { id: "anthropic/claude-sonnet-4", name: "anthropic/claude-sonnet-4" },
    { id: "openrouter/recursive/flint-v1.0:free", name: "recursive/flint-v1.0:free" },
  ]);
  assert.deepEqual(parsePiModelList("No models available. Run /login or set an API key.\n"), []);
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

test("pi keeps streaming after the first turn", () => {
  const parser = createCliParser("pi", "erabc");
  assert.deepEqual(
    parser.push({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Looking" },
    }),
    [{ type: "text_delta", text: "Looking" }],
  );
  assert.deepEqual(parser.push({ type: "turn_end", message: {}, toolResults: [] }), []);
  assert.deepEqual(parser.push({ type: "agent_end", messages: [], willRetry: true }), []);
  assert.deepEqual(
    parser.push({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Done" },
    }),
    [{ type: "text_delta", text: "Done" }],
  );
  assert.deepEqual(
    parser.push({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "hmm" },
    }),
    [{ type: "thinking", text: "hmm" }],
  );
  assert.deepEqual(
    parser.push({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 2, id: "call_1", toolName: "bash" },
    }),
    [{ type: "tool", id: "call_1", name: "bash", phase: "start" }],
  );
  assert.deepEqual(
    parser.push({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 2,
        toolCall: { id: "call_1", name: "bash", arguments: { command: "ls" } },
      },
    }),
    [{ type: "tool", id: "call_1", name: "bash", phase: "start", input: "ls" }],
  );
  assert.deepEqual(parser.push({ type: "auto_retry_start", attempt: 1, errorMessage: "overloaded" }), [
    { type: "status", text: "Retrying · overloaded" },
  ]);
  assert.deepEqual(parser.push({ type: "compaction_start", reason: "threshold" }), [
    { type: "status", text: "Compacting · threshold" },
  ]);
  assert.deepEqual(parser.push({ type: "agent_settled", aborted: false }), [{ type: "done", agentSessionId: null }]);
});

test("pi shows a final assistant error such as an expired api key", () => {
  const parser = createCliParser("pi", "erabc");
  const failed = { role: "assistant", stopReason: "error", errorMessage: "401:" };
  assert.deepEqual(parser.push({ type: "message_end", message: failed }), []);
  assert.deepEqual(parser.push({ type: "turn_end", message: failed, toolResults: [] }), []);
  assert.deepEqual(parser.push({ type: "agent_end", messages: [], willRetry: false }), [{ type: "error", text: "401:" }]);
  assert.deepEqual(parser.push({ type: "auto_retry_end", success: false, finalError: "401:" }), []);
  assert.deepEqual(parser.push({ type: "agent_settled", aborted: false }), [{ type: "done", agentSessionId: null }]);
});

test("pi hides an assistant error that a retry recovers from", () => {
  const parser = createCliParser("pi", "erabc");
  assert.deepEqual(
    parser.push({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "401:" } }),
    [],
  );
  assert.deepEqual(parser.push({ type: "agent_end", messages: [], willRetry: true }), []);
  assert.deepEqual(parser.push({ type: "message_end", message: { role: "assistant", stopReason: "stop" } }), []);
  assert.deepEqual(parser.push({ type: "agent_end", messages: [], willRetry: false }), []);
  assert.deepEqual(parser.finish(), []);
});

test("pi flushes an assistant error when the process ends first", () => {
  const parser = createCliParser("pi", "erabc");
  parser.push({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "401:" } });
  assert.deepEqual(parser.finish(), [{ type: "error", text: "401:" }]);
  assert.deepEqual(parser.finish(), []);
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

  const searchReq = parseRunnerRequest({
    id: "10b",
    type: "search_repo_files",
    workspace: "/home/alice/Sites/proj",
    query: "TODO",
    caseSensitive: true,
    regex: false,
    wholeWord: true,
  });
  assert.equal(searchReq.type, "search_repo_files");
  if (searchReq.type === "search_repo_files") {
    assert.equal(searchReq.query, "TODO");
    assert.equal(searchReq.caseSensitive, true);
    assert.equal(searchReq.wholeWord, true);
  }
  assert.throws(() => parseRunnerRequest({ id: "10c", type: "search_repo_files", workspace: "/home/alice/Sites/proj", query: "" }));
  assert.throws(() => parseRunnerRequest({ id: "10d", type: "search_repo_files", workspace: "/home/alice/Sites/proj", query: "x", regex: "yes" }));

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

  const { assertAbsoluteFilePath } = await import("@engineroom/protocol");
  const homeRead = parseRunnerRequest({
    id: "12b",
    type: "read_home_file",
    path: "/home/alice/.cursor/plans/Prompt file attachments.plan.md",
  });
  assert.equal(homeRead.type, "read_home_file");
  if (homeRead.type === "read_home_file") {
    assert.equal(homeRead.path, "/home/alice/.cursor/plans/Prompt file attachments.plan.md");
  }
  assert.equal(assertAbsoluteFilePath(" /home/alice/notes.md "), "/home/alice/notes.md");
  assert.throws(() => assertAbsoluteFilePath("notes.md"));
  assert.throws(() => assertAbsoluteFilePath("/home/alice/../etc/passwd"));
  assert.throws(() => parseRunnerRequest({ id: "12c", type: "read_home_file", path: "src/app.ts" }));

  const writeReq = parseRunnerRequest({
    id: "13",
    type: "write_repo_file",
    workspace: "/home/alice/Sites/proj",
    path: "src/app.ts",
    content: "export const a = 1;\n",
  });
  assert.equal(writeReq.type, "write_repo_file");

  const createReq = parseRunnerRequest({
    id: "14",
    type: "create_repo_entry",
    workspace: "/home/alice/Sites/proj",
    path: "src/utils",
    kind: "dir",
  });
  assert.equal(createReq.type, "create_repo_entry");

  const renameReq = parseRunnerRequest({
    id: "15",
    type: "rename_repo_entry",
    workspace: "/home/alice/Sites/proj",
    path: "src/app.ts",
    newPath: "src/main.ts",
  });
  assert.equal(renameReq.type, "rename_repo_entry");

  const deleteReq = parseRunnerRequest({
    id: "16",
    type: "delete_repo_entry",
    workspace: "/home/alice/Sites/proj",
    path: "src/main.ts",
  });
  assert.equal(deleteReq.type, "delete_repo_entry");

  const policyWithEditor = parseUserPolicy({ agents: ["cursor"], rawTerminal: false, fileEditor: false });
  assert.equal(policyWithEditor.fileEditor, false);
  const policyDefaultEditor = parseUserPolicy({ agents: ["cursor"], rawTerminal: false });
  assert.equal(policyDefaultEditor.fileEditor, true);
  assert.equal(policyDefaultEditor.fileDownload, true);
  assert.equal(policyDefaultEditor.fileUpload, true);

  const downloadReq = parseRunnerRequest({
    id: "17",
    type: "download_repo_file",
    workspace: "/home/alice/Sites/proj",
    path: "src/app.ts",
  });
  assert.equal(downloadReq.type, "download_repo_file");
  const uploadReq = parseRunnerRequest({
    id: "18",
    type: "upload_repo_file",
    workspace: "/home/alice/Sites/proj",
    path: "src/blob.bin",
    contentBase64: Buffer.from([0, 1, 255]).toString("base64"),
    overwrite: true,
  });
  assert.equal(uploadReq.type, "upload_repo_file");
  if (uploadReq.type === "upload_repo_file") assert.equal(uploadReq.overwrite, true);
  assert.throws(() => parseRunnerRequest({
    id: "19",
    type: "upload_repo_file",
    workspace: "/home/alice/Sites/proj",
    path: "../secret",
    contentBase64: "YQ==",
  }));

  const readOnlySettings = applySettings(DEFAULT_SETTINGS, parseSettingsPatch({ filesReadOnly: true }));
  assert.equal(readOnlySettings.filesReadOnly, true);
});

test("branch names and queue indexes stay narrow", () => {
  assert.equal(assertBranchName("feature/widget"), "feature/widget");
  assert.throws(() => assertBranchName("foo..bar"));
  assert.throws(() => assertBranchName("-main"));
  assert.throws(() => assertBranchName("refs/heads/main.lock"));
  const queued = parseRunnerRequest({
    id: "20",
    type: "dequeue",
    chatId: "11111111-1111-1111-1111-111111111111",
    index: 1,
  });
  assert.equal(queued.type, "dequeue");
  if (queued.type === "dequeue") assert.equal(queued.index, 1);
  assert.throws(() => parseRunnerRequest({
    id: "21",
    type: "dequeue",
    chatId: "11111111-1111-1111-1111-111111111111",
    index: -1,
  }));
  const status = parseRunnerRequest({ id: "22", type: "git_status", workspace: "/home/alice/Sites/proj" });
  assert.equal(status.type, "git_status");
  assert.throws(() => parseRunnerRequest({ id: "23", type: "git_switch", workspace: "/home/alice", branch: "foo..bar" }));
  const switched = parseClientCommand({ type: "git_switch", workspace: "/home/alice/Sites/proj", branch: "main" });
  assert.equal(switched.type, "git_switch");
  const remote = parseRunnerRequest({
    id: "24",
    type: "git_remote_set",
    workspace: "  /home/alice/Sites/proj  ",
    url: " https://github.com/org/repo.git ",
  });
  assert.equal(remote.type, "git_remote_set");
  if (remote.type === "git_remote_set") {
    assert.equal(remote.workspace, "/home/alice/Sites/proj");
    assert.equal(remote.url, "https://github.com/org/repo.git");
  }
  const created = parseRunnerRequest({
    id: "25",
    type: "git_branch_create",
    workspace: "/home/alice/Sites/proj",
    branch: " feature/widget ",
  });
  assert.equal(created.type, "git_branch_create");
  if (created.type === "git_branch_create") assert.equal(created.branch, "feature/widget");
  const pull = parseRunnerRequest({ id: "26", type: "git_pull", workspace: "/home/alice/Sites/proj" });
  assert.equal(pull.type, "git_pull");
  const push = parseRunnerRequest({ id: "27", type: "git_push", workspace: "/home/alice/Sites/proj" });
  assert.equal(push.type, "git_push");
  assert.throws(() => parseRunnerRequest({
    id: "28",
    type: "git_remote_set",
    workspace: "/home/alice/Sites/proj",
    url: "file:///tmp/repo.git",
  }));
  assert.throws(() => parseRunnerRequest({
    id: "29",
    type: "git_branch_create",
    workspace: "/home/alice/Sites/proj",
    branch: "foo..bar",
  }));
  assert.throws(() => parseRunnerRequest({ id: "30", type: "git_pull", workspace: "   " }));
  assert.throws(() => parseRunnerRequest({ id: "31", type: "git_push", workspace: "   " }));
});

test("project archive requests keep a workspace and an archive id", () => {
  const started = parseRunnerRequest({
    id: "a1",
    type: "start_project_archive",
    workspace: "  /home/alice/Sites/proj  ",
  });
  assert.equal(started.type, "start_project_archive");
  if (started.type === "start_project_archive") assert.equal(started.workspace, "/home/alice/Sites/proj");
  const archiveId = "11111111-1111-4111-8111-111111111111";
  const status = parseRunnerRequest({ id: "a2", type: "project_archive_status", archiveId });
  assert.equal(status.type, "project_archive_status");
  if (status.type === "project_archive_status") assert.equal(status.archiveId, archiveId);
  const read = parseRunnerRequest({ id: "a3", type: "read_project_archive", archiveId });
  assert.equal(read.type, "read_project_archive");
  assert.throws(() => parseRunnerRequest({ id: "a4", type: "read_project_archive", archiveId: "../tmp/app.zip" }));
  assert.throws(() => parseRunnerRequest({ id: "a5", type: "start_project_archive", workspace: "   " }));
});

test("repository archive and delete requests keep a workspace and a folder name", () => {
  const archived = parseRunnerRequest({
    id: "r1",
    type: "set_repository_archived",
    workspace: "  /home/alice/Sites/proj  ",
    archived: true,
  });
  assert.equal(archived.type, "set_repository_archived");
  if (archived.type === "set_repository_archived") {
    assert.equal(archived.workspace, "/home/alice/Sites/proj");
    assert.equal(archived.archived, true);
  }
  const removed = parseRunnerRequest({
    id: "r2",
    type: "delete_repository",
    workspace: "/home/alice/Sites/proj",
    name: " proj ",
  });
  assert.equal(removed.type, "delete_repository");
  if (removed.type === "delete_repository") assert.equal(removed.name, "proj");
  assert.throws(() => parseRunnerRequest({ id: "r3", type: "delete_repository", workspace: "/home/alice/Sites/proj", name: "   " }));
  assert.throws(() => parseRunnerRequest({ id: "r4", type: "delete_repository", workspace: "   ", name: "proj" }));
  assert.throws(() => parseRunnerRequest({ id: "r5", type: "set_repository_archived", workspace: "   ", archived: false }));
});

test("git change requests keep paths inside the repo and reject an empty commit", () => {
  const staged = parseRunnerRequest({
    id: "g1",
    type: "git_stage",
    workspace: "/home/alice/Sites/proj",
    path: " src/app.ts ",
  });
  assert.equal(staged.type, "git_stage");
  if (staged.type === "git_stage") assert.equal(staged.path, "src/app.ts");
  const unstaged = parseRunnerRequest({
    id: "g2",
    type: "git_unstage",
    workspace: "/home/alice/Sites/proj",
    path: "src/app.ts",
  });
  assert.equal(unstaged.type, "git_unstage");
  const discarded = parseRunnerRequest({
    id: "g3",
    type: "git_discard",
    workspace: "/home/alice/Sites/proj",
    path: "src/app.ts",
  });
  assert.equal(discarded.type, "git_discard");
  assert.throws(() => parseRunnerRequest({
    id: "g4",
    type: "git_stage",
    workspace: "/home/alice/Sites/proj",
    path: "../secret",
  }));
  assert.throws(() => parseRunnerRequest({
    id: "g5",
    type: "git_commit",
    workspace: "/home/alice/Sites/proj",
    message: "   ",
  }));
  assert.throws(() => parseRunnerRequest({
    id: "g6",
    type: "git_commit",
    workspace: "/home/alice/Sites/proj",
    message: "has\0null",
  }));
  const committed = parseRunnerRequest({
    id: "g7",
    type: "git_commit",
    workspace: "  /home/alice/Sites/proj  ",
    message: "  ship it  ",
    stageVisible: true,
  });
  assert.equal(committed.type, "git_commit");
  if (committed.type === "git_commit") {
    assert.equal(committed.workspace, "/home/alice/Sites/proj");
    assert.equal(committed.message, "ship it");
    assert.equal(committed.stageVisible, true);
  }
  const plain = parseRunnerRequest({
    id: "g8",
    type: "git_commit",
    workspace: "/home/alice/Sites/proj",
    message: "ship it",
    stageVisible: false,
  });
  if (plain.type === "git_commit") assert.equal(plain.stageVisible, undefined);
  const identity = parseRunnerRequest({ id: "g9", type: "git_identity_get" });
  assert.equal(identity.type, "git_identity_get");
  const savedIdentity = parseRunnerRequest({
    id: "g10",
    type: "git_identity_set",
    name: "  Ada Lovelace  ",
    email: "ada@example.com",
  });
  assert.equal(savedIdentity.type, "git_identity_set");
  if (savedIdentity.type === "git_identity_set") {
    assert.equal(savedIdentity.name, "Ada Lovelace");
    assert.equal(savedIdentity.email, "ada@example.com");
  }
  assert.throws(() => parseRunnerRequest({ id: "g11", type: "git_identity_set", name: "-Ada", email: "ada@example.com" }));
  assert.throws(() => parseRunnerRequest({ id: "g12", type: "git_identity_set", name: "Ada", email: "not-an-email" }));
  assert.throws(() => parseRunnerRequest({ id: "g13", type: "git_identity_set", name: "Ada\nLovelace", email: "ada@example.com" }));
});

test("prompt attachments must live in the upload folder", () => {
  const chatId = "11111111-1111-1111-1111-111111111111";
  const saved = parseRunnerRequest({
    id: "p1",
    type: "save_prompt_attachment",
    workspace: "/home/alice/Sites/proj",
    name: "shot.png",
    mimeType: "image/jpg",
    contentBase64: "aGVsbG8=",
  });
  assert.equal(saved.type, "save_prompt_attachment");
  if (saved.type === "save_prompt_attachment") assert.equal(saved.mimeType, "image/jpeg");
  const prompt = parseRunnerRequest({
    id: "p2",
    type: "prompt",
    chatId,
    prompt: "",
    attachments: [{
      name: "shot.png",
      path: ".engineroom/uploads/abc-shot.png",
      mimeType: "image/png",
      size: 5,
    }],
  });
  assert.equal(prompt.type, "prompt");
  if (prompt.type === "prompt") {
    assert.equal(prompt.prompt, "");
    assert.equal(prompt.attachments?.[0]?.path, ".engineroom/uploads/abc-shot.png");
  }
  assert.throws(() => parseRunnerRequest({ id: "p3", type: "prompt", chatId, prompt: "   " }), /prompt is empty/);
  assert.throws(() => parseRunnerRequest({
    id: "p4",
    type: "prompt",
    chatId,
    prompt: "look",
    attachments: [{ name: "shot.png", path: "src/shot.png", mimeType: "image/png", size: 1 }],
  }), /invalid attachment/);
  assert.throws(() => parseRunnerRequest({
    id: "p5",
    type: "prompt",
    chatId,
    prompt: "look",
    attachments: [{ name: "shot.png", path: ".engineroom/uploads/nested/shot.png", mimeType: "image/png", size: 1 }],
  }), /invalid attachment/);
  assert.throws(() => parseRunnerRequest({
    id: "p6",
    type: "prompt",
    chatId,
    prompt: "look",
    attachments: Array.from({ length: 9 }, () => ({
      name: "a.txt",
      path: ".engineroom/uploads/a.txt",
      mimeType: "text/plain",
      size: 1,
    })),
  }), /too many attachments/);
});

