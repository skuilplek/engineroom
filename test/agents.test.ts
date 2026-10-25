import assert from "node:assert/strict";
import test from "node:test";
import { usableAgentIds, withResolvedCommands, type ListedAgent } from "../apps/hub/src/agents.ts";

function listed(id: ListedAgent["id"], available: boolean): ListedAgent {
  return {
    id,
    label: id,
    binary: id === "cursor" ? "agent" : id,
    builtin: true,
    available,
    path: available ? `/usr/bin/${id}` : null,
    enabled: true,
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
