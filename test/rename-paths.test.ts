import assert from "node:assert/strict";
import test from "node:test";
import {
  baseName,
  isInsideRenamed,
  parentPath,
  remapPath,
  remapPathSet,
  renamePathError,
  renameTargetPath,
  stemEnd,
} from "../apps/web/src/files/renamePaths.ts";

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

test("the rename field edits a name, not a whole path", () => {
  assert.equal(baseName("src/components/Button.tsx"), "Button.tsx");
  assert.equal(baseName("README.md"), "README.md");
  assert.equal(parentPath("src/components/Button.tsx"), "src/components");
  assert.equal(parentPath("README.md"), "");

  // A bare name stays in the same folder.
  assert.equal(renameTargetPath("src/components/Button.tsx", "PrimaryButton.tsx"), "src/components/PrimaryButton.tsx");
  assert.equal(renameTargetPath("README.md", "GUIDE.md"), "GUIDE.md");
  // A path moves the entry, and stray slashes are ignored.
  assert.equal(renameTargetPath("src/components/Button.tsx", "src/ui/PrimaryButton.tsx"), "src/ui/PrimaryButton.tsx");
  assert.equal(renameTargetPath("src/a.ts", "  /src/b.ts/  "), "src/b.ts");
  assert.equal(renameTargetPath("src/a.ts", "   "), "");
});

test("the extension stays out of the initial selection", () => {
  assert.equal(stemEnd("Button.tsx"), 6);
  assert.equal(stemEnd("archive.tar.gz"), 11);
  assert.equal(stemEnd(".env"), 4);
  assert.equal(stemEnd("Makefile"), 8);
});

test("rename names are validated before the call", () => {
  assert.equal(renamePathError("Button.tsx"), null);
  assert.equal(renamePathError("src/ui/Button.tsx"), null);
  assert.equal(renamePathError(""), "Enter a name.");
  assert.equal(renamePathError("   "), "Enter a name.");
  assert.equal(renamePathError(".."), "That name is not allowed.");
  assert.equal(renamePathError("src/../escape.ts"), "That name is not allowed.");
  assert.equal(renamePathError("src//a.ts"), "That name is not allowed.");
});
