import assert from "node:assert/strict";
import test from "node:test";
import { clearDraft, readDraft, writeDraft } from "../apps/web/src/chat/drafts.ts";

test("composer drafts survive a remount and clear after send", () => {
  const key = "chat:draft-test";
  clearDraft(key);
  assert.equal(readDraft(key).prompt, "");
  writeDraft(key, "keep this", [{ key: "a", name: "note.txt", mimeType: "text/plain", size: 4 }]);
  assert.equal(readDraft<{ name: string }>(key).prompt, "keep this");
  assert.equal(readDraft<{ name: string }>(key).attachments[0]?.name, "note.txt");
  writeDraft("start:/tmp/other", "other project", []);
  assert.equal(readDraft(key).prompt, "keep this");
  assert.equal(readDraft("start:/tmp/other").prompt, "other project");
  clearDraft(key);
  assert.equal(readDraft(key).prompt, "");
  assert.equal(readDraft(key).attachments.length, 0);
  clearDraft("start:/tmp/other");
});
