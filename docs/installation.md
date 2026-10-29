# Installation

Production install is scripted. [`setup.sh`](../setup.sh) prepares a Debian or Ubuntu host and then calls [`deploy/install.sh`](../deploy/install.sh). [`update.sh`](../update.sh) refreshes an existing checkout. The scripts are the source of truth; this page describes what they do and what to do afterward.

The hub listens on `127.0.0.1:8787`. Caddy is the public reverse proxy. Both `engineroom-hub` and `engineroom-runner` refuse to run as root.

## First install

From a git checkout, as root:

```bash
sudo ./setup.sh
```

`setup.sh` does the following:

1. Installs `build-essential`, `python3`, `libpam0g-dev`, `curl`, `xz-utils`, Caddy, `avahi-daemon`, `wpasupplicant`, and `iw`.
2. Installs Node.js 24 under `/usr/local` when the current `node` is older than 24 (linux-x64 tarball from nodejs.org).
3. Writes `/etc/engineroom/hub.env` with `ENGINEROOM_COOKIE_SECURE` and `ENGINEROOM_ADMIN`.
4. Writes `/etc/engineroom/checks.json` if it is missing. That file lists commands the overview page probes (`node`, `git`, `caddy`, `agent`, `claude`, `claude-agent-acp`, `pi`, `obscura`).
5. Runs `deploy/install.sh`.
6. Replaces `/etc/caddy/Caddyfile` with a reverse proxy to the hub. An existing Caddyfile that does not already mention `engineroom` is copied aside first.
7. Adds the user who invoked `sudo` to the `engineroom-users` group when that account has uid 1000 or higher.
8. Enables and starts `engineroom-hub.service` and Caddy.

### Hostname and cookies

| `ENGINEROOM_HOST` | Caddy site | `ENGINEROOM_COOKIE_SECURE` |
| --- | --- | --- |
| unset, `localhost`, or `:80` | `:80` (HTTP) | `0` |
| any other hostname | that hostname (Caddy HTTPS) | `1` |

On a first install, when `/etc/engineroom/server.json` is missing, setup sets the system hostname to `engineroom` and starts Avahi. Other computers can then open `http://engineroom.local`, the same way a Raspberry Pi answers to `raspberrypi.local`. A later setup leaves a saved name in place. The default Caddy site is `:80`, so that address reaches the login page. A public `ENGINEROOM_HOST` still uses HTTPS, and the session cookie is only sent there.

The Admin Server page changes this name. It also joins a Wi-Fi network when a wireless card is present. An install from before those packages were added needs `avahi-daemon`, `wpasupplicant`, and `iw`.

```bash
sudo ENGINEROOM_HOST=chat.example.com ./setup.sh
```

Set `ENGINEROOM_ADMIN` before setup when the administrator should be someone other than the `sudo` user:

```bash
sudo ENGINEROOM_ADMIN=alice ENGINEROOM_HOST=chat.example.com ./setup.sh
```

Running `setup.sh` again rewrites `/etc/engineroom/hub.env` and the Caddyfile. Use [`update.sh`](../update.sh) when you only want a new build.

## What `deploy/install.sh` installs

Run this only as root, from a checkout, when Node and the build tools are already present:

```bash
sudo deploy/install.sh
```

It creates:

- System user and group `engineroom`, home `/var/lib/engineroom`
- Group `engineroom-users` (membership is required to sign in)
- PAM stack `/etc/pam.d/engineroom` and helpers under `/usr/local/bin` and `/usr/local/libexec`
- `engineroom-ctl`, `engineroom-admin`, `engineroom-network`, `engineroom-hub`, `engineroom-runner`
- sudoers drop-in `/etc/sudoers.d/engineroom`
- systemd units for the hub and the per-user runner socket
- Application tree at `/usr/local/lib/engineroom`
- Built web UI at `/usr/local/share/engineroom/web`

`npm install` runs when `node_modules` is missing. `npm run build:web` always runs. The hub unit is enabled and started.

## Updates

From the same git checkout, as root:

```bash
sudo ./update.sh
```

The checkout must not be owned by root. The script pulls with `--ff-only` as the directory owner, runs `npm ci`, runs `deploy/install.sh`, restarts `engineroom-hub.service`, and restarts any active `engineroom-runner@*` services. It leaves `/etc/engineroom/hub.env` and the Caddy site config alone. It writes `/etc/engineroom/checks.json` only when that file is missing.

Success is a health check against `http://127.0.0.1:8787/api/health`.

## After install

Sign-in is allowed for accounts that belong to `engineroom-users`, have uid 500 or higher, and do not use `nologin`, `false`, or `sync` as a shell. Add someone to the group:

```bash
sudo usermod -aG engineroom-users alice
```

The hub starts that person's runner by calling `engineroom-ctl`. You can do the same by hand:

```bash
sudo engineroom-ctl start alice
sudo engineroom-ctl stop alice
systemctl status engineroom-hub
systemctl status engineroom-runner@alice.socket
```

`engineroom-ctl` refuses system accounts (uid below 1000) and accounts that are not in `engineroom-users`. The runner listens on `/run/engineroom/<user>.sock`.

The administrator named by `ENGINEROOM_ADMIN` in `/etc/engineroom/hub.env` can, from the Admin page:

- Turn built-in agents on or off, add custom agent commands, and limit modes and models
- Turn the raw terminal, file manager, file editor, and CLI session import on or off
- Maintain the repository catalog and the folder under each home where clones land
- Add, revoke, remove, or set passwords for accounts, and set per-user grants, environment, and policy
- Set the network name advertised as `<name>.local`, and connect Wi-Fi when a wireless card is present

Agent CLIs are not logged in by Engineroom. Each person signs in to `agent`, `claude`, and `pi` from their own account. Cursor chats use `agent acp`. Claude uses `claude-agent-acp` when it is on `PATH`; otherwise the runner falls back to `claude -p`.

## Reverse proxy

[`deploy/Caddyfile`](../deploy/Caddyfile) is the template. `setup.sh` writes the same shape into `/etc/caddy/Caddyfile`:

```caddy
chat.example.com {
	reverse_proxy 127.0.0.1:8787 {
		flush_interval -1
	}
}
```

`flush_interval -1` keeps chat and terminal streams from being buffered. Put any other public listener in front of `127.0.0.1:8787` the same way: proxy HTTP and WebSocket upgrades for `/api/ws`, and do not buffer streaming responses.

## Related

- Environment variables and on-disk paths: [configuration.md](configuration.md)
- How the hub reaches a runner: [architecture.md](architecture.md)
