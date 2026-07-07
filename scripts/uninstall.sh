#!/usr/bin/env bash
# Remove the comic-canvas application (never your projects).
#   curl -fsSL https://raw.githubusercontent.com/PlebeiusGaragicus/picture-web/main/scripts/uninstall.sh | bash

set -euo pipefail

HOME_DIR="${COMIC_CANVAS_HOME:-$HOME/.comic-canvas}"
APP_DIR="$HOME_DIR/app"
LAUNCHER="$HOME/.local/bin/comic-canvas"

echo "Removing comic-canvas application (projects are kept)."
[[ -L "$LAUNCHER" || -f "$LAUNCHER" ]] && rm -f "$LAUNCHER" && echo "  removed $LAUNCHER"
[[ -d "$APP_DIR" ]] && rm -rf "$APP_DIR" && echo "  removed $APP_DIR"
echo "Done. Your projects remain at $HOME_DIR/projects."
echo "Remove everything (including projects) with: rm -rf $HOME_DIR"
