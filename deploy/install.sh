#!/bin/bash
# Install the hub, the per-user runner, and the PAM helper.
# Run from a checkout, as root: sudo deploy/install.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run as root: sudo deploy/install.sh" >&2
  exit 1
fi

if ! command -v node >/dev/null; then
  echo "Node.js 24 or newer is required" >&2
  exit 1
fi

getent group engineroom >/dev/null || groupadd --system engineroom
getent group engineroom-users >/dev/null || groupadd engineroom-users
if ! id engineroom >/dev/null 2>&1; then
  useradd --system --gid engineroom --home-dir /var/lib/engineroom --create-home --shell /usr/sbin/nologin engineroom
fi

make -C deploy/pam
install -d -m 0755 /usr/local/libexec
install -m 0755 -o root -g root deploy/pam/engineroom-pam-auth /usr/local/libexec/engineroom-pam-auth
install -m 0755 deploy/bin/engineroom-pam-auth /usr/local/bin/engineroom-pam-auth
install -m 0755 deploy/pam/engineroom-peercred /usr/local/bin/engineroom-peercred
install -m 0755 deploy/engineroom-ctl /usr/local/bin/engineroom-ctl
install -m 0755 deploy/bin/engineroom-runner /usr/local/bin/engineroom-runner
install -m 0755 deploy/bin/engineroom-hub /usr/local/bin/engineroom-hub
install -m 0440 deploy/sudoers/engineroom /etc/sudoers.d/engineroom
visudo -cf /etc/sudoers.d/engineroom
install -m 0644 deploy/pam.d/engineroom /etc/pam.d/engineroom
install -d -m 0755 /etc/systemd/system
install -m 0644 deploy/systemd/engineroom-hub.service /etc/systemd/system/engineroom-hub.service
install -m 0644 deploy/systemd/engineroom-runner@.service /etc/systemd/system/engineroom-runner@.service
install -m 0644 deploy/systemd/engineroom-runner@.socket /etc/systemd/system/engineroom-runner@.socket

if [[ ! -d node_modules ]]; then
  npm install
fi
npm run build:web

install -d -m 0755 /usr/local/lib /usr/local/share/engineroom
rm -rf /usr/local/lib/engineroom
mkdir -p /usr/local/lib/engineroom
tar -C "$root" --exclude .git --exclude apps/web/dist -cf - . | tar -C /usr/local/lib/engineroom -xf -
rm -rf /usr/local/share/engineroom/web
cp -a apps/web/dist /usr/local/share/engineroom/web
chown -R engineroom:engineroom /var/lib/engineroom

systemctl daemon-reload
systemctl enable --now engineroom-hub.service

echo "Hub service installed. It starts at boot with: systemctl enable --now engineroom-hub.service"
