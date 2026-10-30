#!/bin/bash
# First-time server setup. Run once as root:
#   sudo ./setup.sh
#
# After this, systemd starts the hub at boot. The hub serves the web UI.
# Opening the site and signing in with a Linux password is the whole user flow.
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd)"
cd "$root"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run as root: sudo ./setup.sh" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y build-essential python3 libpam0g-dev ca-certificates curl caddy nodejs npm avahi-daemon wpasupplicant iw

hash -r
node --version

install_obscura() {
  if [[ -x /usr/local/bin/obscura && -x /usr/local/bin/obscura-worker ]]; then
    return
  fi
  local arch asset tmp bin worker
  case "$(uname -m)" in
    x86_64) arch="x86_64" ;;
    aarch64|arm64) arch="aarch64" ;;
    *)
      echo "obscura: unsupported architecture $(uname -m)" >&2
      exit 1
      ;;
  esac
  asset="obscura-${arch}-linux.tar.gz"
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/$asset" "https://github.com/h4ckf0r0day/obscura/releases/latest/download/${asset}"
  tar -C "$tmp" -xzf "$tmp/$asset"
  bin="$(find "$tmp" -type f -name obscura -print -quit)"
  worker="$(find "$tmp" -type f -name obscura-worker -print -quit)"
  if [[ -z "$bin" || -z "$worker" ]]; then
    echo "obscura: release archive did not contain obscura and obscura-worker" >&2
    rm -rf "$tmp"
    exit 1
  fi
  install -m 0755 "$bin" /usr/local/bin/obscura
  install -m 0755 "$worker" /usr/local/bin/obscura-worker
  rm -rf "$tmp"
}

install_obscura
obscura --version

install -d -m 0755 /etc/engineroom
host="${ENGINEROOM_HOST:-}"
if [[ -n "$host" && "$host" != ":80" && "$host" != "localhost" ]]; then
  cookie_secure=1
  site="$host"
else
  cookie_secure=0
  site=":80"
fi
admin="${ENGINEROOM_ADMIN:-}"
if [[ -z "$admin" && -n "${SUDO_USER:-}" ]]; then
  sudo_uid="$(id -u "$SUDO_USER")"
  if (( sudo_uid >= 1000 )); then
    admin="$SUDO_USER"
  fi
fi
cat > /etc/engineroom/hub.env <<EOF
ENGINEROOM_COOKIE_SECURE=${cookie_secure}
ENGINEROOM_ADMIN=${admin}
EOF
chmod 0644 /etc/engineroom/hub.env

if [[ ! -f /etc/engineroom/checks.json ]]; then
  cat > /etc/engineroom/checks.json <<'EOF'
{
  "commands": ["node", "git", "caddy", "agent", "claude", "claude-agent-acp", "pi", "obscura"]
}
EOF
  chmod 0644 /etc/engineroom/checks.json
fi

bash "$root/deploy/install.sh"

if [[ ! -f /etc/engineroom/server.json ]]; then
  /usr/local/bin/engineroom-network hostname engineroom
fi
# A later setup keeps the saved hostname. Avahi still has to be running so
# that name is published as <hostname>.local.
if ! systemctl enable --now avahi-daemon; then
  echo "avahi-daemon did not start" >&2
  systemctl status avahi-daemon --no-pager >&2 || true
  exit 1
fi

if [[ -f /etc/caddy/Caddyfile ]] && ! grep -q 'engineroom' /etc/caddy/Caddyfile; then
  cp -a /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%s)"
fi
cat > /etc/caddy/Caddyfile <<EOF
# engineroom
${site} {
	reverse_proxy 127.0.0.1:8787 {
		flush_interval -1
	}
}
EOF

if [[ -n "${SUDO_USER:-}" ]]; then
  sudo_uid="$(id -u "$SUDO_USER")"
  if (( sudo_uid >= 1000 )); then
    usermod -aG engineroom-users "$SUDO_USER"
  fi
fi

systemctl daemon-reload
# Caddy is the public listener. Ubuntu's Apache package binds :80 with a
# default site, including after reboot when the unit is still enabled, and
# Caddy then exits. Disable it whenever it is installed.
if systemctl list-unit-files --no-legend 'apache2.service' 2>/dev/null | grep -q '^apache2.service'; then
  systemctl disable --now apache2
fi
if ss -ltn 'sport = :80' | awk 'NR>1 { found=1 } END { exit !found }' && ! systemctl is-active --quiet caddy; then
  echo "port 80 is in use by another program, so Caddy cannot serve Engineroom:" >&2
  ss -ltnp 'sport = :80' >&2 || true
  exit 1
fi
systemctl enable --now engineroom-hub.service
systemctl enable --now caddy
systemctl restart engineroom-hub.service
systemctl reload caddy || systemctl restart caddy
if ! systemctl is-active --quiet caddy; then
  echo "caddy did not stay running" >&2
  systemctl status caddy --no-pager >&2 || true
  exit 1
fi

if [[ "$cookie_secure" == "1" ]]; then
  url="https://${host}"
  local_note=""
else
  name="$(sed -n 's/.*"hostname"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' /etc/engineroom/server.json | head -n 1)"
  if [[ -z "$name" ]]; then
    name="$(hostname -s 2>/dev/null || hostname)"
  fi
  url="http://${name}.local/"
  local_note="On the local network that name is advertised by Avahi"
fi

cat <<EOF
Engineroom is installed and will start at boot.

The UI is served by engineroom-hub.service. Open ${url} and sign in with a
Linux username and password. Each person's chats stay in their home.
${local_note}

${admin:-The user who ran this script} is the administrator. That account can
turn agents on or off and add or revoke people from the Admin page.

Each person still signs in once to the CLIs from that account (agent, claude, pi)
so those credentials stay in their home.

Set ENGINEROOM_HOST=chat.example.com and run this script again for HTTPS.
Check the service with: systemctl status engineroom-hub
EOF
