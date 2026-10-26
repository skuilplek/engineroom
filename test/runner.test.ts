import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, mkdir, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { AgentDriver } from "../apps/runner/src/drivers.ts";
import { startRunner } from "../apps/runner/src/server.ts";
import { createRepository, syncGrantedRepositories } from "../apps/runner/src/repos.ts";
import { createChat, getChat, listChats, listRepositories, setEnabledRepositories, updateChat } from "../apps/runner/src/store.ts";
import { listGitRepositories, listWorkspaces, resolveWorkspace } from "../apps/runner/src/workspace.ts";
import { assertBranchName, MAX_TRANSFER_BYTES } from "@engineroom/protocol";
import { gitInitWorkspace, gitStatus, gitSwitch } from "../apps/runner/src/git.ts";
import "./peercred-helper.ts";

const execFileAsync = promisify(execFile);

test("workspaces reject a symlink that leaves the home directory", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "er-home-"));
  const outside = await mkdtemp(path.join(tmpdir(), "er-out-"));
  await mkdir(path.join(home, "work"));
  await symlink(outside, path.join(home, "escape"));
  await symlink(path.join(home, "work"), path.join(home, "inside"));
  assert.equal(await resolveWorkspace(home), await import("node:fs/promises").then((fs) => fs.realpath(home)));
  assert.equal(await resolveWorkspace(home, "inside"), path.join(await import("node:fs/promises").then((fs) => fs.realpath(home)), "work"));
  await assert.rejects(() => resolveWorkspace(home, "escape"), /home directory/);
  await assert.rejects(() => resolveWorkspace(home, "/etc"), /home directory/);
  const listed = await listWorkspaces(home);
  assert.equal(listed.some((entry) => entry.path === outside), false);
  assert.equal(listed.some((entry) => entry.name === "work"), true);
  await rm(home, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("overlapping chat saves keep both fields", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "er-chat-save-"));
  try {
    const chat = await createChat(home, { title: "New chat", mode: "plan" });
    assert.equal(chat.mode, "plan");
    const created = (await listChats(home, new Set())).find((item) => item.id === chat.id);
    assert.equal(created?.mode, "plan");
    await Promise.all([
      updateChat(home, chat.id, { title: "Saved title" }),
      updateChat(home, chat.id, { model: "custom-model" }),
      updateChat(home, chat.id, { mode: "agent" }),
    ]);
    const saved = (await listChats(home, new Set())).find((item) => item.id === chat.id);
    assert.equal(saved?.title, "Saved title");
    assert.equal(saved?.model, "custom-model");
    assert.equal(saved?.mode, "agent");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a missing chat is reported as not found and left out of the list", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "er-missing-chat-"));
  try {
    const kept = await createChat(home, { title: "kept" });
    const gone = await createChat(home, { title: "gone" });
    await rm(path.join(home, ".engineroom", "chats", gone.id), { recursive: true, force: true });
    const listed = await listChats(home, new Set());
    assert.deepEqual(listed.map((chat) => chat.id), [kept.id]);
    await assert.rejects(() => getChat(home, gone.id, false), /chat not found/);
    await assert.rejects(
      () => getChat(home, "11111111-1111-4111-8111-111111111111", false),
      (error: Error) => error.message === "chat not found",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("an empty catalog grant keeps a local repository enabled", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "er-grants-"));
  const repo = path.join(home, "Sites", "local");
  await mkdir(path.join(repo, ".git"), { recursive: true });
  try {
    await setEnabledRepositories(home, [repo]);
    const kept = await syncGrantedRepositories(home, [], async () => {
      throw new Error("should not clone");
    });
    assert.equal(kept.repositories.find((entry) => entry.name === "local")?.enabled, true);
    const chat = await createChat(home, { workspace: repo, title: "local" });
    assert.equal(chat.workspace, await import("node:fs/promises").then((fs) => fs.realpath(repo)));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a user can initialize or clone a repository inside Sites", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "er-create-repo-"));
  const outside = await mkdtemp(path.join(tmpdir(), "er-create-out-"));
  const sites = path.join(home, "Sites");
  try {
    await symlink(outside, sites);
    await assert.rejects(() => createRepository(home, "proj"), /invalid repository/);
    assert.equal((await readdir(outside)).includes("proj"), false);
    await rm(sites);

    await assert.rejects(() => createRepository(home, "../proj"), /invalid repository name/);
    await assert.rejects(() => createRepository(home, ".hidden"), /invalid repository name/);

    await mkdir(path.join(sites, "taken"), { recursive: true });
    await assert.rejects(() => createRepository(home, "taken"), /already exists/);
    await symlink(outside, path.join(sites, "link"));
    await assert.rejects(() => createRepository(home, "link"), /already exists/);
    assert.equal((await lstat(path.join(sites, "link"))).isSymbolicLink(), true);

    const created = await createRepository(home, "fresh");
    assert.equal(created.name, "fresh");
    assert.equal(created.enabled, true);
    assert.match(await readFile(path.join(created.path, ".git", "HEAD"), "utf8"), /ref: refs\/heads\/main/);

    let clonedUrl = "";
    const cloned = await createRepository(
      home,
      "remote",
      "Sites",
      "https://example.com/remote.git",
      async (url, dest) => {
        clonedUrl = url;
        await mkdir(path.join(dest, ".git"), { recursive: true });
      },
    );
    assert.equal(clonedUrl, "https://example.com/remote.git");
    assert.equal(cloned.name, "remote");
    assert.equal(cloned.enabled, true);
    assert.equal((await listRepositories(home)).find((entry) => entry.name === "fresh")?.enabled, true);
    await assert.rejects(() => readFile(path.join(home, ".engineroom", "grants.json"), "utf8"));

    await assert.rejects(
      () => createRepository(home, "partial", "Sites", "https://example.com/partial.git", async (_url, dest) => {
        await mkdir(dest, { recursive: true });
        await writeFile(path.join(dest, "partial"), "x");
        throw new Error("clone failed");
      }),
      /clone failed/,
    );
    await assert.rejects(() => stat(path.join(sites, "partial")));
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("git repositories are discovered inside the home and stay disabled", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "er-repos-"));
  const outside = await mkdtemp(path.join(tmpdir(), "er-repos-out-"));
  const sites = path.join(home, "Sites");
  const repo = path.join(sites, "proj");
  const nested = path.join(repo, "pkg");
  const worktree = path.join(sites, "tree");
  const stray = path.join(home, "stray");
  const deep = path.join(sites, "a", "b", "c", "d", "e", "f", "gone");
  const kept = path.join(sites, "a", "b", "c", "d", "e", "kept");
  await mkdir(path.join(repo, ".git"), { recursive: true });
  await mkdir(path.join(nested, ".git"), { recursive: true });
  await mkdir(worktree, { recursive: true });
  await writeFile(path.join(worktree, ".git"), "gitdir: ../proj/.git\n");
  await mkdir(path.join(stray, ".git"), { recursive: true });
  await mkdir(path.join(outside, ".git"));
  await symlink(outside, path.join(sites, "escape"));
  await mkdir(path.join(home, "notes"));
  await mkdir(deep, { recursive: true });
  await mkdir(kept, { recursive: true });
  await mkdir(path.join(deep, ".git"));
  await mkdir(path.join(kept, ".git"));
  await mkdir(path.join(sites, "node_modules", "lib", ".git"), { recursive: true });
  try {
    const found = await listGitRepositories(home);
    const names = found.map((entry) => entry.name).sort();
    assert.deepEqual(names, ["a/b/c/d/e/kept", "proj", "tree"]);
    assert.equal(found.every((entry) => entry.path !== outside), true);
    const listed = await listRepositories(home);
    assert.equal(listed.every((entry) => entry.enabled === false), true);

    await assert.rejects(() => createChat(home, { workspace: path.join(home, "notes") }), /not enabled/);
    const opened = await createChat(home, { workspace: repo, title: "discovered" });
    assert.equal(opened.workspace, await import("node:fs/promises").then((fs) => fs.realpath(repo)));
    await assert.rejects(() => createChat(home, { workspace: "/etc" }), /home directory/);
    const atHome = await createChat(home, { title: "loose" });
    assert.equal(atHome.workspace, await import("node:fs/promises").then((fs) => fs.realpath(home)));

    await assert.rejects(() => setEnabledRepositories(home, [path.join(home, "notes")]), /invalid repository/);
    await assert.rejects(
      () => setEnabledRepositories(home, [path.join(sites, "node_modules", "lib")]),
      /invalid repository/,
    );
    await assert.rejects(() => setEnabledRepositories(home, [stray]), /invalid repository/);
    const enabled = await setEnabledRepositories(home, [repo]);
    assert.equal(enabled.find((entry) => entry.name === "proj")?.enabled, true);
    assert.equal(enabled.find((entry) => entry.name === "tree")?.enabled, false);
    const chat = await createChat(home, { workspace: repo, title: "in repo" });
    assert.equal(chat.workspace, await import("node:fs/promises").then((fs) => fs.realpath(repo)));
    const visible = await listRepositories(home);
    assert.equal(visible.filter((entry) => entry.enabled).map((entry) => entry.name).join(","), "proj");
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("listChats omits workspaces outside the repository folder", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "er-chats-"));
  const outside = path.join(home, "engineroom");
  const repo = path.join(home, "Sites", "kept");
  await mkdir(path.join(outside, ".git"), { recursive: true });
  await mkdir(path.join(repo, ".git"), { recursive: true });
  try {
    await setEnabledRepositories(home, [repo]);
    const kept = await createChat(home, { workspace: repo, title: "kept" });
    const loose = await createChat(home, { title: "home" });
    const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const dir = path.join(home, ".engineroom", "chats", id);
    await mkdir(dir, { recursive: true });
    const now = new Date().toISOString();
    await writeFile(
      path.join(dir, "meta.json"),
      `${JSON.stringify({
        id,
        title: "old",
        agent: "cursor",
        model: "",
        workspace: outside,
        agentSessionId: null,
        createdAt: now,
        updatedAt: now,
      })}\n`,
    );
    const listed = await listChats(home, new Set());
    assert.deepEqual(listed.map((item) => item.id).sort(), [kept.id, loose.id].sort());
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("chats in one home are invisible from another", async () => {
  const alice = await mkdtemp(path.join(tmpdir(), "er-alice-"));
  const bob = await mkdtemp(path.join(tmpdir(), "er-bob-"));
  const chat = await createChat(alice, { agent: "pi", title: "secret" });
  assert.equal(chat.agent, "pi");
  assert.ok(chat.agentSessionId?.startsWith("er"));
  const aliceChats = await listChats(alice, new Set());
  const bobChats = await listChats(bob, new Set());
  assert.equal(aliceChats.length, 1);
  assert.equal(bobChats.length, 0);
  await rm(alice, { recursive: true, force: true });
  await rm(bob, { recursive: true, force: true });
});

test("a runner turn stays in that home and can be cancelled", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "er-run-"));
  const sock = path.join(home, "runner.sock");
  let sawAbort = false;
  const drivers: Record<AgentDriver["id"], AgentDriver> = {
    cursor: {
      id: "cursor",
      async run(ctx) {
        ctx.onEvent({ type: "text_delta", text: `echo:${ctx.prompt}` });
        ctx.onEvent({ type: "tool", id: "t1", name: "shell", phase: "start", input: "ls" });
        ctx.onEvent({ type: "done", agentSessionId: "cursor-session" });
        return { agentSessionId: "cursor-session" };
      },
    },
    claude: {
      id: "claude",
      async run(ctx) {
        ctx.onEvent({ type: "status", text: "working" });
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) {
            sawAbort = true;
            resolve();
            return;
          }
          ctx.signal.addEventListener(
            "abort",
            () => {
              sawAbort = true;
              resolve();
            },
            { once: true },
          );
        });
        ctx.onEvent({ type: "status", text: "Stopped" });
        ctx.onEvent({ type: "done" });
        return { agentSessionId: ctx.agentSessionId };
      },
    },
    pi: {
      id: "pi",
      async run() {
        throw new Error("not used");
      },
    },
  };
  const runner = await startRunner({ home, socketPath: sock, drivers, peerCheck: () => undefined });
  try {
    const created = await rpc(sock, { id: "c1", type: "create_chat", agent: "cursor", workspace: home });
    const chatId = (created.result as { id: string }).id;
    const sent = await rpc(sock, { id: "s1", type: "send", chatId, prompt: "build the door" });
    assert.equal((sent.result as { accepted?: boolean }).accepted, true);
    let transcript: { transcript: Array<{ kind: string; text?: string }>; chat: { agentSessionId: string; title: string } } | undefined;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const detail = await rpc(sock, { id: `g${attempt}`, type: "get_chat", chatId });
      transcript = detail.result as typeof transcript;
      if (transcript?.chat.agentSessionId === "cursor-session" && transcript.transcript.some((entry) => entry.text === "echo:build the door")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(transcript?.chat.agentSessionId, "cursor-session");
    assert.equal(transcript?.chat.title, "build the door");
    assert.equal(transcript?.transcript.some((entry) => entry.kind === "user"), true);
    assert.equal(transcript?.transcript.some((entry) => entry.text === "echo:build the door"), true);

    const outside = rpc(sock, {
      id: "bad",
      type: "create_chat",
      workspace: "/etc",
    });
    await assert.rejects(outside, /home directory|runner/);

    const hanging = await rpc(sock, { id: "c2", type: "create_chat", agent: "claude" });
    const hangingId = (hanging.result as { id: string }).id;
    await rpc(sock, { id: "s2", type: "send", chatId: hangingId, prompt: "wait" });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const live = await rpc(sock, { id: `p${attempt}`, type: "get_chat", chatId: hangingId });
      if ((live.result as { chat: { running?: boolean } }).chat.running) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await rpc(sock, { id: "x", type: "cancel", chatId: hangingId });
    for (let attempt = 0; attempt < 50 && !sawAbort; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(sawAbort, true);
    let stopped = false;
    for (let attempt = 0; attempt < 50 && !stopped; attempt += 1) {
      const live = await rpc(sock, { id: `z${attempt}`, type: "get_chat", chatId: hangingId });
      const entries = (live.result as { transcript: Array<{ text?: string }> }).transcript;
      stopped = entries.some((entry) => entry.text === "Stopped");
      if (!stopped) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(stopped, true);
  } finally {
    await runner.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("the control wrapper refuses names outside the login group", async () => {
  const script = path.resolve("deploy/engineroom-ctl");
  await assert.rejects(execFileAsync(script, ["start", "../root"]));
  await assert.rejects(execFileAsync(script, ["start", "root"]));
  await assert.rejects(execFileAsync(script, ["start", "serveradmin"]));
});

test("repository file listing and reading enforce visibility, gitignore, and symlink safety", async () => {
  const { listRepositoryFiles, readRepositoryFile } = await import("../apps/runner/src/files.ts");
  const home = await mkdtemp(path.join(tmpdir(), "er-files-"));
  const outside = await mkdtemp(path.join(tmpdir(), "er-files-out-"));
  const repo = path.join(home, "Sites", "proj");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(path.join(repo, "dist"), { recursive: true });
  await writeFile(path.join(outside, "secret.txt"), "top-secret");

  try {
    await execFileAsync("git", ["init", "-b", "main"], { cwd: repo });
    await execFileAsync("git", ["config", "user.email", "alice@example.com"], { cwd: repo });
    await execFileAsync("git", ["config", "user.name", "Alice"], { cwd: repo });
    await writeFile(path.join(repo, ".gitignore"), "dist/\nignored.txt\n");
    await writeFile(path.join(repo, ".env"), "SECRET=1\n");
    await writeFile(path.join(repo, "ignored.txt"), "ignored\n");
    await writeFile(path.join(repo, "dist", "bundle.js"), "console.log(1);\n");
    await writeFile(path.join(repo, "src", "index.ts"), "export const x = 1;\n");
    await symlink(path.join(outside, "secret.txt"), path.join(repo, "src", "escape.txt"));

    await execFileAsync("git", ["add", "src/index.ts"], { cwd: repo });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repo });

    // Modify tracked file and add untracked file
    await writeFile(path.join(repo, "src", "index.ts"), "export const x = 2;\n");
    await writeFile(path.join(repo, "src", "new.ts"), "export const y = 3;\n");

    await setEnabledRepositories(home, [repo]);

    // Default visibility: .git, .gitignore'd, and dotfiles hidden
    const defaultResult = await listRepositoryFiles(home, repo, {
      showHidden: false,
      showGitignored: false,
      showGitDir: false,
    });
    assert.equal(defaultResult.branch, "main");
    assert.deepEqual(
      defaultResult.files.map((item) => item.path),
      ["src", "src/index.ts", "src/new.ts"],
    );
    assert.deepEqual(
      defaultResult.changes.map((item) => ({ path: item.path, status: item.status })),
      [
        { path: "src/index.ts", status: "M" },
        { path: "src/new.ts", status: "?" },
      ],
    );

    // Reading hidden or gitignored file when disabled is rejected
    await assert.rejects(
      () =>
        readRepositoryFile(home, repo, ".env", {
          showHidden: false,
          showGitignored: false,
          showGitDir: false,
        }),
      /hidden by policy/,
    );
    await assert.rejects(
      () =>
        readRepositoryFile(home, repo, "ignored.txt", {
          showHidden: false,
          showGitignored: false,
          showGitDir: false,
        }),
      /hidden by policy/,
    );
    await assert.rejects(
      () =>
        readRepositoryFile(home, repo, "src/escape.txt", {
          showHidden: true,
          showGitignored: true,
          showGitDir: true,
        }),
      /invalid file path/,
    );

    // Reading modified file returns both current content and HEAD oldContent
    const fileContent = await readRepositoryFile(home, repo, "src/index.ts", {
      showHidden: false,
      showGitignored: false,
      showGitDir: false,
    });
    assert.equal(fileContent.content, "export const x = 2;\n");
    assert.equal(fileContent.oldContent, "export const x = 1;\n");
    assert.equal(fileContent.binary, false);

    // Enabling hidden + gitignored + .git reveals them
    const fullResult = await listRepositoryFiles(home, repo, {
      showHidden: true,
      showGitignored: true,
      showGitDir: true,
    });
    const fullPaths = fullResult.files.map((item) => item.path);
    assert.equal(fullPaths.includes(".env"), true);
    assert.equal(fullPaths.includes(".gitignore"), true);
    assert.equal(fullPaths.includes("ignored.txt"), true);
    assert.equal(fullPaths.includes("dist/bundle.js"), true);
    assert.equal(fullPaths.includes(".git"), true);

    // Test file CRUD operations
    const {
      writeRepositoryFile,
      createRepositoryEntry,
      renameRepositoryEntry,
      deleteRepositoryEntry,
    } = await import("../apps/runner/src/files.ts");

    const updated = await writeRepositoryFile(home, repo, "src/index.ts", "export const x = 42;\n");
    assert.equal(updated.content, "export const x = 42;\n");
    assert.equal(updated.oldContent, "export const x = 1;\n");

    // Rejects modifying .git even if showGitDir is true
    await assert.rejects(
      () =>
        writeRepositoryFile(home, repo, ".git/HEAD", "ref: refs/heads/main\n", {
          showHidden: true,
          showGitignored: true,
          showGitDir: true,
        }),
      /cannot modify \.git/,
    );

    // Rejects writing hidden file when showHidden is false
    await assert.rejects(
      () =>
        writeRepositoryFile(home, repo, ".env", "SECRET=2\n", {
          showHidden: false,
          showGitignored: false,
          showGitDir: false,
        }),
      /hidden by policy/,
    );

    // Rejects symlink escape on write
    await assert.rejects(
      () =>
        writeRepositoryFile(home, repo, "src/escape.txt", "overwrite", {
          showHidden: true,
          showGitignored: true,
          showGitDir: true,
        }),
      /invalid file path/,
    );

    // Create folder and file, rename, and delete
    const createdDir = await createRepositoryEntry(home, repo, "src/components", "dir");
    assert.equal(createdDir.path, "src/components");
    const createdFile = await createRepositoryEntry(
      home,
      repo,
      "src/components/Button.tsx",
      "file",
      "export const Button = () => null;\n",
    );
    assert.equal(createdFile.path, "src/components/Button.tsx");

    await assert.rejects(
      () => createRepositoryEntry(home, repo, "src/components/Button.tsx", "file", "dup"),
      /already exists/,
    );

    const renamed = await renameRepositoryEntry(
      home,
      repo,
      "src/components/Button.tsx",
      "src/components/PrimaryButton.tsx",
    );
    assert.equal(renamed.newPath, "src/components/PrimaryButton.tsx");
    const renamedRead = await readRepositoryFile(home, repo, "src/components/PrimaryButton.tsx");
    assert.equal(renamedRead.content, "export const Button = () => null;\n");

    await deleteRepositoryEntry(home, repo, "src/components");
    await assert.rejects(
      () => readRepositoryFile(home, repo, "src/components/PrimaryButton.tsx"),
      /file not found/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("repository file transfer enforces size, visibility, and overwrite", async () => {
  const { downloadRepositoryFile, uploadRepositoryFile } = await import("../apps/runner/src/files.ts");
  const home = await mkdtemp(path.join(tmpdir(), "er-transfer-"));
  const outside = await mkdtemp(path.join(tmpdir(), "er-transfer-out-"));
  const repo = path.join(home, "Sites", "proj");
  const visibility = { showHidden: false, showGitignored: false, showGitDir: false };
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(outside, "secret.txt"), "top-secret");
  try {
    await execFileAsync("git", ["init", "-b", "main"], { cwd: repo });
    await writeFile(path.join(repo, ".env"), "TOKEN=1\n");
    await writeFile(path.join(repo, "src", "note.txt"), "hello\n");
    await symlink(path.join(outside, "secret.txt"), path.join(repo, "src", "escape.txt"));
    await setEnabledRepositories(home, [repo]);

    const payload = Buffer.from([0, 1, 2, 255, 10]);
    const created = await uploadRepositoryFile(home, repo, "src/blob.bin", payload.toString("base64"), false, visibility);
    assert.equal(created.path, "src/blob.bin");
    assert.equal(created.size, payload.length);
    const downloaded = await downloadRepositoryFile(home, repo, "src/blob.bin", visibility);
    assert.equal(downloaded.name, "blob.bin");
    assert.deepEqual(Buffer.from(downloaded.contentBase64, "base64"), payload);

    await assert.rejects(
      () => uploadRepositoryFile(home, repo, "src/blob.bin", Buffer.from("next").toString("base64"), false, visibility),
      /file already exists/,
    );
    const replaced = await uploadRepositoryFile(home, repo, "src/blob.bin", Buffer.from("next").toString("base64"), true, visibility);
    assert.equal(replaced.size, 4);
    assert.equal(await readFile(path.join(repo, "src", "blob.bin"), "utf8"), "next");

    await assert.rejects(() => downloadRepositoryFile(home, repo, ".env", visibility), /hidden by policy/);
    await assert.rejects(
      () => uploadRepositoryFile(home, repo, ".env", Buffer.from("nope").toString("base64"), true, visibility),
      /hidden by policy/,
    );
    await assert.rejects(
      () => uploadRepositoryFile(home, repo, ".git/HEAD", Buffer.from("nope").toString("base64"), true, {
        showHidden: true,
        showGitignored: true,
        showGitDir: true,
      }),
      /cannot modify \.git/,
    );
    await assert.rejects(
      () => uploadRepositoryFile(home, repo, "src/escape.txt", Buffer.from("nope").toString("base64"), true, {
        showHidden: true,
        showGitignored: true,
        showGitDir: true,
      }),
      /invalid file path/,
    );
    await assert.rejects(() => downloadRepositoryFile(home, repo, "src", visibility), /not a regular file/);
    await assert.rejects(() => uploadRepositoryFile(home, repo, "../secret", Buffer.from("nope").toString("base64")), /invalid file path/);

    const huge = path.join(repo, "src", "huge.bin");
    const handle = await open(huge, "w");
    await handle.truncate(MAX_TRANSFER_BYTES + 1);
    await handle.close();
    await assert.rejects(() => downloadRepositoryFile(home, repo, "src/huge.bin", visibility), /too large/);
    await assert.rejects(
      () => uploadRepositoryFile(home, repo, "src/too-big.bin", Buffer.alloc(MAX_TRANSFER_BYTES + 1).toString("base64"), false, visibility),
      /too large/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("git status, init, and branch switch stay inside an allowed workspace", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "er-git-"));
  const repo = path.join(home, "Sites", "proj");
  try {
    assert.equal((await gitStatus(home, home)).repo, false);
    const created = await gitInitWorkspace(home, home);
    assert.equal(created.repo, true);
    assert.equal(created.branch, "main");
    assert.equal(created.branches.includes("main"), true);
    await assert.rejects(() => gitInitWorkspace(home, home), /already exists/);
    assert.throws(() => assertBranchName("foo..bar"));
    assert.throws(() => assertBranchName("-main"));
    await mkdir(path.join(home, "notes"));
    await assert.rejects(() => gitStatus(home, path.join(home, "notes")), /not enabled/);

    await mkdir(path.join(repo, "src"), { recursive: true });
    await execFileAsync("git", ["init", "-b", "main"], { cwd: repo });
    await execFileAsync("git", ["config", "user.email", "alice@example.com"], { cwd: repo });
    await execFileAsync("git", ["config", "user.name", "Alice"], { cwd: repo });
    await writeFile(path.join(repo, "src", "index.ts"), "export const x = 1;\n");
    await execFileAsync("git", ["add", "src/index.ts"], { cwd: repo });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repo });
    await execFileAsync("git", ["branch", "feature"], { cwd: repo });
    await setEnabledRepositories(home, [repo]);
    const status = await gitStatus(home, repo);
    assert.equal(status.repo, true);
    assert.equal(status.branch, "main");
    assert.deepEqual(status.branches.sort(), ["feature", "main"]);
    const switched = await gitSwitch(home, repo, "feature");
    assert.equal(switched.branch, "feature");
    await assert.rejects(() => gitSwitch(home, repo, "nope"), /invalid branch/);
    await assert.rejects(() => gitSwitch(home, repo, "foo..bar"), /invalid branch/);
    await assert.rejects(() => gitInitWorkspace(home, repo), /already exists/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a queued prompt can be removed and a model change is announced", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "er-queue-"));
  const sock = path.join(home, "runner.sock");
  const drivers: Record<AgentDriver["id"], AgentDriver> = {
    cursor: {
      id: "cursor",
      async run(ctx) {
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) {
            resolve();
            return;
          }
          ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        ctx.onEvent({ type: "done" });
        return { agentSessionId: ctx.agentSessionId };
      },
    },
    claude: { id: "claude", async run() { throw new Error("not used"); } },
    pi: { id: "pi", async run() { throw new Error("not used"); } },
  };
  const runner = await startRunner({ home, socketPath: sock, drivers, peerCheck: () => undefined });
  const live = await subscribe(sock);
  try {
    live.send({ id: "c1", type: "create_chat", agent: "cursor", workspace: home });
    const created = await live.next((message) => message.id === "c1");
    const chatId = (created.result as { id: string }).id;
    live.send({ id: "w1", type: "watch", chatId, lastSeq: 0 });
    await live.next((message) => message.id === "w1");
    live.send({ id: "p1", type: "prompt", chatId, prompt: "first" });
    await live.next((message) => message.id === "p1");
    await live.next((message) => message.type === "chat_event" && message.event?.type === "turn_start");
    live.send({ id: "p2", type: "prompt", chatId, prompt: "second" });
    await live.next((message) => message.type === "chat_event" && message.event?.type === "queued" && message.event.text === "second");
    live.send({ id: "p3", type: "prompt", chatId, prompt: "third" });
    await live.next((message) => message.type === "chat_event" && message.event?.type === "queued" && message.event.text === "third");
    live.send({ id: "d1", type: "dequeue", chatId, index: 0 });
    const removed = await live.next((message) => message.type === "chat_event" && message.event?.type === "dequeued");
    assert.equal(removed.event?.index, 0);
    live.send({ id: "w2", type: "watch", chatId, lastSeq: 0 });
    const snapshot = await live.next((message) => message.id === "w2");
    assert.deepEqual((snapshot.result as { queue?: string[] }).queue, ["third"]);
    live.send({ id: "bad", type: "dequeue", chatId, index: 9 });
    const failed = await live.next((message) => message.id === "bad");
    assert.equal(failed.type, "error");
    live.send({ id: "x", type: "cancel", chatId });
    const cleared = await live.next((message) => message.type === "chat_event" && message.event?.type === "queue");
    assert.deepEqual(cleared.event?.items, []);
    live.send({ id: "m1", type: "set_model", chatId, modelId: "composer" });
    const model = await live.next((message) => message.type === "chat_event" && message.event?.type === "model");
    assert.equal(model.event?.modelId, "composer");
  } finally {
    live.close();
    await runner.close();
    await rm(home, { recursive: true, force: true });
  }
});

interface RpcResult {
  events: Array<{ type: string; text?: string }>;
  result?: unknown;
}

function rpc(socketPath: string, request: Record<string, unknown>): Promise<RpcResult> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buf = "";
    const events: RpcResult["events"] = [];
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buf += chunk;
      let index = buf.indexOf("\n");
      while (index >= 0) {
        const line = buf.slice(0, index);
        buf = buf.slice(index + 1);
        index = buf.indexOf("\n");
        if (!line.trim()) continue;
        const message = JSON.parse(line) as { id?: string; type?: string; event?: RpcResult["events"][number]; result?: unknown; error?: string };
        if (message.id !== request.id) continue;
        if (message.type === "event" && message.event) events.push(message.event);
        else if (message.type === "ok") resolve({ events, result: message.result });
        else fail(new Error(message.error || "runner error"));
      }
    });
    socket.on("error", fail);
    socket.on("end", () => fail(new Error("runner closed")));
    socket.write(`${JSON.stringify(request)}\n`);
  });
}

