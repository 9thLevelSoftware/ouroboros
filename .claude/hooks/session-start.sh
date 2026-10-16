#!/bin/bash
# Cloud sessions only: install the pinned Node and both npm trees so typecheck and portable tests run.
# Local Windows/WSL machines are left alone (the repo rules forbid implicit host changes).
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "$CLAUDE_PROJECT_DIR"

node_version=$(tr -d '[:space:]' < .node-version)
export NVM_DIR="${NVM_DIR:-/opt/nvm}"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  echo "session-start: nvm not found at $NVM_DIR; Node $node_version not installed" >&2
  exit 0
fi
set +u; . "$NVM_DIR/nvm.sh"; nvm install "$node_version" >/dev/null; nvm use "$node_version" >/dev/null; set -u
node_bin=$(dirname "$(nvm which "$node_version")")
[ -n "${CLAUDE_ENV_FILE:-}" ] && echo "export PATH=\"$node_bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"

# npm ci only when the lockfile changed since the last install, so a cached container starts fast.
install() {
  local dir=$1 sum stamp
  sum=$(sha256sum "$dir/package-lock.json" | cut -d' ' -f1)
  stamp="$dir/node_modules/.ouroboros-lock.sha256"
  [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$sum" ] && return 0
  (cd "$dir" && npm ci --no-audit --no-fund)
  echo "$sum" > "$stamp"
}
install .
install adapters/claude   # Linux node_modules built here, never copied from Windows
