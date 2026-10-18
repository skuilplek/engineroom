import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { AgentDriver } from "../apps/runner/src/drivers.ts";
import { startRunner } from "../apps/runner/src/server.ts";
import { syncGrantedRepositories } from "../apps/runner/src/repos.ts";
import { createChat, listChats, listRepositories, setEnabledRepositories, updateChat } from "../apps/runner/src/store.ts";
import { listGitRepositories, listWorkspaces, resolveWorkspace } from "../apps/runner/src/workspace.ts";
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
    const chat = await createChat(home, { title: "New chat" });
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

void writeFile;
