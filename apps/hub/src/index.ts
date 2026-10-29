#!/usr/bin/env node
import { createHub } from "./server.ts";
import { loadSecret } from "./session.ts";

function invokedDirectly(): boolean {
  const entry = process.argv[1] || "";
  return entry.endsWith("/index.ts") || entry.endsWith("/index.js") || entry.endsWith("/engineroom-hub");
}

export function main() {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    console.error("engineroom-hub refuses to run as root");
    process.exit(1);
  }
  const listen = process.env.ENGINEROOM_LISTEN || "127.0.0.1:8787";
  const [host, portRaw] = listen.includes(":") ? splitHost(listen) : ["127.0.0.1", listen];
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0) {
    console.error("ENGINEROOM_LISTEN must be host:port");
    process.exit(1);
  }
  const secretFile = process.env.ENGINEROOM_SESSION_SECRET_FILE || "/var/lib/engineroom/session.secret";
  const hub = createHub({
    link: {
      socketDir: process.env.ENGINEROOM_SOCKET_DIR || "/run/engineroom",
      ctlPath: process.env.ENGINEROOM_CTL || "/usr/local/bin/engineroom-ctl",
    },
    sessionSecret: loadSecret(secretFile),
    pamHelper: process.env.ENGINEROOM_PAM_HELPER || "/usr/local/bin/engineroom-pam-auth",
    webDist: process.env.ENGINEROOM_WEB_DIST,
    cookieSecure: process.env.ENGINEROOM_COOKIE_SECURE !== "0",
    adminUser: process.env.ENGINEROOM_ADMIN || "",
    agentsFile: process.env.ENGINEROOM_AGENTS_FILE || "/var/lib/engineroom/agents.json",
    agentOptionsFile: process.env.ENGINEROOM_AGENT_OPTIONS_FILE || "/var/lib/engineroom/agent-options.json",
    catalogFile: process.env.ENGINEROOM_CATALOG_FILE || "/var/lib/engineroom/catalog.json",
    reposFile: process.env.ENGINEROOM_REPOS_FILE || "/var/lib/engineroom/repos.json",
    checksFile: process.env.ENGINEROOM_CHECKS_FILE || "/etc/engineroom/checks.json",
    adminCtl: process.env.ENGINEROOM_ADMIN_CTL || "/usr/local/bin/engineroom-admin",
    networkCtl: process.env.ENGINEROOM_NETWORK_CTL || "/usr/local/bin/engineroom-network",
  });
  hub.listen(port, host, () => {
    console.error(`engineroom-hub listening on ${host}:${port}`);
  });
}

function splitHost(listen: string): [string, string] {
  const index = listen.lastIndexOf(":");
  return [listen.slice(0, index) || "127.0.0.1", listen.slice(index + 1)];
}

if (invokedDirectly()) main();
