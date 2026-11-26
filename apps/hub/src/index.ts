#!/usr/bin/env node
import { loadSitePreviews } from "./agents.ts";
import { createHub } from "./server.ts";
import { createPreviewServer } from "./preview.ts";
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
  const agentsFile = process.env.ENGINEROOM_AGENTS_FILE || "/var/lib/engineroom/agents.json";
  // Previews are opt-in through ENGINEROOM_PREVIEW_LISTEN (host:port, default
  // port 8081). An empty value leaves them off.
  const previewListen = process.env.ENGINEROOM_PREVIEW_LISTEN ?? "0.0.0.0:8081";
  const [previewHost, previewPortRaw] = previewListen.includes(":")
    ? splitHost(previewListen)
    : ["0.0.0.0", previewListen];
  const parsedPreviewPort = Number(previewPortRaw);
  const previewPort =
    previewListen.trim() !== "" && Number.isInteger(parsedPreviewPort) && parsedPreviewPort > 0 ? parsedPreviewPort : 0;
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
    agentsFile,
    agentOptionsFile: process.env.ENGINEROOM_AGENT_OPTIONS_FILE || "/var/lib/engineroom/agent-options.json",
    catalogFile: process.env.ENGINEROOM_CATALOG_FILE || "/var/lib/engineroom/catalog.json",
    reposFile: process.env.ENGINEROOM_REPOS_FILE || "/var/lib/engineroom/repos.json",
    checksFile: process.env.ENGINEROOM_CHECKS_FILE || "/etc/engineroom/checks.json",
    adminCtl: process.env.ENGINEROOM_ADMIN_CTL || "/usr/local/bin/engineroom-admin",
    networkCtl: process.env.ENGINEROOM_NETWORK_CTL || "/usr/local/bin/engineroom-network",
    updateCtl: process.env.ENGINEROOM_UPDATE_CTL || "/usr/local/bin/engineroom-update",
    previewPort: previewPort || undefined,
  });
  hub.listen(port, host, () => {
    console.error(`engineroom-hub listening on ${host}:${port}`);
  });

  // Site previews run beside the app on their own port. The port is bound so
  // that turning previews on in Admin takes effect at once instead of at the
  // next restart; while the setting is off every request on it is answered with
  // a 404 and no file is read. Setting the listen address to an empty string
  // leaves the port unbound entirely.
  if (previewPort) {
    // Previews send anything that is not a preview back to the app on the host
    // the visitor used, so a name or an address both work.
    const preview = createPreviewServer({
      link: {
        socketDir: process.env.ENGINEROOM_SOCKET_DIR || "/run/engineroom",
        ctlPath: process.env.ENGINEROOM_CTL || "/usr/local/bin/engineroom-ctl",
      },
      reposFile: process.env.ENGINEROOM_REPOS_FILE || "/var/lib/engineroom/repos.json",
      appPort: port,
      enabled: () => loadSitePreviews(agentsFile),
    });
    preview.listen(previewPort, previewHost, () => {
      const state = loadSitePreviews(agentsFile) ? "on" : "off until an administrator turns it on";
      console.error(`engineroom site previews on http://${previewHost}:${previewPort}/<user>/ (${state})`);
    });
  }
}

function splitHost(listen: string): [string, string] {
  const index = listen.lastIndexOf(":");
  return [listen.slice(0, index) || "127.0.0.1", listen.slice(index + 1)];
}

if (invokedDirectly()) main();
