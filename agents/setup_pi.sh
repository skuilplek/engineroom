#!/bin/bash
# Install Pi for one account: ./agents/setup_pi.sh [--provider NAME] [--model ID]
set -euo pipefail

provider=""
model=""
agents_file="${ENGINEROOM_AGENTS_FILE:-/var/lib/engineroom/agents.json}"

usage() {
  echo "usage: setup_pi.sh [--provider NAME] [--model ID]" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
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

if [[ "$(id -u)" -eq 0 ]]; then
  echo "per-user Pi setup refuses to run as root" >&2
  exit 1
fi
if [[ -z "${HOME:-}" || "$HOME" == "/" ]]; then
  echo "HOME is required" >&2
  exit 1
fi

if ! command -v npm >/dev/null; then
  echo "npm is required to install Pi" >&2
  exit 1
fi
read_saved_model
mkdir -p "$HOME/.local"
npm install -g --prefix "$HOME/.local" --ignore-scripts @earendil-works/pi-coding-agent
merge_settings "$HOME/.pi/agent/settings.json"
if [[ -f "$HOME/.pi/agent/settings.json" ]]; then
  chmod 600 "$HOME/.pi/agent/settings.json"
fi
echo "Pi is installed for ${USER:-this account}."
