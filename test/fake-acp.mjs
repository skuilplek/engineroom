import { createInterface } from "node:readline";

const pending = new Map();
let holding = false;
const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id != null && msg.method == null && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
    return;
  }
  void handle(msg).catch((error) => {
    if (msg.id != null) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { message: error.message } })}\n`);
    }
  });
});

async function handle(msg) {
  if (msg.method === "initialize") {
    return reply(msg.id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { list: {} },
        promptCapabilities: { image: true },
      },
      authMethods: [],
    });
  }
  if (msg.method === "session/new") {
    return reply(msg.id, sessionBody("fake-session"));
  }
  if (msg.method === "session/load") {
    if (msg.params?.sessionId === "missing") {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Invalid params" } })}\n`);
      return;
    }
    notify("session/update", {
      sessionId: msg.params.sessionId,
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "earlier" } },
    });
    notify("session/update", {
      sessionId: msg.params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "replay" } },
    });
    return reply(msg.id, sessionBody(msg.params.sessionId));
  }
  if (msg.method === "session/list") {
    return reply(msg.id, { sessions: [{ sessionId: "ext-1", cwd: msg.params?.cwd || "/tmp", updatedAt: new Date().toISOString(), title: "Outside" }] });
  }
  if (msg.method === "session/set_mode" || msg.method === "session/set_model") {
    if (holding) return;
    return reply(msg.id, {});
  }
  if (msg.method === "session/prompt") {
    const blocks = Array.isArray(msg.params?.prompt) ? msg.params.prompt : [];
    const text = blocks.find((block) => block?.type === "text")?.text || "";
    const links = blocks.filter((block) => block?.type === "resource_link").length;
    const images = blocks.filter((block) => block?.type === "image").length;
    const sessionId = msg.params.sessionId;
    if (text === "hold") {
      holding = true;
      notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "held" } } });
      return;
    }
    if (text === "run-terminal") {
      const created = await request(11, "terminal/create", {
        command: process.execPath,
        args: ["-e", "process.stdout.write('term-out-✓')"],
      });
      const waited = await request(12, "terminal/wait_for_exit", {
        terminalId: created.terminalId,
      });
      const missing = await request(13, "terminal/create", {
        command: "/nonexistent-binary-er-test",
        args: [],
      });
      const missingWait = await request(14, "terminal/wait_for_exit", {
        terminalId: missing.terminalId,
      });
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `out:${waited.output}:missing:${missingWait.exitStatus.exitCode}` },
        },
      });
      return reply(msg.id, { stopReason: "end_turn" });
    }
    notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello " } } });
    notify("session/update", {
      sessionId,
      update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read note", kind: "read", status: "pending", rawInput: { path: "note.txt" } },
    });
    if (text.includes("permit")) {
      const choice = await request(7, "session/request_permission", {
        toolCall: { toolCallId: "t1", title: "Read note", kind: "read" },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      });
      if (choice?.outcome?.optionId === "reject-once") {
        return reply(msg.id, { stopReason: "cancelled" });
      }
    }
    notify("session/update", {
      sessionId,
      update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: { content: "note" } },
    });
    notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } } });
    if (links || images) {
      notify("session/update", {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `files:${links}:${images}` } },
      });
    }
    return reply(msg.id, { stopReason: "end_turn" });
  }
  if (msg.method === "session/cancel") return;
  if (msg.id != null) reply(msg.id, {});
}

function sessionBody(sessionId) {
  return {
    sessionId,
    modes: { currentModeId: "agent", availableModes: [{ id: "agent", name: "Agent" }, { id: "plan", name: "Plan" }] },
    models: { currentModelId: "fake", availableModels: [{ modelId: "fake", name: "Fake" }] },
  };
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function notify(method, params) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

function request(id, method, params) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve) => pending.set(id, resolve));
}
