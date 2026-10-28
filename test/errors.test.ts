import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_ACTION_ERRORS, parseRunnerRequest } from "@engineroom/protocol";
import { appendActionError, clearActionErrors, deleteActionError, listActionErrors } from "../apps/runner/src/errors.ts";
import { errorSummary } from "../apps/web/src/format.ts";

test("action error requests keep a short label and the full message", () => {
  const listed = parseRunnerRequest({ id: "1", type: "list_errors" });
  assert.equal(listed.type, "list_errors");
  const saved = parseRunnerRequest({
    id: "2",
    type: "append_error",
    action: "  Create   project ",
    message: "Cloning into dest\nfatal: Could not read from remote repository.",
  });
  assert.deepEqual(saved, {
    id: "2",
    type: "append_error",
    action: "Create project",
    message: "Cloning into dest\nfatal: Could not read from remote repository.",
  });
  const removed = parseRunnerRequest({
    id: "3",
    type: "delete_error",
    errorId: "11111111-1111-1111-1111-111111111111",
  });
  assert.equal(removed.type, "delete_error");
  assert.equal(parseRunnerRequest({ id: "4", type: "clear_errors" }).type, "clear_errors");
  assert.throws(() => parseRunnerRequest({ id: "5", type: "append_error", action: "", message: "nope" }));
  assert.throws(() => parseRunnerRequest({ id: "6", type: "append_error", action: "Create project", message: "x".repeat(8001) }));
  assert.throws(() => parseRunnerRequest({ id: "7", type: "delete_error", errorId: "../secret" }));
});

test("error notices use the fatal line of a command failure", () => {
  const text = [
    "Cloning into '/home/serveradmin/Sites/tetris'...",
    "fatal: Could not read from remote repository.",
    "",
    "Please make sure you have the correct access rights",
    "and the repository exists.",
  ].join("\n");
  assert.equal(errorSummary(text), "fatal: Could not read from remote repository.");
  assert.equal(errorSummary("short"), "short");
  assert.equal(errorSummary(`${"a".repeat(180)}`).length, 160);
});

test("action errors are stored per home and capped", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "er-errors-"));
  try {
    assert.deepEqual(await listActionErrors(home), []);
    const first = await appendActionError(home, "Create project", "fatal: no access");
    const second = await appendActionError(home, "Archive", "line one\nline two");
    const listed = await listActionErrors(home);
    assert.deepEqual(listed.map((item) => item.action), ["Archive", "Create project"]);
    assert.equal(listed[0]?.id, second.id);
    assert.equal(listed[1]?.message, first.message);
    const file = path.join(home, ".engineroom", "errors.jsonl");
    const info = await stat(file);
    assert.equal(info.mode & 0o777, 0o600);
    const raw = await readFile(file, "utf8");
    assert.equal(raw.split("\n").filter(Boolean).length, 2);
    assert.equal(raw.includes("\nline two"), false);

    await deleteActionError(home, second.id);
    assert.deepEqual((await listActionErrors(home)).map((item) => item.id), [first.id]);
    await deleteActionError(home, "missing");
    assert.equal((await listActionErrors(home)).length, 1);

    for (let index = 0; index < MAX_ACTION_ERRORS; index += 1) {
      await appendActionError(home, "Files", `failure ${index}`);
    }
    const capped = await listActionErrors(home);
    assert.equal(capped.length, MAX_ACTION_ERRORS);
    assert.equal(capped[0]?.message, `failure ${MAX_ACTION_ERRORS - 1}`);
    assert.equal(capped.some((item) => item.id === first.id), false);

    await clearActionErrors(home);
    assert.deepEqual(await listActionErrors(home), []);
    await assert.rejects(stat(file));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
