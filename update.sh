#!/bin/bash
# Update an existing Engineroom install from this checkout.
# Run as root:
#   sudo ./update.sh
#   sudo ./update.sh --no-pull
#
# Pulls the current branch, installs dependencies, runs deploy/install.sh,
# and restarts the hub and any running per-user runners. Leaves
# /etc/engineroom/hub.env and the Caddy site config alone.
# --no-pull skips the pull and installs the working tree, including
# uncommitted changes.
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd)"
cd "$root"

no_pull=0
for arg in "$@"; do
  case "$arg" in
    --no-pull) no_pull=1 ;;
    -h|--help)
      echo "usage: sudo ./update.sh [--no-pull]"
      exit 0
      ;;
    *)
      echo "unknown option: $arg" >&2
      echo "usage: sudo ./update.sh [--no-pull]" >&2
      exit 1
      ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run as root: sudo ./update.sh" >&2
  exit 1
fi

if [[ ! -d .git ]]; then
  echo "update.sh must be run from a git checkout" >&2
  exit 1
fi

if ! command -v node >/dev/null; then
  echo "Node.js 24 or newer is required. Run setup.sh first." >&2
  exit 1
fi
node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 24 )); then
  echo "Node.js 24 or newer is required (found $(node --version))" >&2
  exit 1
fi

owner="$(stat -c '%U' .git)"
if [[ "$owner" == "root" ]]; then
  echo "this checkout is owned by root; clone it as the administrator and update from there" >&2
  exit 1
fi

run_as_owner() {
  sudo -u "$owner" -H -- env PATH="/usr/local/bin:/usr/bin:${PATH}" "$@"
}

if [[ "$no_pull" -eq 1 ]]; then
  echo "Skipping git pull; installing the working tree as ${owner}..."
else
  echo "Pulling the latest commit as ${owner}..."
  run_as_owner git pull --ff-only
fi

install -d -m 0755 /etc/engineroom
if [[ ! -f /etc/engineroom/checks.json ]]; then
  cat > /etc/engineroom/checks.json <<'EOF'
{
  "commands": ["node", "git", "caddy", "agent", "claude", "claude-agent-acp", "pi", "obscura"]
}
EOF
  chmod 0644 /etc/engineroom/checks.json
fi

if [[ -d node_modules ]]; then
  chown -R "$owner" node_modules
fi
echo "Installing dependencies..."
run_as_owner npm ci
run_as_owner node --input-type=module -e 'await import("node-pty")'

bash "$root/deploy/install.sh"

echo "Restarting services..."
systemctl restart engineroom-hub.service
mapfile -t runners < <(systemctl list-units --type=service --state=active --no-legend 'engineroom-runner@*' | awk '{print $1}')
if [[ ${#runners[@]} -gt 0 ]]; then
  systemctl restart "${runners[@]}"
fi
mapfile -t failed_sockets < <(systemctl list-units --type=socket --state=failed --no-legend 'engineroom-runner@*' | awk '{print $1}')
if [[ ${#failed_sockets[@]} -gt 0 ]]; then
  failed_services=()
  for socket in "${failed_sockets[@]}"; do
    failed_services+=("${socket%.socket}.service")
  done
  systemctl reset-failed "${failed_sockets[@]}" "${failed_services[@]}"
  systemctl start "${failed_sockets[@]}"
fi

echo "Waiting for the hub..."
for _ in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:8787/api/health >/dev/null 2>&1; then
    rev="$(run_as_owner git rev-parse --short HEAD)"
    if [[ "$no_pull" -eq 1 ]]; then
      echo "Engineroom ${rev} (working tree, pull skipped) is active and the hub is responding."
    else
      echo "Engineroom ${rev} is active and the hub is responding."
    fi
    exit 0
  fi
  sleep 0.5
done

echo "the hub did not respond on 127.0.0.1:8787" >&2
exit 1
