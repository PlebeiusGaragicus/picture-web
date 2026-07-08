#!/usr/bin/env bash
# comic-canvas installer for macOS (arm64) and Linux (x86_64).
#
#   curl -fsSL https://raw.githubusercontent.com/PlebeiusGaragicus/comic-canvas/main/install.sh | bash
#
# Flags:
#   --version vX.Y.Z   install a specific release (default: latest)
#   --yes              skip the upgrade confirmation prompt
#
# Installs to ~/.comic-canvas/app/<version> (current + one previous kept),
# links ~/.local/bin/comic-canvas. Never touches ~/.comic-canvas/projects.
# No sudo, ever.

set -euo pipefail

REPO="PlebeiusGaragicus/comic-canvas"
HOME_DIR="${COMIC_CANVAS_HOME:-$HOME/.comic-canvas}"
APP_DIR="$HOME_DIR/app"
BIN_DIR="$HOME/.local/bin"
LAUNCHER="$BIN_DIR/comic-canvas"

VERSION=""
ASSUME_YES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --yes) ASSUME_YES=1; shift ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# --- Platform detection ------------------------------------------------------
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS/$ARCH" in
  Darwin/arm64) TARGET="macos-arm64" ;;
  Linux/x86_64) TARGET="linux-x86_64" ;;
  *) die "unsupported platform: $OS/$ARCH (supported: macOS arm64, Linux x86_64)" ;;
esac

command -v curl >/dev/null || die "curl is required"
command -v tar >/dev/null || die "tar is required"
if command -v shasum >/dev/null; then
  SHA_CMD=(shasum -a 256 -c)
elif command -v sha256sum >/dev/null; then
  SHA_CMD=(sha256sum -c)
else
  die "need shasum or sha256sum to verify the download"
fi

# --- Resolve version ---------------------------------------------------------
if [[ -z "$VERSION" ]]; then
  say "Resolving latest release..."
  VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" |
    grep -m1 '"tag_name"' | sed -E 's/.*"tag_name" *: *"([^"]+)".*/\1/')"
  [[ -n "$VERSION" ]] || die "could not resolve the latest release tag"
fi
say "Installing comic-canvas $VERSION ($TARGET)"

# --- Upgrade warning (C5: pre-1.0 schema changes are breaking) ---------------
CURRENT=""
if [[ -f "$HOME_DIR/meta.json" ]]; then
  CURRENT="$(sed -nE 's/.*"appVersion" *: *"([^"]+)".*/\1/p' "$HOME_DIR/meta.json" | head -1 || true)"
fi
if [[ -n "$CURRENT" && "v$CURRENT" != "$VERSION" && -d "$HOME_DIR/projects" ]]; then
  say ""
  say "WARNING: upgrading v$CURRENT -> $VERSION."
  say "Pre-1.0 releases may change on-disk schemas; existing projects may stop"
  say "loading. Back up first:"
  say "  cp -r $HOME_DIR/projects $HOME_DIR/projects.bak-$(date +%Y%m%d)"
  if [[ "$ASSUME_YES" -ne 1 ]]; then
    printf 'Continue? [y/N] '
    if ! read -r answer < /dev/tty 2>/dev/null; then
      echo
      die "no TTY for confirmation; re-run with --yes to accept the upgrade risk"
    fi
    [[ "$answer" == "y" || "$answer" == "Y" ]] || die "aborted"
  fi
fi

# --- Download + verify -------------------------------------------------------
TARBALL="comic-canvas-$VERSION-$TARGET.tar.gz"
# COMIC_CANVAS_BASE_URL is a test hook (point at a local server serving the assets).
BASE_URL="${COMIC_CANVAS_BASE_URL:-https://github.com/$REPO/releases/download/$VERSION}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "Downloading $TARBALL..."
curl -fSL --progress-bar -o "$TMP/$TARBALL" "$BASE_URL/$TARBALL"
curl -fsSL -o "$TMP/checksums.txt" "$BASE_URL/checksums.txt"
(cd "$TMP" && grep " $TARBALL\$" checksums.txt | "${SHA_CMD[@]}" -) ||
  die "checksum verification failed — aborting"

# --- Install -----------------------------------------------------------------
DEST="$APP_DIR/$VERSION"
say "Unpacking to $DEST..."
rm -rf "$DEST"
mkdir -p "$DEST"
tar -C "$DEST" --strip-components=1 -xzf "$TMP/$TARBALL"
[[ -x "$DEST/comic-canvas" ]] || die "archive did not contain the comic-canvas binary"

ln -sfn "$DEST" "$APP_DIR/current"

# Keep current + one previous version for manual rollback.
KEEP=2
i=0
while IFS= read -r dir; do
  [[ -n "$dir" ]] || continue
  i=$((i + 1))
  if [[ $i -gt $KEEP ]]; then
    rm -rf "${APP_DIR:?}/$dir"
  fi
done < <(
  for d in "$APP_DIR"/*/; do
    name="$(basename "$d")"
    [[ "$name" == "current" ]] && continue
    printf '%s\n' "$name"
  done | sort -rV
)

mkdir -p "$BIN_DIR"
ln -sfn "$APP_DIR/current/comic-canvas" "$LAUNCHER"

# --- PATH hint ---------------------------------------------------------------
case ":$PATH:" in
  *":$BIN_DIR:"*) PATH_OK=1 ;;
  *) PATH_OK=0 ;;
esac
if [[ "$PATH_OK" -eq 0 ]]; then
  case "${SHELL:-}" in
    */zsh) RC="\$HOME/.zshrc" ;;
    */bash) RC="\$HOME/.bashrc" ;;
    *) RC="your shell profile" ;;
  esac
  say ""
  say "NOTE: $BIN_DIR is not on your PATH. Add it in $RC:"
  say "  export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

# --- Warn-only dependency report ----------------------------------------------
say ""
say "Checking dependencies (comic-canvas uses YOUR system pi and its models):"
if command -v pi >/dev/null; then
  say "  [ok] pi: $(command -v pi) ($(pi --version 2>/dev/null || echo '?'))"
else
  say "  [!!] pi not found — comic-canvas will refuse to start until pi is installed"
  say "       (or set COMIC_CANVAS_SKIP_PI_CHECK=1 to run without agent features)"
fi
if command -v node >/dev/null; then
  say "  [ok] node: $(node --version 2>/dev/null || echo '?') (pi needs 22+)"
else
  say "  [!!] node not found — pi requires Node 22+"
fi

say ""
say "comic-canvas $VERSION installed."
say "  launch:   comic-canvas"
say "  projects: $HOME_DIR/projects   (back this up like any document folder)"
say "  doctor:   comic-canvas doctor"
