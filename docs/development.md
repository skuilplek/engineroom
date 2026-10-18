# Development

The repository is an npm workspaces monorepo. Workspaces are `apps/*` and `packages/*`. Node.js 24 or newer is required (`engines` in the root [`package.json`](../package.json)).

`node-pty` compiles on `npm install`. That needs `python3`, `make`, and `g++` (on Debian/Ubuntu, `build-essential` and `python3`).

## Scripts

From the repository root:

| Command | What it does |
| --- | --- |
| `npm test` | Node's test runner on [`test/*.test.ts`](../test) |
| `npm run typecheck` | `tsc` for the root project and for `apps/web` |
| `npm run build:web` | Production build of `@engineroom/web` into `apps/web/dist` |
| `npm run dev:web` | Vite dev server on port 5173 |
| `npm run start:hub` | `node apps/hub/src/index.ts` |
| `npm run start:runner` | `node apps/runner/src/index.ts` |

Tests cover the protocol, the hub admin API, and the runner. They inject authentication and drivers, so they do not need PAM, systemd, or real agent CLIs.

## Web UI

[`apps/web/vite.config.ts`](../apps/web/vite.config.ts) proxies `/api` (including WebSocket upgrades) to `http://127.0.0.1:8787`. Start the hub first, then:

```bash
npm run dev:web
```

Open `http://127.0.0.1:5173`. Leave `ENGINEROOM_WEB_DIST` unset so the hub does not also try to serve a built UI. A request that is not under `/api` returns 404 from the hub when that variable is empty; Vite serves the pages.

`ENGINEROOM_COOKIE_SECURE` defaults to on. For plain `http://` during development set it to `0`, or the session cookie will not be stored.

## Hub without the packaged paths

`engineroom-hub` reads files under `/var/lib/engineroom` and `/etc/engineroom` unless you override them. Both the hub and the runner exit if they are started as root. Point them at a writable directory in the checkout:

```bash
root="$(pwd)/tmp/dev"
mkdir -p "$root/run" "$root/lib"
export ENGINEROOM_LISTEN=127.0.0.1:8787
export ENGINEROOM_COOKIE_SECURE=0
export ENGINEROOM_SESSION_SECRET_FILE="$root/session.secret"
export ENGINEROOM_SOCKET_DIR="$root/run"
export ENGINEROOM_AGENTS_FILE="$root/lib/agents.json"
export ENGINEROOM_AGENT_OPTIONS_FILE="$root/lib/agent-options.json"
export ENGINEROOM_CATALOG_FILE="$root/lib/catalog.json"
export ENGINEROOM_REPOS_FILE="$root/lib/repos.json"
export ENGINEROOM_CHECKS_FILE="$root/checks.json"
export ENGINEROOM_ADMIN="${USER}"
npm run start:hub
```

The hub creates `session.secret` when the file is missing or shorter than 16 bytes. Variable meanings are listed in [configuration.md](configuration.md).

Sign-in still uses the real PAM helper (`ENGINEROOM_PAM_HELPER`, default `/usr/local/bin/engineroom-pam-auth`) and `getent`. That path exists after [`deploy/install.sh`](../deploy/install.sh) on Linux. The account must be in `engineroom-users`. On a machine without those pieces, `npm test` is the way to exercise the hub.

## Runner

The runner does not listen on a TCP port. It needs a Unix socket path or a systemd socket-activation fd:

```bash
npm run start:runner -- --socket "$root/run/${USER}.sock"
```

Without `--socket`, and without `LISTEN_FDS` for this process, it prints `usage: engineroom-runner --socket PATH` and exits. The socket directory must be absolute. The hub connects to `$ENGINEROOM_SOCKET_DIR/<username>.sock`.

In production, systemd owns that socket (`engineroom-runner@<user>.socket`) and `engineroom-ctl` starts it. For a local process, start the runner yourself before the hub needs it, with `--socket` and the same directory as `ENGINEROOM_SOCKET_DIR`. If the socket file is missing, the hub runs `sudo -n "$ENGINEROOM_CTL" start <user>` (default ctl path `/usr/local/bin/engineroom-ctl`).

Both sides call `ENGINEROOM_PEERCRED` (default `/usr/local/bin/engineroom-peercred`) to read the peer uid. The hub accepts the connection when the socket is owned by the signed-in user and the peer is that user (or uid 0, which covers systemd while it still holds a socket-activated listener). The runner accepts a peer that is itself or `ENGINEROOM_HUB_USER` (default `engineroom`). A hub and runner started as the same person therefore match, as long as the peercred helper runs. That helper is Linux-only and is built from [`deploy/pam`](../deploy/pam).

## PAM and peercred helpers

[`deploy/pam/Makefile`](../deploy/pam/Makefile) builds `engineroom-pam-auth` and `engineroom-peercred`. Compile them only when you are changing those C programs. `deploy/install.sh` runs `make -C deploy/pam` and installs the binaries. The build needs PAM headers (`libpam0g-dev` on Debian/Ubuntu).

## Related

- Production install: [installation.md](installation.md)
- Process split and sockets: [architecture.md](architecture.md)
