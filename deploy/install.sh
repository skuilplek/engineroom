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

if [[ -x /usr/local/bin/node ]]; then
  export PATH="/usr/local/bin:${PATH}"
fi
hash -r

if ! command -v node >/dev/null \
  || ! node -e 'const major = Number(process.versions.node.split(".")[0]); if (major < 24 || !process.features.typescript) process.exit(1);'; then
  found="not installed"
  if command -v node >/dev/null; then
    found="$(node --version)"
  fi
  echo "Node.js 24 or newer, able to execute TypeScript, is required (found ${found}). Run setup.sh." >&2
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
install -m 0755 deploy/bin/engineroom-admin /usr/local/bin/engineroom-admin
install -m 0755 deploy/bin/engineroom-network /usr/local/bin/engineroom-network
install -m 0755 deploy/bin/engineroom-runner /usr/local/bin/engineroom-runner
install -m 0755 deploy/bin/engineroom-hub /usr/local/bin/engineroom-hub
install -m 0440 deploy/sudoers/engineroom /etc/sudoers.d/engineroom
visudo -cf /etc/sudoers.d/engineroom
install -m 0644 deploy/pam.d/engineroom /etc/pam.d/engineroom
install -d -m 0755 /etc/systemd/system
install -m 0644 deploy/systemd/engineroom-hub.service /etc/systemd/system/engineroom-hub.service
install -m 0644 deploy/systemd/engineroom-runner@.service /etc/systemd/system/engineroom-runner@.service
install -m 0644 deploy/systemd/engineroom-runner@.socket /etc/systemd/system/engineroom-runner@.socket

# Vite's launcher imports ../dist/node/cli.js. That resolves only when
# node_modules/.bin/vite is a symlink into the vite package. A copied
# launcher looks for node_modules/dist/node/cli.js and the build fails.
# node-pty is compiled for one Node ABI. Loading a binary built by the
# distro Node segfaults, so compare the ABI stamped into pty.node instead
# of importing the module.
node_pty_built_for_this_node() {
  node --input-type=module <<'EOF'
import { readFileSync } from "node:fs";

const abi = process.versions.modules;
let binary;
try {
  binary = readFileSync("node_modules/node-pty/build/Release/pty.node");
} catch {
  process.exit(1);
}
const tagged = binary.toString("latin1").match(/node_register_module_v(\d+)/);
if (tagged) process.exit(tagged[1] === abi ? 0 : 1);

let gypi;
try {
  gypi = readFileSync("node_modules/node-pty/build/config.gypi", "utf8");
} catch {
  process.exit(1);
}
const fromGypi = gypi.match(/["']node_module_version["']\s*:\s*["']?(\d+)/);
process.exit(fromGypi && fromGypi[1] === abi ? 0 : 1);
EOF
}
if [[ ! -L node_modules/.bin/vite ]] || ! node_pty_built_for_this_node; then
  owner="$(stat -c '%U' "$root")"
  if [[ -d node_modules && "$(id -u)" -eq 0 && "$owner" != "root" ]]; then
    chown -R "$owner" node_modules
  fi
  if [[ "$(id -u)" -eq 0 && "$owner" != "root" ]]; then
    sudo -u "$owner" -H -- env PATH="/usr/local/bin:/usr/bin:${PATH}" npm ci
  else
    npm ci
  fi
fi
node --input-type=module -e 'await import("node-pty")'
npm run build:web

install -d -m 0755 /usr/local/lib /usr/local/share/engineroom
rm -rf /usr/local/lib/engineroom
mkdir -p /usr/local/lib/engineroom
tar -C "$root" --exclude .git --exclude .engineroom --exclude apps/web/dist -cf - . | tar -C /usr/local/lib/engineroom -xf -
# A checkout created with a private umask leaves source mode 600. Runners
# execute this tree as ordinary users and exit if they cannot read it.
chmod -R a+rX /usr/local/lib/engineroom
rm -rf /usr/local/share/engineroom/web
cp -a apps/web/dist /usr/local/share/engineroom/web
chown -R engineroom:engineroom /var/lib/engineroom

systemctl daemon-reload
systemctl enable --now engineroom-hub.service

echo "Hub service installed. It starts at boot with: systemctl enable --now engineroom-hub.service"
echo "node-pty compiles during npm ci and needs python3, make, and g++."
echo "Cursor chats use 'agent acp'."
