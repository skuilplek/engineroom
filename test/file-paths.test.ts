import assert from "node:assert/strict";
import test from "node:test";
import { classifyOpenedPath, clickableFileToken, splitFileRefs } from "../apps/web/src/chat/filePaths.ts";

const planUri = "file:///home/serveradmin/.cursor/plans/Prompt%20file%20attachments-c99d43bc.plan.md";
const planPath = "/home/serveradmin/.cursor/plans/Prompt file attachments-c99d43bc.plan.md";

test("file URIs in agent output become openable paths", () => {
  const text = `Plan saved to ${planUri}`;
  const parts = splitFileRefs(text);
  assert.deepEqual(parts, [
    { text: "Plan saved to " },
    { text: planUri, path: planPath },
  ]);
  assert.equal(clickableFileToken(planUri), planPath);
  assert.deepEqual(splitFileRefs(`Saved ${planUri}.`), [
    { text: "Saved " },
    { text: planUri, path: planPath },
    { text: "." },
  ]);
});

test("paths inside the workspace open in the repository tree", () => {
  const workspace = "/home/serveradmin/Sites/engineroom";
  assert.deepEqual(classifyOpenedPath(workspace, planPath), { kind: "home", path: planPath });
  assert.deepEqual(
    classifyOpenedPath(workspace, "file:///home/serveradmin/Sites/engineroom/apps/web/src/App.tsx"),
    { kind: "repo", path: "apps/web/src/App.tsx" },
  );
  assert.deepEqual(classifyOpenedPath(workspace, "apps/web/src/chat/Composer.tsx"), {
    kind: "repo",
    path: "apps/web/src/chat/Composer.tsx",
  });
  assert.equal(classifyOpenedPath(workspace, "../secret.txt"), null);
  assert.equal(clickableFileToken("https://example.com/a/b.ts"), null);
  assert.equal(splitFileRefs("See https://example.com/a/b.ts later").some((part) => part.path), false);
});
