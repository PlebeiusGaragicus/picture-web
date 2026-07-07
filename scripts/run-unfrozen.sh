#!/usr/bin/env bash
# Run the comic-canvas CLI from the repo checkout (used by CI's unfrozen smoke test).
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="${PYTHON:-$ROOT_DIR/.venv/bin/python}"
if [[ ! -x "$PYTHON" ]]; then
  PYTHON="$(command -v python3)"
fi
exec "$PYTHON" "$ROOT_DIR/api/cli.py" "$@"
