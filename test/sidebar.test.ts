import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMeta, RepositoryEntry } from "@engineroom/protocol";
import { buildGroups } from "../apps/web/src/format.ts";

function chat(workspace: string, title: string): ChatMeta {
  return {
    id: title,
    title,
    agent: "cursor",
    model: "",
    workspace,
    agentSessionId: null,
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:00:00.000Z",
  };
}

test("buildGroups hides chats outside enabled repositories", () => {
  const home = "/home/serveradmin";
  const repos: RepositoryEntry[] = [
    { path: "/home/serveradmin/Sites/internet", name: "internet", enabled: true },
    { path: "/home/serveradmin/Sites/test", name: "test", enabled: true },
  ];
  const groups = buildGroups(
    [
      chat("/home/serveradmin/Sites/internet", "Proxy Server List"),
      chat("/home/serveradmin/Sites/other", "orphan inside folder"),
      chat("/home/serveradmin/engineroom", "what does the setup script"),
      chat(home, "loose"),
    ],
    repos,
    home,
  );
  assert.deepEqual(groups.map((group) => group.label), ["internet", "test"]);
  assert.deepEqual(groups[0]?.chats.map((item) => item.title), ["Proxy Server List"]);
  assert.equal(groups[1]?.chats.length, 0);
});

test("buildGroups keeps home chats when home is an enabled repository", () => {
  const home = "/home/serveradmin";
  const groups = buildGroups(
    [chat(home, "loose")],
    [{ path: home, name: "serveradmin", enabled: true }],
    home,
  );
  assert.deepEqual(groups.map((group) => group.label), ["serveradmin"]);
  assert.deepEqual(groups[0]?.chats.map((item) => item.title), ["loose"]);
});
