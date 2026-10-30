# Configuration

The hub reads environment variables in [`apps/hub/src/index.ts`](../apps/hub/src/index.ts). The systemd unit [`deploy/systemd/engineroom-hub.service`](../deploy/systemd/engineroom-hub.service) sets the production defaults and loads `/etc/engineroom/hub.env` (`EnvironmentFile=-`, so a missing file is ignored). Values in the unit override the file when both set the same name. `setup.sh` writes only `ENGINEROOM_COOKIE_SECURE` and `ENGINEROOM_ADMIN` into `hub.env`.

The runner reads `ENGINEROOM_HUB_USER`, `ENGINEROOM_PEERCRED`, and the systemd socket-activation variables `LISTEN_PID` and `LISTEN_FDS`.

## Hub process

| Variable | Default | Purpose |
| --- | --- | --- |
| `ENGINEROOM_LISTEN` | `127.0.0.1:8787` | `host:port` for the HTTP server. A bare port uses host `127.0.0.1`. |
| `ENGINEROOM_SESSION_SECRET_FILE` | `/var/lib/engineroom/session.secret` | HMAC key for the session cookie. Created on first start (mode `0600`) when missing or shorter than 16 bytes. |
| `ENGINEROOM_WEB_DIST` | unset | Directory of the built web UI. Unset means the hub does not serve static files. Production sets `/usr/local/share/engineroom/web`. |
| `ENGINEROOM_COOKIE_SECURE` | secure (`1`) | Set to `0` to allow the session cookie on plain HTTP. Any other value, including empty, keeps the cookie `Secure`. |
| `ENGINEROOM_ADMIN` | empty | Username of the administrator. Empty means nobody has the Admin page. |
| `ENGINEROOM_SOCKET_DIR` | `/run/engineroom` | Directory of per-user sockets, `$DIR/<username>.sock`. Must be absolute. |
| `ENGINEROOM_CTL` | `/usr/local/bin/engineroom-ctl` | Invoked as `sudo -n` to start a runner socket that is not there yet. |
| `ENGINEROOM_PAM_HELPER` | `/usr/local/bin/engineroom-pam-auth` | Password check against `/etc/pam.d/engineroom`. |
| `ENGINEROOM_ADMIN_CTL` | `/usr/local/bin/engineroom-admin` | Add, revoke, passwd, and remove accounts. |
| `ENGINEROOM_NETWORK_CTL` | `/usr/local/bin/engineroom-network` | Set the hostname advertised as `name.local`, and read or change Wi-Fi. Invoked as `sudo -n`. |
| `ENGINEROOM_PEERCRED` | `/usr/local/bin/engineroom-peercred` | Used by the hub and the runner. Not read in `index.ts`; the peercred package defaults to this path. |

## Data files

| Variable | Default | Contents |
| --- | --- | --- |
| `ENGINEROOM_AGENTS_FILE` | `/var/lib/engineroom/agents.json` | Which agents are offered, custom agents, branding, and feature flags (terminal, file manager, editor, download, upload, CLI import). |
| `ENGINEROOM_AGENT_OPTIONS_FILE` | `/var/lib/engineroom/agent-options.json` | Modes and models offered per agent. |
| `ENGINEROOM_CATALOG_FILE` | `/var/lib/engineroom/catalog.json` | Shared repository catalog. |
| `ENGINEROOM_REPOS_FILE` | `/var/lib/engineroom/repos.json` | Repository directory name under each home, and file visibility. |
| `ENGINEROOM_CHECKS_FILE` | `/etc/engineroom/checks.json` | Command names probed for the admin overview. |

Site packages are stored in `extensions/` next to `agents.json`, with `extensions.json` beside that directory. Per-user packages are `~/.engineroom/extensions/` and `~/.engineroom/extensions.json`. See [extensions.md](extensions.md).

`setup.sh` creates `checks.json` only when it is absent, with:

```json
{
  "commands": ["node", "git", "caddy", "agent", "claude", "claude-agent-acp", "pi", "obscura"]
}
```

## Runner process

| Variable | Default | Purpose |
| --- | --- | --- |
| `ENGINEROOM_HUB_USER` | `engineroom` | Unix account allowed to connect, besides the runner's own uid. |
| `ENGINEROOM_PEERCRED` | `/usr/local/bin/engineroom-peercred` | Helper that prints pid, uid, and gid for a socket fd. |
| `LISTEN_PID` | unset | Set by systemd socket activation. Used only when it equals this process id. |
| `LISTEN_FDS` | unset | When greater than 0 and `LISTEN_PID` matches, the runner listens on fd 3 instead of `--socket`. |
| `HOME` | the OS home | Home directory for chats, clones, and CLI credentials. |

`engineroom-runner --socket PATH` is the non-systemd entry. The path has to be absolute because socket paths are built as `/<socket-dir>/<username>.sock`.

## `hub.env`

`/etc/engineroom/hub.env` is the place for site-specific values that should survive updates. `update.sh` does not rewrite it. `setup.sh` does, and it only writes these two lines:

```bash
ENGINEROOM_COOKIE_SECURE=0
ENGINEROOM_ADMIN=alice
```

`ENGINEROOM_HOST` is not read by the hub. `setup.sh` uses it only to choose the Caddy site address and the cookie flag above.

`/etc/engineroom/server.json` stores the hostname chosen from the Admin Server page. `setup.sh` writes `engineroom` there when the file is missing, and does not replace it on a later run. Every setup enables Avahi, which publishes that name as `http://<hostname>.local`.

## Related

- How these paths are installed: [installation.md](installation.md)
- What the hub and runner do with them: [architecture.md](architecture.md)
