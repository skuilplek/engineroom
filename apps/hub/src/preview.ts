import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { parseSitePath, PREVIEW_NEEDS_SERVER } from "@engineroom/protocol";
import { accountNames } from "./accounts.ts";
import { lookupUser, type LinuxUser } from "./auth.ts";
import { loadRepoDirectory } from "./repo-folder.ts";
import { callRunner, streamSiteFile, type RunnerLink } from "./runner-client.ts";

// Site previews are served on their own port, never on the app's own origin.
// A page from a user's repository folder is arbitrary HTML written by that user
// or by an agent they ran. Sharing an origin with the hub would let such a page
// call /api as whoever is looking at it, so the port stays separate and the
// preview response never carries the app's cookie.
export interface PreviewOptions {
  link: RunnerLink;
  // Read on every request rather than once at startup, so an administrator
  // turning previews off closes the port's work immediately instead of at the
  // next restart. Absent means the switch was not wired up and previews stay on.
  enabled?: () => boolean;
  reposFile?: string;
  // Whether an account may publish a page. Defaults to checking the
  // engineroom-users group, so an account that cannot sign in cannot publish
  // one either.
  mayPreview?: (username: string) => boolean;
  // Account details for the runner socket. Tests replace this; the hub uses
  // the same lookup the rest of the app does.
  lookup?: (username: string) => LinuxUser | null;
  // Port the app answers on. A request that is not a preview is sent to that
  // port on the same host, which keeps the app reachable when someone lands
  // here by mistake or follows an old link.
  appPort?: number;
}

export function createPreviewServer(options: PreviewOptions): Server {
  const enabled = options.enabled ?? (() => true);
  const mayPreview = options.mayPreview ?? ((name: string) => accountNames().has(name));
  const lookup = options.lookup ?? lookupUser;
  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "";
      if (message === "not found" || message === "server-side scripts are not run in a preview") {
        sendText(res, 404, message);
        return;
      }
      if (message === "file is too large") {
        sendText(res, 413, message);
        return;
      }
      if (message.startsWith(PREVIEW_NEEDS_SERVER)) {
        sendNeedsServer(res, message.slice(PREVIEW_NEEDS_SERVER.length));
        return;
      }
      if (!res.headersSent) sendText(res, 500, "The preview could not be read.");
      else res.destroy();
    });
  });
  return server;

  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    // A published page is a site-wide decision. When it is off the port answers
    // nothing at all, including the account index, so a link someone kept does
    // not reveal whether an account or project exists.
    if (!enabled()) {
      sendText(res, 404, "Site previews are turned off.");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      sendText(res, 405, "Previews are read-only.");
      return;
    }

    // The path is taken from the raw request line, not from a parsed URL:
    // URL() would collapse ".." and quietly turn one path into a different
    // resource. Dot segments are refused by parseSitePath instead.
    const raw = req.url || "/";
    const split = raw.indexOf("?");
    const pathname = split < 0 ? raw : raw.slice(0, split);
    const search = split < 0 ? "" : raw.slice(split);
    const url = { pathname, search };
    const segments = pathname.split("/").filter((part) => part.length > 0);
    if (segments.length === 0) {
      sendToApp(req, res, "/", "");
      return;
    }

    let username: string;
    try {
      username = decodeURIComponent(segments[0]);
    } catch {
      sendText(res, 404, "Not found.");
      return;
    }
    if (!mayPreview(username)) {
      sendToApp(req, res, url.pathname, url.search);
      return;
    }
    if (segments.length === 1) {
      // Relative links inside a site expect a directory, so keep the trailing
      // slash: ./style.css must resolve beside the page, not at the host root.
      if (!url.pathname.endsWith("/")) {
        res.writeHead(301, { Location: `${url.pathname}/${url.search}`, "Cache-Control": "no-store" });
        res.end();
        return;
      }
      await sendIndex(res, username);
      return;
    }

    // The path is validated here but sent on still encoded: the runner decodes
    // it once as it parses the request. Decoding here as well would turn a file
    // named 100%.html into an invalid escape sequence on the second pass.
    const rawSitePath = segments.slice(1).join("/");
    try {
      parseSitePath(rawSitePath);
    } catch {
      sendText(res, 404, "Not found.");
      return;
    }
    const user = lookup(username);
    if (!user) {
      sendText(res, 404, "Not found.");
      return;
    }
    const head = req.method === "HEAD";
    let redirected = false;
    await streamSiteFile(
      options.link,
      user.username,
      user.uid,
      { id: randomUUID(), type: "read_site_file", sitePath: rawSitePath },
      (meta) => {
        // A folder answered with its index.html. Moving the browser to the
        // trailing-slash URL keeps ./style.css and ../ links working, which is
        // what makes a folder of pages behave like a site.
        if (meta.directory && !url.pathname.endsWith("/")) {
          redirected = true;
          res.writeHead(301, { Location: `${url.pathname}/${url.search}`, "Cache-Control": "no-store" });
          res.end();
          return undefined;
        }
        if (redirected) return undefined;
        // A page here is edited constantly, so a browser that already holds
        // this version is told so instead of downloading it again.
        const fresh = requestMatches(req, meta.etag, meta.modified);
        res.writeHead(fresh ? 304 : 200, {
          "Content-Type": meta.type,
          ...(fresh ? {} : { "Content-Length": meta.size }),
          "Cache-Control": "no-cache",
          ETag: meta.etag,
          "Last-Modified": meta.modified,
        });
        if (fresh) {
          res.end();
          return undefined;
        }
        // HEAD stops here: the headers are out and the body is not wanted.
        if (head) {
          res.end();
          return undefined;
        }
        return res;
      },
    );
  }

  function sendToApp(req: IncomingMessage, res: ServerResponse, pathname: string, search: string) {
    const host = hostName(req);
    if (!options.appPort || !host) {
      sendText(res, 404, "Not found.");
      return;
    }
    res.writeHead(302, {
      Location: `http://${host}:${options.appPort}${pathname}${search}`,
      "Cache-Control": "no-store",
    });
    res.end();
  }

  async function sendIndex(res: ServerResponse, username: string) {
    const user = lookup(username);
    let directory = loadRepoDirectory(options.reposFile || "");
    let projects: string[] = [];
    if (user) {
      try {
        const listing = (await callRunner(options.link, user.username, user.uid, {
          id: randomUUID(),
          type: "list_site_directories",
        })) as { directory?: unknown; projects?: unknown };
        if (typeof listing?.directory === "string" && listing.directory.trim()) directory = listing.directory;
        if (Array.isArray(listing?.projects)) {
          projects = listing.projects.filter((item): item is string => typeof item === "string");
        }
      } catch {
        projects = [];
      }
    }
    const body = renderIndex(username, directory, projects);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  }
}

