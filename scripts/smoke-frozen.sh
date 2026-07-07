#!/usr/bin/env bash
# Smoke-test a comic-canvas binary (frozen or not) against a scratch home:
# boots the server, exercises auth, static UI, project CRUD, and PDF export.
#
#   scripts/smoke-frozen.sh <path-to-comic-canvas-binary>

set -euo pipefail

BIN="${1:?usage: smoke-frozen.sh <comic-canvas-binary>}"
PORT=8901
SCRATCH="$(mktemp -d)"
SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -INT "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

fail() { echo "SMOKE FAIL: $1" >&2; exit 1; }

echo "  scratch home: $SCRATCH"
COMIC_CANVAS_HOME="$SCRATCH" COMIC_CANVAS_SKIP_PI_CHECK=1 \
  "$BIN" start --no-browser --port "$PORT" >"$SCRATCH/server.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then break; fi
  kill -0 "$SERVER_PID" 2>/dev/null || { cat "$SCRATCH/server.log" >&2; fail "server died on startup"; }
  sleep 0.3
done
curl -sf "http://127.0.0.1:$PORT/api/health" | grep -q '"status":"ok"' || fail "health check"

TOKEN="$(python3 -c "import json;print(json.load(open('$SCRATCH/config.json'))['authToken'])")"
AUTH=(-H "Authorization: Bearer $TOKEN")

# Auth enforcement
[[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/projects")" == 401 ]] || fail "expected 401 without token"
[[ "$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "http://127.0.0.1:$PORT/api/projects")" == 200 ]] || fail "expected 200 with token"
[[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example.com' "http://127.0.0.1:$PORT/api/health")" == 403 ]] || fail "expected 403 for bad host"

# Cookie bootstrap
curl -s -o /dev/null -D "$SCRATCH/headers" "http://127.0.0.1:$PORT/?token=$TOKEN" || fail "bootstrap request"
grep -qi "set-cookie: comic_canvas_token" "$SCRATCH/headers" || fail "bootstrap did not set cookie"

# Static UI
curl -sf "http://127.0.0.1:$PORT/" | grep -qi "<!doctype html>" || fail "index.html not served"

# Project CRUD + generation-adjacent surfaces
curl -sf "${AUTH[@]}" -X POST -H 'Content-Type: application/json' \
  -d '{"slug":"smoke","name":"Smoke"}' "http://127.0.0.1:$PORT/api/projects" >/dev/null || fail "create project"
curl -sf "${AUTH[@]}" "http://127.0.0.1:$PORT/api/projects/smoke" | grep -q '"slug":"smoke"' || fail "read project"

# Booklet PDF (exercises reportlab + font data inside the frozen bundle)
PDF_CODE="$(curl -s -o "$SCRATCH/booklet.pdf" -w '%{http_code}' "${AUTH[@]}" \
  "http://127.0.0.1:$PORT/api/projects/smoke/story-panels/print/booklet.pdf")"
[[ "$PDF_CODE" == 200 ]] || fail "booklet PDF returned $PDF_CODE"
head -c4 "$SCRATCH/booklet.pdf" | grep -q "%PDF" || fail "booklet is not a PDF"

# Settings surface (exercises preflight inside the frozen bundle)
curl -sf "${AUTH[@]}" "http://127.0.0.1:$PORT/api/settings" | grep -q '"appVersion"' || fail "settings endpoint"

echo "  smoke test passed"
