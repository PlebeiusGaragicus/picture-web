#!/usr/bin/env bash
# Build a comic-canvas release tarball for the current platform.
#
#   scripts/build-release.sh [--skip-web] [--skip-smoke]
#
# Produces dist-release/comic-canvas-<version>-<os>-<arch>.tar.gz

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SKIP_WEB=0
SKIP_SMOKE=0
for arg in "$@"; do
  case "$arg" in
    --skip-web) SKIP_WEB=1 ;;
    --skip-smoke) SKIP_SMOKE=1 ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

PYTHON="${PYTHON:-$ROOT_DIR/.venv/bin/python}"
if [[ ! -x "$PYTHON" ]]; then
  PYTHON="$(command -v python3)"
fi

VERSION="$("$PYTHON" -c "import sys; sys.path.insert(0, 'api'); from version import APP_VERSION; print(APP_VERSION)")"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$OS" in
  darwin) OS_NAME="macos" ;;
  linux) OS_NAME="linux" ;;
  *) echo "Unsupported OS: $OS" >&2; exit 2 ;;
esac
ARCH="$(uname -m)"
case "$ARCH" in
  arm64|aarch64) ARCH_NAME="arm64" ;;
  x86_64) ARCH_NAME="x86_64" ;;
  *) echo "Unsupported arch: $ARCH" >&2; exit 2 ;;
esac
TARBALL="comic-canvas-v${VERSION}-${OS_NAME}-${ARCH_NAME}.tar.gz"

echo "==> Building comic-canvas v${VERSION} for ${OS_NAME}-${ARCH_NAME}"

if [[ "$SKIP_WEB" -eq 0 ]]; then
  echo "==> Building web UI"
  (cd webui && npm install --no-audit --no-fund && npm run build)
fi

echo "==> Freezing with PyInstaller"
"$PYTHON" -m PyInstaller --noconfirm --clean --distpath dist-release/build packaging/comic-canvas.spec

APP_DIR="dist-release/build/comic-canvas"
BIN="$APP_DIR/comic-canvas"
[[ -x "$BIN" ]] || { echo "Frozen binary missing at $BIN" >&2; exit 1; }

if [[ "$SKIP_SMOKE" -eq 0 ]]; then
  echo "==> Smoke-testing the frozen build"
  scripts/smoke-frozen.sh "$BIN"
fi

echo "==> Creating $TARBALL"
mkdir -p dist-release
tar -C dist-release/build -czf "dist-release/$TARBALL" comic-canvas
(cd dist-release && shasum -a 256 "$TARBALL" | tee "$TARBALL.sha256")

echo "==> Done: dist-release/$TARBALL"
