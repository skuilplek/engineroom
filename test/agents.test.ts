import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isAccountPath, loadCursorCommands, loadCursorFast, loadPiConfig, piSetupAllowed, saveAgentFlags, usableAgentIds, withResolvedCommands, type ListedAgent } from "../apps/hub/src/agents.ts";

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
    { cursor: true, pi: true },
    [listed("cursor", true), listed("pi", false)],
    ["cursor", "pi"],
  );
  assert.deepEqual(agents, ["cursor"]);
});

test("usable agents is empty when nothing is installed", () => {
  const agents = usableAgentIds(
    { cursor: true, pi: true },
    [listed("cursor", false), listed("pi", false)],
    ["cursor", "pi"],
  );
  assert.deepEqual(agents, []);
});

test("an installed agent stays hidden when it is not offered", () => {
  const agents = usableAgentIds(
    { cursor: true, pi: false },
    [listed("cursor", true), listed("pi", true)],
    ["cursor", "pi"],
  );
  assert.deepEqual(agents, ["cursor"]);
});

test("an installed agent stays hidden when it is not allowed for the person", () => {
  const agents = usableAgentIds(
    { cursor: true, pi: true },
    [listed("cursor", true), listed("pi", true)],
    ["cursor"],
  );
  assert.deepEqual(agents, ["cursor"]);
});

test("a system path does not count as this account's install", () => {
  const resolved = withResolvedCommands(
    [listed("cursor", true), listed("codex", false), listed("pi", true)],
    new Map([["codex", "/home/zoe/.local/bin/codex"]]),
  );
  assert.equal(resolved.find((agent) => agent.id === "cursor")?.available, false);
  assert.equal(resolved.find((agent) => agent.id === "pi")?.available, false);
  assert.equal(resolved.find((agent) => agent.id === "codex")?.path, "/home/zoe/.local/bin/codex");
  assert.equal(isAccountPath("/root/.local/bin/pi"), true);
  assert.equal(isAccountPath("/usr/local/bin/pi", "/home/admin"), false);
});

test("pi provider and model survive a later agent save", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "er-pi-"));
  const file = path.join(dir, "agents.json");
  try {
    await writeFile(file, JSON.stringify({ cursor: true, claude: true, pi: true }));
    saveAgentFlags(file, {
      cursor: true,
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
    const stored = JSON.parse(await readFile(file, "utf8")) as { piAuth?: string; piInstall?: string; agentBinaries?: unknown; claude?: boolean };
    assert.equal(stored.claude, undefined);
    assert.equal(stored.piAuth, undefined);
    assert.equal(stored.piInstall, undefined);
    assert.equal(stored.agentBinaries, undefined);
    saveAgentFlags(file, { cursor: true, pi: true, cursorCommands: ["ls", "npm install"] });
    assert.deepEqual(loadCursorCommands(file), ["ls", "npm install"]);
    assert.equal(loadCursorFast(file), false);
    saveAgentFlags(file, { cursor: true, pi: true, cursorFast: true });
    assert.equal(loadCursorFast(file), true);
    saveAgentFlags(file, { cursor: true, pi: true });
    assert.equal(loadPiConfig(file).model, "recursive/flint-v1.0:free");
    assert.deepEqual(loadCursorCommands(file), ["ls", "npm install"]);
    assert.equal(loadCursorFast(file), true);
    saveAgentFlags(file, { cursor: true, pi: true, cursorFast: "yes" });
    assert.equal(loadCursorFast(file), false);
    assert.equal(loadCursorFast(""), false);
    assert.throws(() => saveAgentFlags(file, { cursor: true, pi: true, cursorCommands: ["rm -rf /"] }));
    assert.equal(piSetupAllowed(true, true, false), true);
    assert.equal(piSetupAllowed(true, true, true), false);
    assert.equal(piSetupAllowed(false, true, false), false);
    assert.equal(piSetupAllowed(true, false, false), false);
    assert.throws(() => saveAgentFlags(file, { cursor: true, pi: true, piModel: "bad model" }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