interface LiveLine {
  id?: string;
  type?: string;
  error?: string;
  result?: unknown;
  event?: { type?: string; text?: string; index?: number; items?: string[]; modelId?: string };
}

function subscribe(socketPath: string): Promise<{
  send: (request: Record<string, unknown>) => void;
  next: (match: (message: LiveLine) => boolean) => Promise<LiveLine>;
  close: () => void;
}> {
  const socket = connect(socketPath);
  return new Promise((resolve, reject) => {
    let buf = "";
    const pending: LiveLine[] = [];
    const waiters: { match: (message: LiveLine) => boolean; resolve: (message: LiveLine) => void }[] = [];
    let opened = false;
    const api = {
      send: (request: Record<string, unknown>) => socket.write(`${JSON.stringify(request)}\n`),
      next: (match: (message: LiveLine) => boolean) =>
        new Promise<LiveLine>((done) => {
          const existing = pending.findIndex(match);
          if (existing >= 0) done(pending.splice(existing, 1)[0]!);
          else waiters.push({ match, resolve: done });
        }),
      close: () => socket.end(),
    };
    const push = (message: LiveLine) => {
      if (!opened && message.id === "sub") {
        opened = true;
        resolve(api);
        return;
      }
      const index = waiters.findIndex((waiter) => waiter.match(message));
      if (index >= 0) waiters.splice(index, 1)[0]?.resolve(message);
      else pending.push(message);
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buf += chunk;
      let index = buf.indexOf("\n");
      while (index >= 0) {
        const line = buf.slice(0, index);
        buf = buf.slice(index + 1);
        index = buf.indexOf("\n");
        if (line.trim()) push(JSON.parse(line) as LiveLine);
      }
    });
    socket.on("error", reject);
    socket.write(`${JSON.stringify({ id: "sub", type: "subscribe" })}\n`);
  });
}
