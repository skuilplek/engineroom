import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdtemp, mkdir, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { AgentDriver } from "../apps/runner/src/drivers.ts";
import { archiveDirectory, archiveFileName, archivePath, archiveUserHash } from "../apps/runner/src/archive.ts";
import { startRunner } from "../apps/runner/src/server.ts";
import { createRepository, syncGrantedRepositories } from "../apps/runner/src/repos.ts";
import { createChat, deleteRepository, getChat, listChats, listRepositories, setEnabledRepositories, setRepositoryArchived, updateChat } from "../apps/runner/src/store.ts";
import { listGitRepositories, listWorkspaces, resolveWorkspace } from "../apps/runner/src/workspace.ts";
import { assertBranchName, MAX_TRANSFER_BYTES } from "@engineroom/protocol";
import { gitCreateBranch, gitInitWorkspace, gitPull, gitPush, gitSetRemote, gitStatus, gitSwitch, readGitIdentity, writeGitIdentity } from "../apps/runner/src/git.ts";
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

test("home file preview reads a plan outside the repository and rejects escapes", async () => {
  const { readHomeFile } = await import("../apps/runner/src/files.ts");
  const home = await mkdtemp(path.join(tmpdir(), "er-home-file-"));
  const outside = await mkdtemp(path.join(tmpdir(), "er-home-file-out-"));
  const plan = path.join(home, ".cursor", "plans", "Prompt file attachments-c99d43bc.plan.md");
  await mkdir(path.dirname(plan), { recursive: true });
  await writeFile(plan, "# Prompt photos\n");
  await writeFile(path.join(outside, "secret.txt"), "nope");
  await symlink(path.join(outside, "secret.txt"), path.join(home, "escape.txt"));
  try {
    const content = await readHomeFile(home, plan);
    assert.equal(content.content, "# Prompt photos\n");
    assert.equal(content.path, plan);
    assert.equal(content.binary, false);
    await assert.rejects(() => readHomeFile(home, path.join(outside, "secret.txt")), /invalid file path/);
    await assert.rejects(() => readHomeFile(home, path.join(home, "escape.txt")), /invalid file path/);
    await assert.rejects(() => readHomeFile(home, path.join(home, "missing.md")), /file not found/);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
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
      defaultResult.changes.map((item) => ({
        path: item.path,
        status: item.status,
        staged: item.staged,
        unstaged: item.unstaged,
        indexStatus: item.indexStatus,
        worktreeStatus: item.worktreeStatus,
      })),
      [
        { path: "src/index.ts", status: "M", staged: false, unstaged: true, indexStatus: undefined, worktreeStatus: "M" },
        { path: "src/new.ts", status: "?", staged: false, unstaged: true, indexStatus: undefined, worktreeStatus: "?" },
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
    assert.equal(status.remote, "");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("git remote, branch, pull, and push stay inside an enabled workspace", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "er-git-remote-"));
  const repo = path.join(home, "Sites", "proj");
  const bare = path.join(home, "bare.git");
  const other = path.join(home, "other");
  let daemon: ChildProcess | undefined;
  try {
    await mkdir(path.join(home, "notes"), { recursive: true });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await execFileAsync("git", ["init", "-b", "main"], { cwd: repo });
    await execFileAsync("git", ["config", "user.email", "alice@example.com"], { cwd: repo });
    await execFileAsync("git", ["config", "user.name", "Alice"], { cwd: repo });
    await writeFile(path.join(repo, "src", "index.ts"), "export const x = 1;\n");
    await execFileAsync("git", ["add", "src/index.ts"], { cwd: repo });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repo });
    await setEnabledRepositories(home, [repo]);

    assert.equal((await gitStatus(home, repo)).remote, "");
    await assert.rejects(() => gitPull(home, repo), /no remote/);
    await assert.rejects(() => gitPush(home, repo), /no remote/);
    await assert.rejects(() => gitSetRemote(home, repo, "file:///tmp/repo.git"), /invalid repository url/);
    await assert.rejects(() => gitSetRemote(home, path.join(home, "notes"), "https://example.com/proj.git"), /not enabled/);

    const set = await gitSetRemote(home, repo, "https://example.com/proj.git");
    assert.equal(set.remote, "https://example.com/proj.git");
    const updated = await gitSetRemote(home, repo, "https://example.com/other.git");
    assert.equal(updated.remote, "https://example.com/other.git");

    await execFileAsync("git", ["init", "--bare", "-b", "main", bare]);
    await execFileAsync("git", ["remote", "set-url", "origin", bare], { cwd: repo });
    await execFileAsync("git", ["push", "-u", "origin", "HEAD:refs/heads/main"], { cwd: repo });
    const port = await freePort();
    daemon = spawn("git", [
      "daemon",
      "--verbose",
      "--reuseaddr",
      "--listen=127.0.0.1",
      `--port=${port}`,
      `--base-path=${home}`,
      "--export-all",
      "--enable=receive-pack",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    await waitForGitDaemon(daemon);
    const remoteUrl = `git://127.0.0.1:${port}/bare.git`;
    await execFileAsync("git", ["remote", "set-url", "origin", remoteUrl], { cwd: repo });
    const pushed = await gitPush(home, repo);
    assert.equal(pushed.branch, "main");
    assert.equal(pushed.remote, remoteUrl);

    await execFileAsync("git", ["clone", bare, other]);
    await execFileAsync("git", ["config", "user.email", "bob@example.com"], { cwd: other });
    await execFileAsync("git", ["config", "user.name", "Bob"], { cwd: other });
    await writeFile(path.join(other, "src", "index.ts"), "export const x = 2;\n");
    await execFileAsync("git", ["add", "src/index.ts"], { cwd: other });
    await execFileAsync("git", ["commit", "-m", "update"], { cwd: other });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: other });
    const pulled = await gitPull(home, repo);
    assert.equal(pulled.branch, "main");
    assert.match(await readFile(path.join(repo, "src", "index.ts"), "utf8"), /x = 2/);

    const created = await gitCreateBranch(home, repo, "feature");
    assert.equal(created.branch, "feature");
    assert.equal(created.branches.includes("feature"), true);
    await assert.rejects(() => gitCreateBranch(home, repo, "feature"), /already exists/);
    await assert.rejects(() => gitCreateBranch(home, repo, "foo..bar"), /invalid branch/);
    const feature = await gitPush(home, repo);
    assert.equal(feature.branch, "feature");
    assert.match((await execFileAsync("git", ["branch", "--list", "feature"], { cwd: bare })).stdout, /feature/);

    await execFileAsync("git", ["checkout", "--detach"], { cwd: repo });
    await assert.rejects(() => gitPull(home, repo), /checkout a branch first/);
    await assert.rejects(() => gitPush(home, repo), /checkout a branch first/);
    await assert.rejects(() => gitCreateBranch(home, repo, "more"), /checkout a branch first/);
  } finally {
    if (daemon) {
      daemon.kill("SIGKILL");
      daemon.stderr?.destroy();
      daemon.unref();
    }
    await rm(home, { recursive: true, force: true });
  }
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function waitForGitDaemon(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(stderr.trim() || "git daemon did not start"));
    }, 5_000);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-500);
      if (!settled && stderr.includes("Ready to rumble")) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(stderr.trim() || `git daemon exited ${code}`));
    });
  });
}

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
    assert.deepEqual((snapshot.result as { queue?: { text: string }[] }).queue, [{ text: "third", attachments: [] }]);
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

