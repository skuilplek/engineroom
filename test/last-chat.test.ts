import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMeta } from "@engineroom/protocol";
import { forgetLastChat, pickLastChat, readLastChat, writeLastChat } from "../apps/web/src/chat/lastChat.ts";

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
