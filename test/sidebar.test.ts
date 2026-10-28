import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMeta, RepositoryEntry } from "@engineroom/protocol";
import { buildGroups, modeTone, visibleProjectChats } from "../apps/web/src/format.ts";

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
    { path: "/home/serveradmin/Sites/internet", name: "internet", enabled: true, archived: false },
    { path: "/home/serveradmin/Sites/test", name: "test", enabled: true, archived: false },
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
    [{ path: home, name: "serveradmin", enabled: true, archived: false }],
    home,
  );
  assert.deepEqual(groups.map((group) => group.label), ["serveradmin"]);
  assert.deepEqual(groups[0]?.chats.map((item) => item.title), ["loose"]);
});

test("buildGroups leaves archived projects out of the main list", () => {
  const home = "/home/serveradmin";
  const repos: RepositoryEntry[] = [
    { path: "/home/serveradmin/Sites/internet", name: "internet", enabled: true, archived: false },
    { path: "/home/serveradmin/Sites/old", name: "old", enabled: true, archived: true },
  ];
  const chats = [
    chat("/home/serveradmin/Sites/internet", "Proxy Server List"),
    chat("/home/serveradmin/Sites/old", "Old chat"),
  ];
  const groups = buildGroups(chats, repos, home);
  assert.deepEqual(groups.map((group) => group.label), ["internet"]);
  assert.deepEqual(groups[0]?.chats.map((item) => item.title), ["Proxy Server List"]);
  const archived = buildGroups(chats, repos, home, "", true);
  assert.deepEqual(archived.map((group) => group.label), ["old"]);
  assert.deepEqual(archived[0]?.chats.map((item) => item.title), ["Old chat"]);
});

function dated(title: string, createdAt: string, updatedAt: string): ChatMeta {
  return { ...chat("/home/serveradmin/Sites/internet", title), id: title, createdAt, updatedAt };
}

test("visibleProjectChats shows the last active chats in created order", () => {
  const chats = [
    dated("first", "2026-10-01T00:00:00.000Z", "2026-10-18T05:00:00.000Z"),
    dated("second", "2026-10-02T00:00:00.000Z", "2026-10-18T01:00:00.000Z"),
    dated("third", "2026-10-03T00:00:00.000Z", "2026-10-18T04:00:00.000Z"),
    dated("fourth", "2026-10-04T00:00:00.000Z", "2026-10-18T02:00:00.000Z"),
    dated("open", "2026-10-05T00:00:00.000Z", "2026-10-18T00:00:00.000Z"),
  ];
  const collapsed = visibleProjectChats(chats, 2, "open", { expanded: false, uncapped: false });
  assert.deepEqual(collapsed.shown.map((item) => item.id), ["open", "third", "first"]);
  assert.equal(collapsed.older, 2);
  const expanded = visibleProjectChats(chats, 2, "open", { expanded: true, uncapped: false });
  assert.deepEqual(expanded.shown.map((item) => item.id), ["open", "fourth", "third", "second", "first"]);
  assert.equal(expanded.older, 2);
  const all = visibleProjectChats(chats, 0, null, { expanded: false, uncapped: false });
  assert.deepEqual(all.shown.map((item) => item.id), ["open", "fourth", "third", "second", "first"]);
  assert.equal(all.older, 0);
  const searching = visibleProjectChats(chats, 2, null, { expanded: false, uncapped: true });
  assert.deepEqual(searching.shown.map((item) => item.id), ["open", "fourth", "third", "second", "first"]);
  assert.equal(searching.older, 0);
});

test("modeTone recognizes plan and ask", () => {
  assert.equal(modeTone("plan"), "plan");
  assert.equal(modeTone(" Ask "), "ask");
  assert.equal(modeTone("agent"), "");
  assert.equal(modeTone(undefined), "");
});
