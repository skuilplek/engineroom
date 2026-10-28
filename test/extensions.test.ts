import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AGENTS, EXTENSION_THEME_IDS, parseExtensionManifest, parseExtensionSource, resolveTheme, THEMES } from "@engineroom/protocol";
import {
  installExtension,
  listExtensions,
  readExtensionDoc,
  readScopedTheme,
  removeExtension,
  setExtensionEnabled,
  updateExtension,
} from "@engineroom/protocol/extensions";
import { startRunner } from "../apps/runner/src/server.ts";
import "./peercred-helper.ts";

const harbor = {
  name: "harbor-notes",
  version: "1.0.0",
  description: "Harbor theme, on-call notes, and the harbor agent",
  themes: [{
    id: "harbor",
    name: "Harbor",
    tagline: "Cool slate",
    tier: "simple",
    file: "harbor.css",
    swatches: {
      bg: "#0e1418",
      sidebar: "#121a20",
      panel: "#182228",
      accent: "#7eb8c9",
      ink: "#e7eef2",
      border: "#2a3a44",
    },
  }],
  docs: [{ id: "oncall", title: "On call", file: "docs/oncall.md" }],
  agents: [{ id: "harbor", label: "Harbor", binary: "harbor" }],
};

test("builtin theme and agent ids stay reserved for packages", () => {
  assert.deepEqual([...EXTENSION_THEME_IDS], [...THEMES]);
  assert.deepEqual([...AGENTS], ["cursor", "claude", "pi"]);
});

test("manifests reject traversal, builtin ids, and bad sources", () => {
  assert.throws(() => parseExtensionManifest({ ...harbor, themes: [{ ...harbor.themes[0], file: "../harbor.css" }] }), /invalid extension file/);
  assert.throws(() => parseExtensionManifest({ ...harbor, themes: [{ ...harbor.themes[0], id: "dark" }] }), /invalid extension theme/);
  assert.throws(() => parseExtensionManifest({ ...harbor, agents: [{ id: "pi", label: "Pi", binary: "pi" }] }), /invalid extension agent/);
  assert.throws(() => parseExtensionManifest({ ...harbor, docs: [{ id: "oncall", title: "On call", file: "docs/notes.txt" }] }), /invalid extension file/);
  assert.equal(parseExtensionSource("git:github.com/user/harbor-notes").kind, "git");
  assert.equal(parseExtensionSource("/opt/harbor").kind, "path");
  assert.throws(() => parseExtensionSource("harbor-notes"), /invalid extension source/);
  assert.throws(() => parseExtensionSource("https://example.com/repo.git;rm"), /invalid extension source/);
});

test("a local package installs, serves a theme and doc, and stays on that root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "er-ext-"));
  const other = await mkdtemp(path.join(tmpdir(), "er-ext-other-"));
  const source = path.join(root, "src");
  try {
    await writePackage(source);
    const installed = await installExtension(root, "site", source);
    assert.equal(installed.enabled, false);
    assert.equal(installed.themes[0]?.id, "harbor");
    await assert.rejects(() => installExtension(root, "site", source), /already exists/);
    const enabled = await setExtensionEnabled(root, "site", "harbor-notes", true);
    assert.equal(enabled.enabled, true);
    assert.match(await readScopedTheme(root, "site", "harbor") ?? "", /--bg:\s*#0e1418/);
    const doc = await readExtensionDoc(root, "site", "harbor-notes", "oncall");
    assert.match(doc.markdown, /Page the harbor/);
    assert.equal((await listExtensions(other, "user")).length, 0);

    const again = path.join(root, "src");
    await writeFile(path.join(again, "docs", "oncall.md"), "# On call\n\nUpdated.\n");
    const updated = await updateExtension(root, "site", "harbor-notes");
    assert.equal(updated.enabled, true);
    assert.match((await readExtensionDoc(root, "site", "harbor-notes", "oncall")).markdown, /Updated/);

    await removeExtension(root, "harbor-notes");
    assert.deepEqual(await listExtensions(root, "site"), []);
    assert.equal(await readScopedTheme(root, "site", "harbor"), null);
    assert.equal(resolveTheme("harbor", []), "dark");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});

test("enabling a second package with the same theme id fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "er-ext-clash-"));
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  try {
    await writePackage(first);
    await writePackage(second, { ...harbor, name: "other-notes" });
    await installExtension(root, "user", first);
    await installExtension(root, "user", second);
    await setExtensionEnabled(root, "user", "harbor-notes", true);
    await assert.rejects(() => setExtensionEnabled(root, "user", "other-notes", true), /already in use/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a package symlink that leaves the directory is rejected", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "er-ext-link-"));
  const source = path.join(root, "src");
  try {
    await writePackage(source);
    await unlink(path.join(source, "harbor.css"));
    await symlink("/etc/passwd", path.join(source, "harbor.css"));
    await assert.rejects(() => installExtension(root, "site", source), /invalid extension file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a user package does not appear for another home", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "er-ext-runner-"));
  const alice = path.join(root, "alice");
  const bob = path.join(root, "bob");
  const source = path.join(root, "src");
  await mkdir(alice);
  await mkdir(bob);
  await writePackage(source);
  const aliceRunner = await startRunner({
    home: alice,
    socketPath: path.join(root, "alice.sock"),
    drivers: {},
    peerCheck: () => undefined,
  });
  const bobRunner = await startRunner({
    home: bob,
    socketPath: path.join(root, "bob.sock"),
    drivers: {},
    peerCheck: () => undefined,
  });
  try {
    const installed = await rpc(path.join(root, "alice.sock"), { id: "1", type: "install_extension", source });
    assert.equal((installed as { name: string }).name, "harbor-notes");
    const aliceList = await rpc(path.join(root, "alice.sock"), { id: "2", type: "list_extensions" }) as { packages: { name: string }[] };
    const bobList = await rpc(path.join(root, "bob.sock"), { id: "3", type: "list_extensions" }) as { packages: unknown[] };
    assert.equal(aliceList.packages[0]?.name, "harbor-notes");
    assert.deepEqual(bobList.packages, []);
    await rpc(path.join(root, "alice.sock"), { id: "4", type: "set_extension_enabled", name: "harbor-notes", enabled: true });
    await rpc(path.join(root, "alice.sock"), { id: "5", type: "put_settings", settings: { theme: "harbor" } });
    await rpc(path.join(root, "alice.sock"), { id: "6", type: "remove_extension", name: "harbor-notes" });
    const settings = await rpc(path.join(root, "alice.sock"), { id: "7", type: "get_settings" }) as { theme: string };
    assert.equal(resolveTheme(settings.theme, []), "dark");
  } finally {
    await aliceRunner.close();
    await bobRunner.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function writePackage(dir: string, manifest: typeof harbor = harbor) {
  await mkdir(path.join(dir, "docs"), { recursive: true });
  await writeFile(path.join(dir, "engineroom.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(dir, "harbor.css"), `[data-theme="harbor"] { --bg: #0e1418; }\n`);
  await writeFile(path.join(dir, "docs", "oncall.md"), "# On call\n\nPage the harbor.\n");
}

function rpc(socketPath: string, request: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buf = "";
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buf += chunk;
      const index = buf.indexOf("\n");
      if (index < 0) return;
      const message = JSON.parse(buf.slice(0, index)) as { type?: string; result?: unknown; error?: string };
      if (message.type === "ok") resolve(message.result);
      else fail(new Error(message.error || "runner error"));
    });
    socket.on("error", fail);
    socket.on("end", () => fail(new Error("runner closed")));
    socket.write(`${JSON.stringify(request)}\n`);
  });
}
