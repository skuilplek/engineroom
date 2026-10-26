#!/bin/bash
# Install Pi for every account, or prepare one account's Pi home.
# Shared install: sudo ./agents/setup_pi.sh --global
# One account:    ./agents/setup_pi.sh [--link-shared] [--provider NAME] [--model ID]
set -euo pipefail

global=0
link_shared=0
provider=""
model=""
agents_file="${ENGINEROOM_AGENTS_FILE:-/var/lib/engineroom/agents.json}"
shared_dir="/usr/local/share/pi/agent"

usage() {
  echo "usage: setup_pi.sh [--global] [--link-shared] [--provider NAME] [--model ID]" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --global) global=1; shift ;;
    --link-shared) link_shared=1; shift ;;
    --provider)
      [[ $# -ge 2 ]] || usage
      provider="$2"
      shift 2
      ;;
    --model)
      [[ $# -ge 2 ]] || usage
      model="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done

if [[ "$global" -eq 1 && "$link_shared" -eq 1 ]]; then
  echo "--global cannot be combined with --link-shared" >&2
  exit 1
fi

valid_pi_value() {
  [[ "$1" =~ ^[A-Za-z0-9._:/-]+$ ]]
}

if [[ -n "$provider" ]] && ! valid_pi_value "$provider"; then
  echo "invalid pi provider" >&2
  exit 1
fi
if [[ -n "$model" ]] && ! valid_pi_value "$model"; then
  echo "invalid pi model" >&2
  exit 1
fi

merge_settings() {
  local file="$1"
  [[ -n "$provider" && -n "$model" ]] || return 0
  node - "$file" "$provider" "$model" <<'EOF'
const fs = require("node:fs");
const file = process.argv[2];
const provider = process.argv[3];
const model = process.argv[4];
let current = {};
try {
  current = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (!current || typeof current !== "object" || Array.isArray(current)) current = {};
current.defaultProvider = provider;
current.defaultModel = model;
fs.mkdirSync(require("node:path").dirname(file), { recursive: true });
fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
EOF
}

read_saved_model() {
  [[ -z "$provider" && -z "$model" && -f "$agents_file" ]] || return 0
  local saved
  saved="$(node - "$agents_file" <<'EOF'
const fs = require("node:fs");
let data = {};
try { data = JSON.parse(fs.readFileSync(process.argv[2], "utf8")); } catch { data = {}; }
const provider = typeof data.piProvider === "string" ? data.piProvider : "";
const model = typeof data.piModel === "string" ? data.piModel : "";
process.stdout.write(`${provider}\n${model}\n`);
EOF
)"
  provider="${saved%%$'\n'*}"
  model="${saved#*$'\n'}"
  model="${model%$'\n'}"
  if [[ -n "$provider" ]] && ! valid_pi_value "$provider"; then provider=""; fi
  if [[ -n "$model" ]] && ! valid_pi_value "$model"; then model=""; fi
}

export PATH="/usr/local/bin:/usr/bin:/bin${PATH:+:$PATH}"

if [[ "$global" -eq 1 ]]; then
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "run as root: sudo ./agents/setup_pi.sh --global" >&2
    exit 1
  fi
  if ! command -v npm >/dev/null; then
    echo "npm is required to install Pi" >&2
    exit 1
  fi
  npm install -g --ignore-scripts @earendil-works/pi-coding-agent
  install -d -m 0755 /usr/local/share/pi
  install -d -m 0755 "$shared_dir" "$shared_dir/skills" "$shared_dir/extensions" "$shared_dir/prompts" "$shared_dir/themes"
  if getent group engineroom-users >/dev/null; then
    chgrp engineroom-users "$shared_dir" "$shared_dir/skills" "$shared_dir/extensions" "$shared_dir/prompts" "$shared_dir/themes"
    chmod 2775 "$shared_dir" "$shared_dir/skills" "$shared_dir/extensions" "$shared_dir/prompts" "$shared_dir/themes"
  fi
  read_saved_model
  merge_settings "$shared_dir/settings.json"
  if [[ -f "$shared_dir/settings.json" ]]; then
    chmod 0644 "$shared_dir/settings.json"
  fi
  if [[ ! -e "$shared_dir/auth.json" ]] && getent group engineroom-users >/dev/null; then
    printf '%s\n' '{}' > "$shared_dir/auth.json"
    chgrp engineroom-users "$shared_dir/auth.json"
    chmod 0660 "$shared_dir/auth.json"
  fi
  install -d -m 0755 /etc/systemd/system/engineroom-runner@.service.d
  cat > /etc/systemd/system/engineroom-runner@.service.d/pi.conf <<'EOF'
[Service]
Environment=PI_CODING_AGENT_SESSION_DIR=%h/.pi/sessions
EOF
  systemctl daemon-reload
  mapfile -t units < <(systemctl list-units --type=service --state=active 'engineroom-runner@*' --no-legend --plain | awk '{print $1}')
  if ((${#units[@]})); then
    systemctl restart "${units[@]}"
  fi
  echo "Pi is installed for everyone. Sessions stay in each home. Choosing each person in the admin page does not remove /etc/systemd/system/engineroom-runner@.service.d/pi.conf."
  exit 0
fi

if [[ "$(id -u)" -eq 0 ]]; then
  echo "per-user Pi setup refuses to run as root" >&2
  exit 1
fi
if [[ -z "${HOME:-}" || "$HOME" == "/" ]]; then
  echo "HOME is required" >&2
  exit 1
fi

if [[ "$link_shared" -eq 1 ]]; then
  if [[ ! -d "$shared_dir" ]]; then
    echo "shared Pi is not installed. Run sudo ./agents/setup_pi.sh --global first." >&2
    exit 1
  fi
  install -d -m 0700 "$HOME/.pi/agent"
  link_name() {
    local name="$1"
    local target="$shared_dir/$name"
    local link="$HOME/.pi/agent/$name"
    if [[ "$name" != "settings.json" && ! -e "$target" ]]; then
      mkdir -p "$target"
    fi
    if [[ -L "$link" ]]; then
      return 0
    fi
    if [[ -e "$link" ]]; then
      mv "$link" "${link}.bak"
    fi
    ln -s "$target" "$link"
  }
  link_name settings.json
  link_name skills
  link_name extensions
  link_name prompts
  link_name themes
  if [[ -L "$HOME/.pi/agent/auth.json" ]]; then
    rm "$HOME/.pi/agent/auth.json"
  fi
  if [[ ! -e "$HOME/.pi/agent/auth.json" ]]; then
    printf '%s\n' '{}' > "$HOME/.pi/agent/auth.json"
    chmod 600 "$HOME/.pi/agent/auth.json"
  fi
  echo "Pi will use the shared install and this account's own login. Open the terminal and run /login in pi."
  exit 0
fi

if ! command -v npm >/dev/null; then
  echo "npm is required to install Pi" >&2
  exit 1
fi
mkdir -p "$HOME/.local"
npm install -g --prefix "$HOME/.local" --ignore-scripts @earendil-works/pi-coding-agent
merge_settings "$HOME/.pi/agent/settings.json"
if [[ -f "$HOME/.pi/agent/settings.json" ]]; then
  chmod 600 "$HOME/.pi/agent/settings.json"
fi
echo "Pi is installed for ${USER:-this account}."
