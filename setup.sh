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
apt-get install -y build-essential libpam0g-dev ca-certificates curl xz-utils caddy

install_node() {
  local current=""
  if [[ -x /usr/local/bin/node ]]; then
    current="$(/usr/local/bin/node -p 'process.versions.node.split(".")[0]')"
  elif [[ -x /usr/bin/node ]]; then
    current="$(/usr/bin/node -p 'process.versions.node.split(".")[0]')"
  fi
  if [[ -n "$current" && "$current" -ge 24 ]]; then
    return
  fi
  local tmp file
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/SHASUMS256.txt" https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt
  file="$(awk '{print $2}' "$tmp/SHASUMS256.txt" | grep -E '^node-v24\..*-linux-x64\.tar\.xz$' | head -1)"
  grep -F "  ${file}" "$tmp/SHASUMS256.txt" > "$tmp/check"
  curl -fsSL -o "$tmp/$file" "https://nodejs.org/dist/latest-v24.x/$file"
  (cd "$tmp" && sha256sum -c check)
  tar -C /usr/local --strip-components=1 -xJf "$tmp/$file"
  rm -rf "$tmp"
  hash -r
}

install_node
node --version

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

bash "$root/deploy/install.sh"

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
systemctl enable --now engineroom-hub.service
systemctl enable --now caddy
systemctl restart engineroom-hub.service
systemctl reload caddy || systemctl restart caddy

if [[ "$cookie_secure" == "1" ]]; then
  url="https://${host}"
else
  url="http://$(hostname -f 2>/dev/null || hostname)/"
fi

cat <<EOF
Engineroom is installed and will start at boot.

The UI is served by engineroom-hub.service. Open ${url} and sign in with a
Linux username and password. Each person's chats stay in their home.

${admin:-The user who ran this script} is the administrator. That account can
turn agents on or off and add or revoke people from the Admin page.

Each person still signs in once to the CLIs from that account (agent, claude, pi)
so those credentials stay in their home.

Set ENGINEROOM_HOST=chat.example.com and run this script again for HTTPS.
Check the service with: systemctl status engineroom-hub
EOF
