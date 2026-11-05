import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMeta } from "@engineroom/protocol";
import { forgetChat, forgetLastChat, pickLastChat, readLastChat, readLastChatFor, writeLastChat, writeLastChatFor } from "../apps/web/src/chat/lastChat.ts";
import { isMissingChat } from "../apps/web/src/chat/missingChat.ts";

const alice = "11111111-1111-1111-1111-111111111111";
const bob = "22222222-2222-2222-2222-222222222222";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  private values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

function chat(id: string): ChatMeta {
  return {
    id,
    title: id,
    agent: "cursor",
    model: "",
    workspace: "/home/alice/proj",
    agentSessionId: null,
    createdAt: "2026-10-24T00:00:00.000Z",
    updatedAt: "2026-10-24T00:00:00.000Z",
  };
}

test("a last chat id round-trips and a bad id is ignored", () => {
  const store = new MemoryStorage();
  writeLastChat("alice", alice, store);
  assert.equal(readLastChat("alice", store), alice);
  writeLastChat("alice", "not-a-chat", store);
  assert.equal(readLastChat("alice", store), alice);
  writeLastChat("bob", bob, store);
  assert.equal(readLastChat("alice", store), alice);
  assert.equal(readLastChat("bob", store), bob);

  store.setItem("engineroom.lastChat.alice", "../secret");
  assert.equal(readLastChat("alice", store), null);
  assert.equal(store.getItem("engineroom.lastChat.alice"), null);
});

test("a missing chat is not chosen from the list", () => {
  const listed = chat(alice);
  assert.equal(pickLastChat([listed], alice)?.id, alice);
  assert.equal(pickLastChat([listed], bob), null);
  assert.equal(pickLastChat([listed], "not-a-chat"), null);
  assert.equal(pickLastChat([listed], null), null);

  const store = new MemoryStorage();
  writeLastChat("alice", bob, store);
  assert.equal(pickLastChat([listed], readLastChat("alice", store)), null);
  forgetLastChat("alice", store);
  assert.equal(readLastChat("alice", store), null);
});

test("only a missing chat sends the user home", () => {
  assert.equal(isMissingChat("chat not found"), true);
  assert.equal(isMissingChat("ENOENT: no such file or directory, open '/home/a/.engineroom/chats/x/meta.json'"), true);
  assert.equal(isMissingChat("send failed"), false);
  assert.equal(isMissingChat("invalid agent"), false);
  assert.equal(isMissingChat("sign in required"), false);
});

test("the last chat is kept per project as well as globally", () => {
  const store = new MemoryStorage();
  writeLastChatFor("alice", "/home/alice/Sites/one", alice, store);
  writeLastChatFor("alice", "/home/alice/Sites/two/", bob, store);

  assert.equal(readLastChat("alice", store), bob);
  assert.equal(readLastChatFor("alice", "/home/alice/Sites/one", store), alice);
  assert.equal(readLastChatFor("alice", "/home/alice/Sites/two", store), bob);
  assert.equal(readLastChatFor("alice", "/home/alice/Sites/missing", store), null);
  assert.equal(readLastChatFor("bob", "/home/alice/Sites/one", store), null);

  forgetChat("alice", alice, store);
  assert.equal(readLastChatFor("alice", "/home/alice/Sites/one", store), null);
  assert.equal(readLastChatFor("alice", "/home/alice/Sites/two", store), bob);
  assert.equal(readLastChat("alice", store), bob);

  forgetChat("alice", bob, store);
  assert.equal(readLastChat("alice", store), null);
  assert.equal(readLastChatFor("alice", "/home/alice/Sites/two", store), null);
});

test("per-project last chats ignore malformed storage", () => {
  const store = new MemoryStorage();
  store.setItem("engineroom.lastChats.alice", JSON.stringify({
    "/home/alice/Sites/one": alice,
    "/home/alice/Sites/bad": "../secret",
    "/home/alice/Sites/empty": "",
    nope: 3,
  }));
  assert.equal(readLastChatFor("alice", "/home/alice/Sites/one", store), alice);
  assert.equal(readLastChatFor("alice", "/home/alice/Sites/bad", store), null);
  assert.equal(readLastChatFor("alice", "/home/alice/Sites/empty", store), null);

  store.setItem("engineroom.lastChats.alice", "not json");
  assert.equal(readLastChatFor("alice", "/home/alice/Sites/one", store), null);
});

test("last chat storage failures are ignored", () => {
  const blocked: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
    removeItem() {
      throw new Error("blocked");
    },
  };
  assert.equal(readLastChat("alice", blocked), null);
  writeLastChat("alice", alice, blocked);
  forgetLastChat("alice", blocked);
});
