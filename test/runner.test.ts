import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { AgentDriver } from "../apps/runner/src/drivers.ts";
import { startRunner } from "../apps/runner/src/server.ts";
import { createChat, listChats } from "../apps/runner/src/store.ts";
import { listWorkspaces, resolveWorkspace } from "../apps/runner/src/workspace.ts";

const execFileAsync = promisify(execFile);
const helper = path.resolve("deploy/pam/engineroom-peercred");

test.before(async () => {
  spawnSync("gcc", ["-O2", "-Wall", "-o", helper, "deploy/pam/engineroom-peercred.c"], { stdio: "inherit" });
  process.env.ENGINEROOM_PEERCRED = helper;
});

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
    assert.equal(sent.events.some((event) => event.type === "text_delta" && event.text === "echo:build the door"), true);
    const detail = await rpc(sock, { id: "g1", type: "get_chat", chatId });
    const transcript = (detail.result as { transcript: Array<{ kind: string; text?: string }>; chat: { agentSessionId: string; title: string } });
    assert.equal(transcript.chat.agentSessionId, "cursor-session");
    assert.equal(transcript.chat.title, "build the door");
    assert.equal(transcript.transcript.some((entry) => entry.kind === "user"), true);
    assert.equal(transcript.transcript.some((entry) => entry.text === "echo:build the door"), true);

    const outside = rpc(sock, {
      id: "bad",
      type: "create_chat",
      workspace: "/etc",
    });
    await assert.rejects(outside, /home directory|runner/);

    const hanging = await rpc(sock, { id: "c2", type: "create_chat", agent: "claude" });
    const hangingId = (hanging.result as { id: string }).id;
    const pending = rpc(sock, { id: "s2", type: "send", chatId: hangingId, prompt: "wait" });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const live = await rpc(sock, { id: `p${attempt}`, type: "get_chat", chatId: hangingId });
      if ((live.result as { chat: { running?: boolean } }).chat.running) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await rpc(sock, { id: "x", type: "cancel", chatId: hangingId });
    const stopped = await pending;
    assert.equal(sawAbort, true);
    assert.equal(stopped.events.some((event) => event.type === "status" && event.text === "Stopped"), true);
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
