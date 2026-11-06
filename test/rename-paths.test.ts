import assert from "node:assert/strict";
import test from "node:test";
import { isInsideRenamed, remapPath, remapPathSet } from "../apps/web/src/files/renamePaths.ts";

test("a renamed file follows in the pane", () => {
  assert.equal(remapPath("src/Button.tsx", "src/Button.tsx", "src/PrimaryButton.tsx"), "src/PrimaryButton.tsx");
  // Unrelated paths and look-alike prefixes stay put.
  assert.equal(remapPath("src/Button.tsx.bak", "src/Button.tsx", "src/PrimaryButton.tsx"), "src/Button.tsx.bak");
  assert.equal(remapPath("src/Other.tsx", "src/Button.tsx", "src/PrimaryButton.tsx"), "src/Other.tsx");
  assert.equal(remapPath("src", "src/Button.tsx", "src/PrimaryButton.tsx"), "src");
});

test("a renamed folder carries its children with it", () => {
  assert.equal(remapPath("src/components", "src/components", "src/ui"), "src/ui");
  assert.equal(remapPath("src/components/Button.tsx", "src/components", "src/ui"), "src/ui/Button.tsx");
  assert.equal(remapPath("src/components/a/b/c.css", "src/components", "src/ui"), "src/ui/a/b/c.css");
  // Sibling folders that only share a name prefix are untouched.
  assert.equal(remapPath("src/components-old/Button.tsx", "src/components", "src/ui"), "src/components-old/Button.tsx");
});

test("a folder can be renamed to a nested path and back", () => {
  assert.equal(remapPath("docs/a.md", "docs", "notes/docs"), "notes/docs/a.md");
  assert.equal(remapPath("notes/docs/a.md", "notes/docs", "docs"), "docs/a.md");
});

test("renaming an empty target is a no-op", () => {
  assert.equal(remapPath("src/a.ts", "", "src/b.ts"), "src/a.ts");
  assert.equal(remapPath("", "src/a.ts", "src/b.ts"), "");
});

test("expanded folders are remapped as a set", () => {
  const before = new Set(["src", "src/components", "src/components/forms", "docs"]);
  const after = remapPathSet(before, "src/components", "src/ui");
  assert.deepEqual([...after].sort(), ["docs", "src", "src/ui", "src/ui/forms"]);
  // The source set is not mutated.
  assert.deepEqual([...before].sort(), ["docs", "src", "src/components", "src/components/forms"]);
});

test("only paths at or below the renamed entry count as moved", () => {
  assert.equal(isInsideRenamed("src/components", "src/components"), true);
  assert.equal(isInsideRenamed("src/components/a.ts", "src/components"), true);
  assert.equal(isInsideRenamed("src/components-old", "src/components"), false);
  assert.equal(isInsideRenamed("src", "src/components"), false);
  assert.equal(isInsideRenamed("", "src/components"), false);
});
