import assert from "node:assert/strict";
import test from "node:test";
import { readCollapsedProjects, writeCollapsedProjects } from "../apps/web/src/sidebar/collapsedProjects.ts";

function memoryStore(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

test("collapsed projects round-trip per user", () => {
  const store = memoryStore();
  writeCollapsedProjects("alice", ["/home/alice/Sites/one", "/home/alice/Sites/two"], store);
  assert.deepEqual([...readCollapsedProjects("alice", store)], ["/home/alice/Sites/one", "/home/alice/Sites/two"]);
  assert.deepEqual([...readCollapsedProjects("bob", store)], []);
});

test("collapsed projects ignore malformed storage", () => {
  const store = memoryStore({
    "engineroom.collapsedProjects.alice": JSON.stringify(["ok", 3, null, ""]),
  });
  assert.deepEqual([...readCollapsedProjects("alice", store)], ["ok"]);
  store.setItem("engineroom.collapsedProjects.alice", "not json");
  assert.deepEqual([...readCollapsedProjects("alice", store)], []);
});
