import assert from "node:assert/strict";
import test from "node:test";
import { OpeningQueue } from "../apps/web/src/chat/openings.ts";

const alice = "11111111-1111-1111-1111-111111111111";
const bob = "22222222-2222-2222-2222-222222222222";

test("opening a second chat does not discard the first chat's prompt", () => {
  const queue = new OpeningQueue();
  queue.set(alice, { prompt: "first", attachments: [] });
  // showChat() used to clear a single slot here.
  queue.set(bob, { prompt: "second", attachments: [] });

  assert.deepEqual(queue.claim(alice), { prompt: "first", attachments: [] });
  assert.equal(queue.claim(alice), null);
  assert.deepEqual(queue.claim(bob), { prompt: "second", attachments: [] });
});

test("forgetting a deleted project leaves other projects alone", () => {
  const queue = new OpeningQueue();
  queue.set(alice, { prompt: "first", attachments: [], workspace: "/home/alice/Sites/one" });
  queue.set(bob, { prompt: "second", attachments: [], workspace: "/home/alice/Sites/two" });
  queue.forgetWorkspace("/home/alice/Sites/one");
  assert.equal(queue.claim(alice), null);
  assert.deepEqual(queue.claim(bob), { prompt: "second", attachments: [], workspace: "/home/alice/Sites/two" });
});

test("forgetting a deleted chat leaves other openings alone", () => {
  const queue = new OpeningQueue();
  queue.set(alice, { prompt: "first", attachments: [] });
  queue.set(bob, { prompt: "second", attachments: [] });
  queue.forget(alice);
  assert.equal(queue.claim(alice), null);
  assert.deepEqual(queue.claim(bob), { prompt: "second", attachments: [] });
});
