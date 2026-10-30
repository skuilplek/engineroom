import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isAccountPath, loadCursorCommands, loadPiConfig, piSetupAllowed, saveAgentFlags, usableAgentIds, withResolvedCommands, type ListedAgent } from "../apps/hub/src/agents.ts";

function listed(id: ListedAgent["id"], available: boolean): ListedAgent {
  return {
    id,
    label: id,
    binary: id === "cursor" ? "agent" : id,
    builtin: true,
    available,
    path: available ? `/usr/bin/${id}` : null,
    enabled: true,
    allowOverride: false,
    pathSource: available ? "detected" : null,
  };
}

test("usable agents omit commands that are not installed for the person", () => {
  const agents = usableAgentIds(
    { cursor: true, claude: true, pi: true },
    [listed("cursor", true), listed("claude", false), listed("pi", false)],
    ["cursor", "claude", "pi"],
  );
  assert.deepEqual(agents, ["cursor"]);
});

test("usable agents is empty when nothing is installed", () => {
  const agents = usableAgentIds(
    { cursor: true, claude: true, pi: true },
    [listed("cursor", false), listed("claude", false), listed("pi", false)],
    ["cursor", "claude", "pi"],
  );
  assert.deepEqual(agents, []);
});

test("claude counts as installed when only its ACP adapter is on PATH", () => {
  const resolved = withResolvedCommands(
    [listed("cursor", false), listed("claude", false), listed("pi", false)],
    new Map([["claude-agent-acp", "/home/zoe/.local/bin/claude-agent-acp"]]),
  );
  assert.equal(resolved.find((agent) => agent.id === "claude")?.path, "/home/zoe/.local/bin/claude-agent-acp");
  const agents = usableAgentIds(
    { cursor: true, claude: true, pi: true },
    resolved,
    ["cursor", "claude", "pi"],
  );
  assert.deepEqual(agents, ["claude"]);
});

test("an installed agent stays hidden when it is not offered", () => {
  const agents = usableAgentIds(
    { cursor: true, claude: false, pi: true },
    [listed("cursor", true), listed("claude", true), listed("pi", true)],
    ["cursor", "claude", "pi"],
  );
  assert.deepEqual(agents, ["cursor", "pi"]);
});

test("an installed agent stays hidden when it is not allowed for the person", () => {
  const agents = usableAgentIds(
    { cursor: true, claude: true, pi: true },
    [listed("cursor", true), listed("claude", true), listed("pi", true)],
    ["cursor"],
  );
  assert.deepEqual(agents, ["cursor"]);
});

test("a system path does not count as this account's install", () => {
  const resolved = withResolvedCommands(
    [listed("cursor", true), listed("claude", false), listed("pi", true)],
    new Map([["claude", "/home/zoe/.local/bin/claude"]]),
  );
  assert.equal(resolved.find((agent) => agent.id === "cursor")?.available, false);
  assert.equal(resolved.find((agent) => agent.id === "pi")?.available, false);
  assert.equal(resolved.find((agent) => agent.id === "claude")?.path, "/home/zoe/.local/bin/claude");
  assert.equal(isAccountPath("/root/.local/bin/pi"), true);
  assert.equal(isAccountPath("/usr/local/bin/pi", "/home/admin"), false);
});

test("pi provider and model survive a later agent save", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "er-pi-"));
  const file = path.join(dir, "agents.json");
  try {
    saveAgentFlags(file, {
      cursor: true,
      claude: false,
      pi: true,
      piProvider: "openrouter",
      piModel: "recursive/flint-v1.0:free",
      binaries: { pi: "/usr/local/bin/pi" },
    });
    const saved = loadPiConfig(file);
    assert.deepEqual(saved, {
      provider: "openrouter",
      model: "recursive/flint-v1.0:free",
    });
    const stored = JSON.parse(await readFile(file, "utf8")) as { piAuth?: string; piInstall?: string; agentBinaries?: unknown };
    assert.equal(stored.piAuth, undefined);
    assert.equal(stored.piInstall, undefined);
    assert.equal(stored.agentBinaries, undefined);
    saveAgentFlags(file, { cursor: true, claude: false, pi: true, cursorCommands: ["ls", "npm install"] });
    assert.deepEqual(loadCursorCommands(file), ["ls", "npm install"]);
    saveAgentFlags(file, { cursor: true, claude: false, pi: true });
    assert.equal(loadPiConfig(file).model, "recursive/flint-v1.0:free");
    assert.deepEqual(loadCursorCommands(file), ["ls", "npm install"]);
    assert.throws(() => saveAgentFlags(file, { cursor: true, claude: false, pi: true, cursorCommands: ["rm -rf /"] }));
    assert.equal(piSetupAllowed(true, true, false), true);
    assert.equal(piSetupAllowed(true, true, true), false);
    assert.equal(piSetupAllowed(false, true, false), false);
    assert.equal(piSetupAllowed(true, false, false), false);
    assert.throws(() => saveAgentFlags(file, { cursor: true, claude: false, pi: true, piModel: "bad model" }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