test("prompt attachments stay in the hidden upload folder", async () => {
  const { savePromptAttachment, loadPromptAttachments, listRepositoryFiles } = await import("../apps/runner/src/files.ts");
  const { MAX_PROMPT_ATTACHMENT_BYTES } = await import("@engineroom/protocol");
  const home = await mkdtemp(path.join(tmpdir(), "er-attach-"));
  const outside = await mkdtemp(path.join(tmpdir(), "er-attach-out-"));
  const repo = path.join(home, "Sites", "proj");
  try {
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(outside, "secret.txt"), "nope");
    await execFileAsync("git", ["init", "-b", "main"], { cwd: repo });
    await setEnabledRepositories(home, [repo]);
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const saved = await savePromptAttachment(home, repo, "My Shot.png", "application/octet-stream", png.toString("base64"));
    assert.equal(saved.mimeType, "image/png");
    assert.match(saved.path, /^\.engineroom\/uploads\/[0-9a-f-]{36}-My_Shot\.png$/);
    const hidden = await listRepositoryFiles(home, repo);
    assert.equal(hidden.files.some((file) => file.path.startsWith(".engineroom")), false);
    const visible = await listRepositoryFiles(home, repo, { showHidden: true, showGitignored: true, showGitDir: false });
    assert.equal(visible.files.some((file) => file.path === saved.path), true);
    const loaded = await loadPromptAttachments(home, repo, [saved]);
    assert.equal((loaded[0]?.data?.length ?? 0) > 0, true);
    assert.match(loaded[0]?.uri || "", /^file:/);
    await symlink(path.join(outside, "secret.txt"), path.join(repo, ".engineroom", "uploads", "evil"));
    await assert.rejects(
      () => loadPromptAttachments(home, repo, [{ name: "evil", path: ".engineroom/uploads/evil", mimeType: "text/plain", size: 4 }]),
      /invalid attachment/,
    );
    await assert.rejects(
      () => savePromptAttachment(
        home,
        repo,
        "big.bin",
        "application/octet-stream",
        Buffer.alloc(MAX_PROMPT_ATTACHMENT_BYTES + 1).toString("base64"),
      ),
      /too large/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("a queued prompt keeps its attachments for the next turn", async () => {
  const { savePromptAttachment } = await import("../apps/runner/src/files.ts");
  const home = await mkdtemp(path.join(tmpdir(), "er-attach-queue-"));
  const sock = path.join(home, "runner.sock");
  const seen: string[] = [];
  let release: () => void = () => undefined;
  const drivers: Record<AgentDriver["id"], AgentDriver> = {
    cursor: {
      id: "cursor",
      async run(ctx) {
        seen.push(ctx.prompt);
        if (seen.length === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        ctx.onEvent({ type: "done", agentSessionId: "s" });
        return { agentSessionId: "s" };
      },
    },
    claude: { id: "claude", async run() { throw new Error("not used"); } },
    pi: { id: "pi", async run() { throw new Error("not used"); } },
  };
  const runner = await startRunner({ home, socketPath: sock, drivers, peerCheck: () => undefined });
  const live = await subscribe(sock);
  try {
    const saved = await savePromptAttachment(home, home, "notes.txt", "text/plain", Buffer.from("hello").toString("base64"));
    const created = await rpc(sock, { id: "c", type: "create_chat", agent: "cursor", workspace: home });
    const chatId = (created.result as { id: string }).id;
    live.send({ id: "w", type: "watch", chatId, lastSeq: 0 });
    await live.next((message) => message.id === "w");
    live.send({ id: "p1", type: "prompt", chatId, prompt: "first" });
    for (let attempt = 0; attempt < 50 && seen.length < 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(seen[0], "first");
    live.send({ id: "p2", type: "prompt", chatId, prompt: "look", attachments: [saved] });
    await live.next((message) => message.type === "chat_event" && message.event?.type === "queued" && message.event.text === "look");
    release();
    const echoed = await live.next((message) => message.event?.type === "user_message" && message.event.attachments?.[0]?.path === saved.path);
    for (let attempt = 0; attempt < 50 && seen.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.match(seen[1] || "", new RegExp(`${saved.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(text/plain\\)`));
    assert.equal(echoed.event?.attachments?.[0]?.path, saved.path);
  } finally {
    release();
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
  event?: {
    type?: string;
    text?: string;
    index?: number;
    items?: { text: string }[];
    modelId?: string;
    attachments?: { path?: string }[];
  };
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

test("a project archive is a zip in /tmp and does not follow symlinks", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "er-archive-"));
  const outside = await mkdtemp(path.join(tmpdir(), "er-archive-out-"));
  const repo = path.join(home, "Sites", "proj");
  const sock = path.join(home, "runner.sock");
  const victim = path.join(home, "victim.txt");
  const drivers: Record<AgentDriver["id"], AgentDriver> = {
    cursor: { id: "cursor", async run() { throw new Error("not used"); } },
    claude: { id: "claude", async run() { throw new Error("not used"); } },
    pi: { id: "pi", async run() { throw new Error("not used"); } },
  };
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(path.join(outside, "nested"), { recursive: true });
  await writeFile(path.join(repo, "src", "note.txt"), "hello\n");
  await writeFile(path.join(outside, "secret.txt"), "top-secret");
  await writeFile(path.join(outside, "nested", "hidden.txt"), "hidden");
  await writeFile(victim, "keep");
  await symlink(path.join(outside, "secret.txt"), path.join(repo, "src", "escape.txt"));
  await symlink(path.join(outside, "nested"), path.join(repo, "linked"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repo });
  await setEnabledRepositories(home, [repo]);
  const runner = await startRunner({ home, socketPath: sock, drivers, peerCheck: () => undefined });
  const expectedName = archiveFileName("proj");
  assert.notEqual(archiveDirectory("alice"), archiveDirectory("bob"));
  assert.match(archiveUserHash("alice"), /^[0-9a-f]{64}$/);
  await mkdir(archiveDirectory(), { recursive: true, mode: 0o700 });
  const planted = archivePath(expectedName);
  const created: string[] = [planted];
  await symlink(victim, planted);
  try {
    const blocked = await rpc(sock, { id: "b1", type: "start_project_archive", workspace: repo });
    const blockedJob = blocked.result as { id: string; filename: string; status: string };
    assert.equal(blockedJob.status, "creating");
    assert.equal(blockedJob.filename, expectedName);
    const blockedStatus = await waitArchive(sock, blockedJob.id);
    assert.equal(blockedStatus.status, "failed");
    assert.match(blockedStatus.error || "", /not a regular file/);
    assert.equal(await readFile(victim, "utf8"), "keep");
    assert.equal((await lstat(planted)).isSymbolicLink(), true);
    await rm(planted);

    const started = await rpc(sock, { id: "z1", type: "start_project_archive", workspace: repo });
    const job = started.result as { id: string; filename: string; status: string };
    const again = await rpc(sock, { id: "z2", type: "start_project_archive", workspace: repo });
    const second = again.result as { id: string; status: string };
    if (second.status === "creating") assert.equal(second.id, job.id);
    const ready = await waitArchive(sock, job.id);
    assert.equal(ready.status, "ready");
    const zipPath = archivePath(ready.filename);
    created.push(zipPath);
    assert.equal(path.dirname(zipPath), archiveDirectory());
    assert.notEqual(path.dirname(zipPath), "/tmp");
    const dirInfo = await lstat(archiveDirectory());
    assert.equal(dirInfo.isDirectory(), true);
    assert.equal(dirInfo.mode & 0o777, 0o700);
    const info = await lstat(zipPath);
    assert.equal(info.isSymbolicLink(), false);
    assert.equal(info.isFile(), true);
    assert.equal(info.mode & 0o777, 0o600);
    assert.match(ready.filename, /^proj-\d{10}\.zip$/);
    const downloaded = await rpcBytes(sock, { id: "z3", type: "read_project_archive", archiveId: job.id });
    assert.equal(downloaded.result.filename, ready.filename);
    assert.deepEqual(downloaded.body, await readFile(zipPath));
    const { stdout } = await execFileAsync("python3", ["-c", ZIP_CHECK, zipPath, path.join(outside, "secret.txt")]);
    assert.match(stdout, /NOTE hello/);
    assert.match(stdout, /LINK_OK/);
    assert.match(stdout, /MODE_LINK/);
    assert.match(stdout, /HAS_GIT/);
    assert.match(stdout, /NOT_EXPANDED/);
    assert.equal(await readFile(path.join(outside, "secret.txt"), "utf8"), "top-secret");
  } finally {
    await runner.close();
    for (const file of created) await rm(file, { force: true });
    await rm(home, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("stage, unstage, discard, and commit keep hidden files out of the index", async () => {
  const {
    commitRepositoryChanges,
    discardRepositoryChange,
    listRepositoryFiles,
    stageRepositoryChange,
    unstageRepositoryChange,
  } = await import("../apps/runner/src/files.ts");
  const home = await mkdtemp(path.join(tmpdir(), "er-git-change-"));
  const repo = path.join(home, "Sites", "proj");
  const visibility = { showHidden: false, showGitignored: false, showGitDir: false };
  const revealed = { showHidden: true, showGitignored: true, showGitDir: false };
  await mkdir(repo, { recursive: true });
  try {
    await execFileAsync("git", ["init", "-b", "main"], { cwd: repo });
    await execFileAsync("git", ["config", "user.email", "alice@example.com"], { cwd: repo });
    await execFileAsync("git", ["config", "user.name", "Alice"], { cwd: repo });
    await writeFile(path.join(repo, "kept.ts"), "one\n");
    await writeFile(path.join(repo, "dirty.ts"), "base\n");
    await execFileAsync("git", ["add", "kept.ts", "dirty.ts"], { cwd: repo });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repo });

    await writeFile(path.join(repo, "kept.ts"), "two\n");
    await execFileAsync("git", ["add", "kept.ts"], { cwd: repo });
    await writeFile(path.join(repo, "kept.ts"), "three\n");
    await writeFile(path.join(repo, "dirty.ts"), "edited\n");
    await writeFile(path.join(repo, "added.ts"), "new\n");
    await execFileAsync("git", ["add", "added.ts"], { cwd: repo });
    await writeFile(path.join(repo, "fresh.ts"), "untracked\n");
    await writeFile(path.join(repo, ".env"), "SECRET=1\n");
    await setEnabledRepositories(home, [repo]);

    const listed = await listRepositoryFiles(home, repo, visibility);
    const byPath = new Map(listed.changes.map((item) => [item.path, item]));
    assert.equal(byPath.get("kept.ts")?.staged, true);
    assert.equal(byPath.get("kept.ts")?.unstaged, true);
    assert.equal(byPath.get("kept.ts")?.indexStatus, "M");
    assert.equal(byPath.get("kept.ts")?.worktreeStatus, "M");
    assert.equal(byPath.get("dirty.ts")?.staged, false);
    assert.equal(byPath.get("dirty.ts")?.unstaged, true);
    assert.equal(byPath.get("dirty.ts")?.indexStatus, undefined);
    assert.equal(byPath.get("dirty.ts")?.worktreeStatus, "M");
    assert.equal(byPath.get("added.ts")?.staged, true);
    assert.equal(byPath.get("added.ts")?.unstaged, false);
    assert.equal(byPath.get("added.ts")?.indexStatus, "A");
    assert.equal(byPath.get("fresh.ts")?.staged, false);
    assert.equal(byPath.get("fresh.ts")?.worktreeStatus, "?");
    assert.equal(byPath.has(".env"), false);

    await assert.rejects(() => stageRepositoryChange(home, repo, ".env", visibility), /hidden by policy/);
    await assert.rejects(() => stageRepositoryChange(home, repo, "../secret", visibility), /invalid file path/);

    await discardRepositoryChange(home, repo, "kept.ts", visibility);
    assert.equal(await readFile(path.join(repo, "kept.ts"), "utf8"), "two\n");
    const kept = (await listRepositoryFiles(home, repo, visibility)).changes.find((item) => item.path === "kept.ts");
    assert.equal(kept?.staged, true);
    assert.equal(kept?.unstaged, false);
    assert.equal(kept?.indexStatus, "M");

    await discardRepositoryChange(home, repo, "fresh.ts", visibility);
    await assert.rejects(() => readFile(path.join(repo, "fresh.ts"), "utf8"));
    const afterDelete = await listRepositoryFiles(home, repo, visibility);
    assert.equal(afterDelete.changes.some((item) => item.path === "fresh.ts"), false);
    assert.equal(afterDelete.changes.some((item) => item.path === "dirty.ts"), true);

    await stageRepositoryChange(home, repo, "dirty.ts", visibility);
    const stagedDirty = (await listRepositoryFiles(home, repo, visibility)).changes.find((item) => item.path === "dirty.ts");
    assert.equal(stagedDirty?.staged, true);
    assert.equal(stagedDirty?.unstaged, false);

    await unstageRepositoryChange(home, repo, "added.ts", visibility);
    const unstagedAdded = (await listRepositoryFiles(home, repo, visibility)).changes.find((item) => item.path === "added.ts");
    assert.equal(unstagedAdded?.staged, false);
    assert.equal(unstagedAdded?.worktreeStatus, "?");

    await commitRepositoryChanges(home, repo, "save the edit", true, visibility);
    const saved = await execFileAsync("git", ["log", "-1", "--format=%s"], { cwd: repo });
    assert.equal(saved.stdout.trim(), "save the edit");
    const afterCommit = await listRepositoryFiles(home, repo, visibility);
    assert.equal(afterCommit.changes.some((item) => item.path === "kept.ts"), false);
    assert.equal(afterCommit.changes.some((item) => item.path === "dirty.ts"), false);
    assert.equal(afterCommit.changes.find((item) => item.path === "added.ts")?.worktreeStatus, "?");
    assert.equal(
      (await listRepositoryFiles(home, repo, revealed)).changes.some((item) => item.path === ".env"),
      true,
    );

    await commitRepositoryChanges(home, repo, "add the new file", true, visibility);
    const added = await execFileAsync("git", ["log", "-1", "--format=%s"], { cwd: repo });
    assert.equal(added.stdout.trim(), "add the new file");
    assert.equal((await listRepositoryFiles(home, repo, visibility)).changes.length, 0);
    assert.equal(
      (await listRepositoryFiles(home, repo, revealed)).changes.some((item) => item.path === ".env"),
      true,
    );
    await assert.rejects(() => commitRepositoryChanges(home, repo, "again", false, visibility), /nothing to commit/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

const ZIP_CHECK = `
import zipfile, sys
z = zipfile.ZipFile(sys.argv[1])
names = set(z.namelist())
note = z.read("src/note.txt").decode()
link = z.read("src/escape.txt").decode()
mode = z.getinfo("src/escape.txt").external_attr >> 16
print("NOTE", note.strip())
print("LINK_OK" if link == sys.argv[2] and "top-secret" not in link else "LINK_BAD " + link)
print("MODE_LINK" if (mode & 0o170000) == 0o120000 else "MODE_BAD " + oct(mode))
print("HAS_GIT" if any(name.startswith(".git/") for name in names) else "NO_GIT")
print("NOT_EXPANDED" if not any(name.startswith("linked/") for name in names) else "EXPANDED")
`;

async function waitArchive(socketPath: string, archiveId: string): Promise<{ status: string; filename: string; error?: string; size?: number }> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const status = await rpc(socketPath, { id: `st${attempt}`, type: "project_archive_status", archiveId });
    const body = status.result as { status: string; filename: string; error?: string; size?: number };
    if (body.status === "ready" || body.status === "failed") return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("archive did not finish");
}

function rpcBytes(socketPath: string, request: Record<string, unknown>): Promise<{ result: { filename: string; size: number }; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let received = Buffer.alloc(0);
    const chunks: Buffer[] = [];
    let header: { filename: string; size: number } | undefined;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    const take = (chunk: Buffer) => {
      if (!header) return;
      chunks.push(chunk);
      if (Buffer.concat(chunks).length >= header.size) {
        settled = true;
        socket.end();
        resolve({ result: header, body: Buffer.concat(chunks).subarray(0, header.size) });
      }
    };
    socket.on("data", (chunk: Buffer) => {
      if (header) {
        take(chunk);
        return;
      }
      received = Buffer.concat([received, chunk]);
      const index = received.indexOf(0x0a);
      if (index < 0) return;
      const message = JSON.parse(received.subarray(0, index).toString("utf8")) as { type?: string; error?: string; result?: { filename: string; size: number } };
      if (message.type === "error") {
        fail(new Error(message.error || "runner error"));
        return;
      }
      header = message.result;
      take(received.subarray(index + 1));
    });
    socket.on("error", fail);
    socket.on("end", () => {
      if (!settled) fail(new Error("runner closed"));
    });
    socket.write(`${JSON.stringify(request)}\n`);
  });
}

test("archiving a project keeps the folder and deleting it requires the folder name", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "er-project-life-"));
  const outside = await mkdtemp(path.join(tmpdir(), "er-project-life-out-"));
  const sites = path.join(home, "Sites");
  const repo = path.join(sites, "widget");
  const other = path.join(sites, "other");
  await mkdir(path.join(repo, ".git"), { recursive: true });
  await mkdir(path.join(other, ".git"), { recursive: true });
  await symlink(outside, path.join(sites, "link"));
  try {
    await setEnabledRepositories(home, [repo, other]);
    const archived = await setRepositoryArchived(home, repo, true);
    assert.equal(archived.find((entry) => entry.name === "widget")?.archived, true);
    assert.equal(archived.find((entry) => entry.name === "other")?.archived, false);
    await stat(repo);
    const rewritten = await setEnabledRepositories(home, [repo, other]);
    assert.equal(rewritten.find((entry) => entry.name === "widget")?.archived, true);
    const dropped = await setEnabledRepositories(home, [other]);
    assert.equal(dropped.find((entry) => entry.name === "widget")?.archived, false);
    await setEnabledRepositories(home, [repo, other]);
    await setRepositoryArchived(home, repo, true);
    const restored = await setRepositoryArchived(home, repo, false);
    assert.equal(restored.find((entry) => entry.name === "widget")?.archived, false);

    await assert.rejects(() => deleteRepository(home, path.join(sites, "link"), "widget"), /invalid repository/);
    await stat(repo);
    await assert.rejects(() => deleteRepository(home, repo, "nope"), /project name does not match/);
    await stat(repo);

    const kept = await createChat(home, { workspace: other, title: "stays" });
    const gone = await createChat(home, { workspace: repo, title: "goes" });
    const cancelled: string[] = [];
    await deleteRepository(home, repo, "widget", (id) => cancelled.push(id));
    assert.deepEqual(cancelled, [gone.id]);
    await assert.rejects(() => stat(repo));
    await assert.rejects(() => stat(path.join(home, ".engineroom", "chats", gone.id)));
    await stat(path.join(home, ".engineroom", "chats", kept.id));
    const listed = await listRepositories(home);
    assert.equal(listed.some((entry) => entry.name === "widget"), false);
    assert.equal(listed.find((entry) => entry.name === "other")?.enabled, true);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("global git identity is stored in the account home", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "er-git-id-"));
  try {
    assert.deepEqual(await readGitIdentity(home), { name: "", email: "" });
    assert.deepEqual(await writeGitIdentity(home, " Ada Lovelace ", "ada@example.com"), {
      name: "Ada Lovelace",
      email: "ada@example.com",
    });
    const stored = await readFile(path.join(home, ".gitconfig"), "utf8");
    assert.match(stored, /name = Ada Lovelace/);
    assert.match(stored, /email = ada@example.com/);
    await assert.rejects(() => writeGitIdentity(home, "Ada", "not-an-email"), /invalid git email/);
    await assert.rejects(() => writeGitIdentity(home, "-Ada", "ada@example.com"), /invalid git name/);
    assert.deepEqual(await readGitIdentity(home), { name: "Ada Lovelace", email: "ada@example.com" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