function renderIndex(username: string, directory: string, projects: string[]): string {
  const items = projects
    .map((name) => `      <li><a href="/${encodeURIComponent(username)}/${encodeURIComponent(name)}/">${escapeHtml(name)}</a></li>`)
    .join("\n");
  const listing = projects.length
    ? `  <ul>\n${items}\n  </ul>`
    : "  <p>No projects yet. Create one in Engineroom and it will appear here.</p>";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(username)} · site preview</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 40rem; padding: 0 1rem; line-height: 1.5; }
    code { background: #eee; padding: 0.1rem 0.3rem; border-radius: 3px; }
    li { margin: 0.25rem 0; }
  </style>
</head>
<body>
  <h1>${escapeHtml(username)} · site preview</h1>
  <p>Pages in <code>~/${escapeHtml(directory)}</code> for this account, served from their own origin. A page here cannot read an Engineroom session.</p>
${listing}
</body>
</html>
`;
}

// The hostname this request was addressed to, without its port. A Host header
// that does not name a plain host is refused rather than echoed back.
function hostName(req: IncomingMessage): string {
  const raw = req.headers.host;
  if (typeof raw !== "string" || !raw.trim()) return "";
  try {
    return new URL(`http://${raw.trim()}`).hostname;
  } catch {
    return "";
  }
}

// If-None-Match wins over If-Modified-Since, which is what every HTTP cache
// expects. Only the strong form is issued, so weak comparison is enough.
function requestMatches(req: IncomingMessage, etag: string, modified: string): boolean {
  const noneMatch = req.headers["if-none-match"];
  if (typeof noneMatch === "string" && noneMatch.trim()) {
    if (noneMatch.trim() === "*") return true;
    return noneMatch
      .split(",")
      .map((tag) => tag.trim().replace(/^W\//, ""))
      .includes(etag);
  }
  const since = req.headers["if-modified-since"];
  if (typeof since === "string" && since.trim()) {
    const then = Date.parse(since);
    const stamp = Date.parse(modified);
    if (!Number.isNaN(then) && !Number.isNaN(stamp) && stamp <= then + 999) return true;
  }
  return false;
}

// A folder that holds a server-side app is a different answer from a missing
// file, and the person reading it needs to know the folder is fine and the
// preview simply cannot run PHP. The entry name is the runner's, so it is
// escaped like any other text.
function sendNeedsServer(res: ServerResponse, entry: string) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Needs a server</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 34rem; padding: 0 1rem; line-height: 1.55; }
    code { background: #eee; padding: 0.1rem 0.3rem; border-radius: 3px; }
    ul { padding-left: 1.2rem; }
  </style>
</head>
<body>
  <h1>This project needs a server</h1>
  <p>Site previews serve static files. This folder has no <code>index.html</code>, and its entry point is <code>${escapeHtml(entry)}</code>, which has to be run rather than handed out as a file.</p>
  <p>Two ways to see it:</p>
  <ul>
    <li>Start the project's own server and open it on its port, the same way you would in a chat's terminal.</li>
    <li>If the project can build to static files, point its output at this folder as an <code>index.html</code> and the preview will serve it.</li>
  </ul>
</body>
</html>
`;
  res.writeHead(404, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, message: string) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = `<!doctype html><meta charset="utf-8"><title>${status}</title><p>${escapeHtml(message)}</p>`;
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
