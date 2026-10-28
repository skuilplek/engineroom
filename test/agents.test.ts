import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chooseServerPath, effectivePiAuth, isAccountPath, loadAgentBinaries, loadPiConfig, piSetupAllowed, saveAgentFlags, usableAgentIds, withResolvedCommands, type ListedAgent } from "../apps/hub/src/agents.ts";

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

test("a resolved binary override keeps an agent that is not on PATH", () => {
  const agents = usableAgentIds(
    { cursor: true, claude: false, pi: true },
    [listed("cursor", false), listed("claude", false), listed("pi", false)],
    ["cursor", "pi"],
    { pi: "/opt/pi" },
    new Map([["/opt/pi", "/opt/pi"]]),
  );
  assert.deepEqual(agents, ["pi"]);
});

test("a saved server path keeps an agent available when the person has no copy", () => {
  const agents = usableAgentIds(
    { cursor: true, claude: true, pi: true },
    [listed("cursor", false), listed("claude", false), listed("pi", false)],
    ["pi"],
    {},
    new Map(),
    new Set(["pi"]),
  );
  assert.deepEqual(agents, ["pi"]);
});

test("which keeps a server path and ignores an account path", () => {
  assert.equal(chooseServerPath(["/home/admin/.local/bin/pi", "/usr/local/bin/pi"], "/home/admin"), "/usr/local/bin/pi");
  assert.equal(chooseServerPath(["/home/admin/.local/bin/pi"], "/home/admin"), null);
  assert.equal(isAccountPath("/root/.local/bin/pi"), true);
  assert.equal(isAccountPath("/usr/local/bin/pi", "/home/admin"), false);
});

test("pi install, login, and model survive a later agent save", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "er-pi-"));
  const file = path.join(dir, "agents.json");
  try {
    saveAgentFlags(file, {
      cursor: true,
      claude: false,
      pi: true,
      piAuth: "shared",
      piProvider: "openrouter",
      piModel: "recursive/flint-v1.0:free",
      binaries: { pi: "/usr/local/bin/pi" },
      allowOverride: { pi: true },
    });
    const saved = loadPiConfig(file);
    assert.deepEqual(saved, {
      install: "global",
      auth: "shared",
      provider: "openrouter",
      model: "recursive/flint-v1.0:free",
    });
    saveAgentFlags(file, { cursor: true, claude: false, pi: true });
    assert.equal(loadPiConfig(file).model, "recursive/flint-v1.0:free");
    assert.equal(loadAgentBinaries(file).pi?.path, "/usr/local/bin/pi");
    assert.equal(loadAgentBinaries(file).pi?.allowOverride, true);
    assert.throws(() => saveAgentFlags(file, { cursor: true, claude: false, pi: true, binaries: { pi: "/home/admin/.local/bin/pi" } }));
    assert.equal(effectivePiAuth(saved), "shared");
    assert.equal(effectivePiAuth(saved, "user"), "user");
    assert.equal(piSetupAllowed(saved, true, true, "user", false), true);
    assert.equal(piSetupAllowed(saved, true, true, "user", true), false);
    assert.equal(piSetupAllowed(saved, true, true, "shared", false), false);
    assert.equal(piSetupAllowed(saved, false, true, "user", false), false);
    assert.equal(piSetupAllowed(saved, true, false, "user", false), false);
    assert.equal(piSetupAllowed({ ...saved, install: "user" }, true, true, "shared", false), true);
    assert.equal(piSetupAllowed({ ...saved, install: "user" }, true, true, "shared", true), false);
    assert.throws(() => saveAgentFlags(file, { cursor: true, claude: false, pi: true, piModel: "bad model" }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
