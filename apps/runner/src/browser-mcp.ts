import { connect } from "node:net";
import { pathToFileURL } from "node:url";

const TOOLS = [
  {
    name: "browser_navigate",
    description: "Open an http or https page in the shared Engineroom browser. The signed-in person watches this same page.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "browser_snapshot",
    description: "Read the current page URL, title, and visible text from the shared browser.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_click",
    description: "Click an element by CSS selector, or by x and y viewport coordinates, in the shared browser.",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string" }, x: { type: "number" }, y: { type: "number" } },
    },
  },
  {
    name: "browser_type",
    description: "Type text into the focused element, or into the element matching selector, in the shared browser.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" }, selector: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "browser_press",
    description: "Press a key in the shared browser, such as Enter, Backspace, Tab, Escape, or an arrow key.",
    inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
  },
  {
    name: "browser_scroll",
    description: "Scroll the shared browser page. deltaY is pixels, positive moves down.",
    inputSchema: {
      type: "object",
      properties: {
        deltaY: { type: "number" },
        deltaX: { type: "number" },
        x: { type: "number" },
        y: { type: "number" },
      },
    },
  },
];

async function main() {
  const sock = process.env.ENGINEROOM_RUNNER_SOCK || "";
  const chatId = process.env.ENGINEROOM_BROWSER_CHAT || "";
  if (!sock || !chatId) {
    console.error("browser mcp is missing its runner socket");
    process.exit(1);
  }
  const input = readMessages(process.stdin);
  for await (const message of input) {
    const response = await handle(message, sock, chatId);
    if (response) writeMessage(response);
  }
}

async function handle(message: Record<string, unknown>, sock: string, chatId: string): Promise<Record<string, unknown> | null> {
  if (message.jsonrpc !== "2.0") return null;
  if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return null;
  const id = message.id;
  if (message.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "engineroom-browser", version: "0.1.0" },
      },
    };
  }
  if (message.method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  }
  if (message.method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (message.method !== "tools/call") {
    return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } };
  }
  const params = message.params && typeof message.params === "object" ? message.params as Record<string, unknown> : {};
  const name = typeof params.name === "string" ? params.name : "";
  const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
  try {
    const result = await callRunner(sock, {
      id: "1",
      type: "browser_tool",
      chatId,
      name,
      args,
    });
    const text = result && typeof result === "object" && typeof (result as { text?: unknown }).text === "string"
      ? (result as { text: string }).text
      : "Done";
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } };
  } catch (error) {
    const text = error instanceof Error ? error.message : "browser failed";
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } };
  }
}

function callRunner(sock: string, request: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(sock);
    let buf = "";
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.setEncoding("utf8");
    socket.on("error", fail);
    socket.on("data", (chunk: string) => {
      buf += chunk;
      const index = buf.indexOf("\n");
      if (index < 0) return;
      socket.end();
      try {
        const message = JSON.parse(buf.slice(0, index)) as { type?: string; result?: unknown; error?: string };
        if (message.type === "ok") resolve(message.result);
        else reject(new Error(message.error || "browser failed"));
      } catch {
        reject(new Error("browser failed"));
      }
    });
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
  });
}

// MCP over stdio is newline-delimited JSON. LSP-style Content-Length framing
// (which this used to use) is never understood by the agent, so session/new
// waited forever for the MCP handshake to complete.
async function* readMessages(stream: NodeJS.ReadableStream): AsyncGenerator<Record<string, unknown>> {
  let buf = "";
  for await (const chunk of stream) {
    buf += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    let index = buf.indexOf("\n");
    while (index >= 0) {
      const line = buf.slice(0, index).replace(/\r$/, "").trim();
      buf = buf.slice(index + 1);
      index = buf.indexOf("\n");
      if (!line) continue;
      try {
        yield JSON.parse(line) as Record<string, unknown>;
      } catch {
        /* skip a malformed message */
      }
    }
  }
}

function writeMessage(message: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const entry = process.argv[1] || "";
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
