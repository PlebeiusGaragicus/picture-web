# Comic Canvas — Packaging & Distribution Plan (macOS + Linux)

> **Status: IMPLEMENTED (2026-07-07).** All workstreams landed: `api/paths.py`
> / `app_config.py` / `appmain.py` / `cli.py` / `preflight.py` /
> `routes/settings.py`, cookie-token auth, `~/.comic-canvas` home (data
> moved), PyInstaller spec + `scripts/build-release.sh` +
> `scripts/smoke-frozen.sh`, `install.sh` / `scripts/uninstall.sh`, CI +
> release workflows, README/ARCHITECTURE updates, `docs/release-checklist.md`.
> Deltas from the plan below: auth is **cookie-based** (set via `/?token=` →
> 302, `SameSite=Strict`) instead of header-based, because asset images load
> via plain `<img src="/api/...">`; auth activates only when a token is
> configured so dev/tests are untouched; the Gemini key lives in
> chmod-600 `config.json` (no keychain); `PHOTO_WEB_TOKEN` carries the token
> to the pi extension's callbacks. The first release still needs a `v0.1.0`
> tag pushed to exercise the release workflow.

How to take photo-web from "clone the repo and run `./run`" to an installable
app named **comic-canvas**, distributed from GitHub Releases via a
`curl … | bash` installer, storing all user data in `~/.comic-canvas/`, and
piggybacking on the **system-installed pi agent** for all AI-agent features.

This supersedes the earlier general survey. Sections 1–3 set the target,
Section 4 lists the design decisions to settle **before** implementation,
Section 5 is the step-by-step implementation plan, and Sections 6–9 cover
versioning, release engineering, testing, and risks.

---

## 1. Constraints locked in (from product owner)

| # | Constraint | Consequence |
|---|-----------|-------------|
| C1 | macOS + Linux only | No Windows work anywhere (no WebView2, no MSI, no Authenticode). |
| C2 | Distributed from GitHub Releases, installed with `curl … \| bash` | No app store, **no notarization/signing treadmill** (see 3.4), no auto-update framework — the installer *is* the updater. |
| C3 | User data lives in `~/.comic-canvas/` (rename from `photo-library/`) | Library-root plumbing + product-level rename of env vars/branding. |
| C4 | **System pi agent** is used — not bundled. Warn and block when missing | Users bring their own pi config/models (local or API); we pin a minimum version and verify at startup. No Node/pi vendoring. |
| C5 | Breaking schema changes are acceptable pre-1.0; **no migration machinery**. Users know a new version may strand old projects | We only *stamp and warn*, never migrate. Installer prints a loud warning on upgrade. |

## 2. How these constraints reshape the earlier recommendation

The earlier report recommended a Tauri/pywebview desktop bundle. The new
constraints make something simpler both possible and better:

- **`curl | bash` implies a CLI-launched app.** The natural shape is a
  `comic-canvas` command that starts the single-process server and opens the
  UI. That means:
  - **The PATH problem disappears.** A terminal-launched process inherits the
    user's shell PATH, so `pi`, `node`, and the user's own pi model config
    resolve exactly as they do in their terminal. (A Finder-launched `.app`
    would *not* — this was the biggest pi-integration risk in the previous
    plan, and C4 makes avoiding it doubly valuable.)
  - **No webview needed for v1.** Opening the user's default browser
    (`open` / `xdg-open`) removes the WebKitGTK-on-Linux risk entirely and
    keeps Linux dependency-free. A native window (pywebview) can be layered
    on later behind a flag without changing anything underneath (see D1).
- **No Gatekeeper ceremony.** Files downloaded by `curl` do not get the
  `com.apple.quarantine` attribute, so an unsigned/un-notarized binary runs.
  (PyInstaller ad-hoc-signs arm64 Mach-Os automatically, which macOS on
  Apple Silicon requires; that's sufficient.) This deletes the highest-risk
  item from the old plan.
- **Frozen Python remains the core deliverable.** PyInstaller **onedir**
  tarballs per platform, published as GitHub Release assets, unpacked by the
  installer. Users never see Python, venvs, or npm.
- **pi stays external by design** (C4). The app's job is discovery,
  version-gating, and a great "pi is missing/too old" experience — not
  bundling.

Everything from the old "Phase 0" (single process, static UI serving,
port/token, lifecycle, logging) still applies and is folded into Section 5.

## 3. Target architecture

### 3.1 Runtime shape

```text
$ comic-canvas                    # or: comic-canvas start / open / doctor / ...
   │
   ├─ acquires single-instance lock (~/.comic-canvas/run/lock)
   ├─ starts frozen FastAPI backend (uvicorn, programmatic, one worker)
   │     ├─ serves built React UI at /            (webui dist bundled in app)
   │     ├─ serves REST + SSE at /api             (token-guarded)
   │     ├─ reads/writes ~/.comic-canvas/projects/…
   │     ├─ spawns system `pi --mode rpc` per task step (unchanged runtime)
   │     └─ calls Gemini with the stored GOOGLE_API_KEY
   └─ opens http://127.0.0.1:<port>/?token=<t> in the default browser
```

### 3.2 On-disk layout

```text
~/.comic-canvas/
  app/
    <version>/                    # unpacked PyInstaller onedir + web dist + pi extension
      comic-canvas-server         # frozen entrypoint
      _internal/…                 # CPython + site-packages
      web/…                       # vite build output
      pi/photo-web.ts             # agent extension (absolute path passed to pi)
      prompt_guides/…             # task-profile prompt resources
    current -> <version>/         # symlink flipped atomically by installer
  projects/<slug>/…               # the former photo-library/projects (layout unchanged)
  config.json                     # chmod 600: gemini key, pi overrides, port, prefs
  meta.json                       # appVersion stamp for C5 warnings
  run/                            # lock file, port file, pid
  logs/comic-canvas.log           # rotating server log

~/.local/bin/comic-canvas         # launcher symlink -> app/current/comic-canvas-server
```

One tree, one uninstall (`rm -rf ~/.comic-canvas ~/.local/bin/comic-canvas`),
one thing to back up (with the documented caveat that `app/` is
re-downloadable — "back up `~/.comic-canvas/projects`" is the user guidance).

### 3.3 What stays exactly as-is

- The whole backend module map, the pi runtime (`PiSessionManager`, one
  `pi --mode rpc` subprocess per step, SSE ring buffer, snapshots), the
  storage layout *under* `projects/`, the tools-as-API extension mechanism
  (`PHOTO_WEB_API` origin env already makes the extension
  location-independent), and the dev workflow (`./run`, Vite, pytest,
  Playwright). Packaging is additive; dev mode is untouched.

### 3.4 macOS signing note (for the record)

curl-fetched binaries dodge quarantine **only when fetched by curl**. If a
user downloads the tarball with a browser instead, Gatekeeper will block it;
the README should say "use the installer" and offer
`xattr -dr com.apple.quarantine ~/.comic-canvas/app` as the escape hatch.
Real Developer ID signing is deferred until the project matures (tracked in
Section 9).

---

## 4. Design decisions to settle before implementation

Each has a recommendation; none blocks the others except where noted.

### D1. Launch surface: browser vs native window
- **(a) Default browser** (recommended): zero extra dependencies, zero Linux
  webview risk, PDF download / file upload behave like today, DevTools free.
  Costs: lives in a tab; closing the tab doesn't stop the server (see D10).
- **(b) pywebview window**: more app-like, but adds WebKitGTK system deps on
  Linux, needs download interception for PDF export, and reintroduces the
  Finder-PATH problem if ever launched outside a terminal.
- **Recommendation:** (a) for v1; design nothing that precludes adding
  `comic-canvas --window` later.

### D2. Layout of `~/.comic-canvas/`
- **(a) Everything under it** — app + projects + config + logs (recommended,
  as in 3.2): single mental model, single uninstall.
- **(b) Data-only `~/.comic-canvas/`, app in `~/.local/share/comic-canvas`**:
  XDG-purist, backup-friendly, but two locations to explain.
- **Recommendation:** (a). Document "your projects are
  `~/.comic-canvas/projects`" for backups.
- **Sub-decision:** projects sit at `~/.comic-canvas/projects/<slug>`
  directly (no intermediate `library/` dir). The former
  `photo-library/.env` disappears into `config.json`.

### D3. Rename scope: photo-web → comic-canvas
- The data dir *must* rename (C3). Decide how far the rest goes:
  env vars (`PHOTO_WEB_LIBRARY_ROOT` → `COMIC_CANVAS_HOME`,
  `PHOTO_WEB_API`/`PHOTO_WEB_*` task envs), the pi extension name
  (`photo-web.ts`), API window title, repo name, docs.
- **Recommendation:** rename user-facing things now (binary name, data dir,
  docs, window title, `COMIC_CANVAS_HOME`) while it's cheap (C5 covers the
  breakage); leave *internal* identifiers (`PHOTO_WEB_API` env consumed by
  the extension, module names) alone in the first packaging release to keep
  the diff reviewable, and sweep them in a follow-up rename commit. Decide
  before WS2 lands either way — renaming twice is the only wrong answer.

### D4. pi policy: how hard is the block?
C4 says warn and block. Decide *where* the block bites:
- **(a) Startup gate** (recommended): `comic-canvas` runs a preflight
  (`pi` on PATH → `pi --version` ≥ minimum → `node` ≥ 22). On failure it
  prints a diagnosis + install instructions and **exits non-zero**. The
  installer runs the same preflight and warns (but installs anyway, so
  install order doesn't matter).
- **(b) Feature gate**: app runs; Agent/extract/draft buttons are disabled
  with a banner. Friendlier, but contradicts the product pitch (agent
  features are woven through Characters/Locations/Concept Art/Story) and
  the owner's stated preference.
- **Recommendation:** (a), with `COMIC_CANVAS_SKIP_PI_CHECK=1` as a
  documented escape hatch (useful for dev, tests, and canvas-only users —
  the API layer already fails pi-less tasks with clear errors, so nothing
  crashes). Revisit toward (b) if real users push back.

### D5. Minimum pi version and RPC-protocol pinning
We depend on `pi --mode rpc` semantics, the `abort` command, session-file
`.jsonl` format (parsed by `pi_session_trace.py`), and `--extension` loading.
- Decide the minimum supported pi version (whatever is verified today) and
  encode it as `MIN_PI_VERSION` checked in the D4 preflight.
- Decide the policy for *newer* pi: allow and hope (recommended pre-1.0;
  print the detected version in `comic-canvas doctor`), vs. allow-list.
- **Also decide:** does preflight do a live handshake (spawn
  `pi --mode rpc`, exchange one message, kill) or just version-string
  checks? **Recommendation:** version check at startup; full handshake only
  in `comic-canvas doctor` (it's slower and touches the user's pi config).

### D6. pi model configuration: whose problem?
C4's point is that users bring their own models (local or API) via their own
pi setup. Decide how much comic-canvas surfaces:
- **Recommendation:** comic-canvas does **not** manage pi auth/models at
  all. It documents "configure pi however you like; comic-canvas uses your
  defaults", and `comic-canvas doctor` prints resolved pi binary, version,
  node version, and (if cheaply obtainable) the default model pi reports.
  One optional config key `piBinary` in `config.json` overrides discovery
  for people with multiple pis. Nothing else — every knob we add here we
  have to keep working.

### D7. Python freeze method and build baseline
- **Recommendation:** PyInstaller **onedir** (not onefile — slow-start,
  temp-extraction). Alternatives (python-build-standalone tree, Briefcase)
  remain fallbacks if PyInstaller misbehaves, but the dependency set
  (fastapi/uvicorn/google-genai/Pillow/reportlab) is known-good.
- **Linux glibc baseline:** PyInstaller output requires glibc ≥ build
  machine's. Build on **ubuntu-22.04** (glibc 2.35) to cover everything
  modern; document "no musl/Alpine". Decide whether that baseline is
  acceptable — the alternative (manylinux containers) costs build
  complexity.
- **Pin CPython 3.12** for release builds (dev machines already run 3.14;
  release pins matter more than dev). Decide 3.12 vs 3.13 once, in CI.

### D8. Platform matrix
- **Recommendation:** `macos-arm64`, `linux-x86_64` at launch.
  `macos-x86_64` (Intel) and `linux-arm64` only if someone asks — each is
  +1 CI lane and +1 artifact to test. The installer detects
  `uname -s`/`uname -m` and errors clearly on unsupported combos.

### D9. Port & token strategy (browser mode)
- **Recommendation:** default port **8787**, auto-increment if busy, final
  port written to `~/.comic-canvas/run/port`. Random ports annoy
  bookmark/tab-restore users in browser mode.
- Token: generated per launch, appended once as `?token=…`; the UI moves it
  to `sessionStorage` and strips the URL; every `/api` call sends
  `Authorization: Bearer`. Backend also rejects non-loopback `Host`/`Origin`.
  Decide whether the token persists across restarts (per-launch is safer;
  per-install is friendlier to restored tabs — **recommendation:
  per-install**, stored in `config.json` chmod 600; loopback + Origin checks
  carry most of the weight, and a stable token means a restored tab keeps
  working after a restart).

### D10. Server lifecycle in browser mode
Closing the tab doesn't stop the server. Decide the model:
- **(a) Foreground process** (recommended): `comic-canvas` runs attached to
  the terminal, Ctrl-C stops it (mirrors today's `./run` muscle memory).
  Second invocation while running just opens the browser to the live
  instance (via `run/port` + lock check).
- **(b) Daemonized**: `comic-canvas start/stop/status`. More "app-like",
  more machinery (pidfiles, orphan pi subprocesses on `kill -9`).
- **Recommendation:** (a) now; the CLI verbs in WS5 are designed so (b) can
  be added without breaking anything.

### D11. Gemini key storage
- **Recommendation:** drop the old keychain/`keyring` idea. With
  `~/.comic-canvas/config.json` chmod 600 we match the security posture of
  `~/.aws/credentials` and stay dependency-free and headless-Linux-safe.
  Settings UI: paste key → validated with a cheap API call → written to
  config. `GOOGLE_API_KEY` env var still overrides (dev/CI). The "no key"
  state is a banner, not a block (unlike pi — image generation is optional
  in a way agent features are not, per D4's reasoning… decide if you agree,
  it's defensible to block both or neither).

### D12. Upgrade & schema policy mechanics (given C5)
- `meta.json` in `~/.comic-canvas/` records the app version that last wrote
  the library. On startup, if `meta.json` version ≠ running version, log +
  show a one-time banner: "Library was last used with vX; this is vY.
  Schemas may have changed — old projects may fail to load." Then stamp and
  proceed. **No migrations, no refusal.**
- The **installer** is the real guard: when upgrading it prints
  `Upgrading vX → vY. Pre-1.0 releases may break existing projects.
  Back up ~/.comic-canvas/projects first. Continue? [y/N]`
  (skippable with `--yes` for scripting). Decide: prompt (recommended) vs
  warning-only.
- Decide whether the installer keeps the previous version dir for manual
  rollback (**recommendation: yes, keep exactly one** — `app/` holds
  current + previous; rollback is re-pointing the `current` symlink).

### D13. Dev-mode coexistence
- **Recommendation:** `./run` (venv + Vite + repo-local library) stays the
  dev workflow. `COMIC_CANVAS_HOME` env override keeps pytest and the
  `verify` skill's scratch-library flow working. The packaged entrypoint is
  a *new* module (`api/appmain.py` or similar), not a fork of `main.py` —
  same FastAPI app object, different bootstrapping (static mount, token
  middleware, port/lock/logging).

### D14. Installer trust posture
`curl | bash` is convenient and criticized. Decide the mitigations:
- **Recommendation:** installer lives in the repo (`install.sh`) and is
  served from a pinned URL
  (`https://raw.githubusercontent.com/<org>/<repo>/main/install.sh`); it
  downloads release tarballs **by tag** (never `latest` implicitly for
  upgrades — decide: `latest` by default with `--version vX.Y.Z` override is
  fine pre-1.0), verifies **SHA-256 checksums** from the release's
  `checksums.txt`, and is idempotent/re-runnable. Document the two-step
  alternative (`curl -O … ; less install.sh ; bash install.sh`) for the
  cautious.

---

## 5. Implementation plan

Workstreams in dependency order. WS1–WS4 are pure repo changes testable with
today's tooling; WS5+ introduce packaging. Rough sizing assumes one person.

### WS1 — Single-process app core (backend)

1. **Static UI serving.** New packaged entrypoint (D13) that mounts
   `webui/dist` (path via the `resource_path()` helper from WS6) after the
   `/api` routers, catch-all → `index.html`. Add a `vite build` freshness
   check to `./run`? No — dev keeps Vite; only packaging consumes dist.
2. **Token middleware.** FastAPI middleware: require
   `Authorization: Bearer <token>` (or `?token=` on the initial page load
   only) for `/api/*`; reject non-loopback `Host` and cross-`Origin`
   requests. Exempt `/api/health`. Token from `config.json` (D9). ~50 lines
   + tests. Frontend: `api.ts` gains a token header (one choke point — it's
   the single REST client); SSE (`EventSource` can't set headers) uses a
   query-param token — cover it explicitly in the middleware and tests.
3. **Port selection.** Try configured port (default 8787), increment up to
   +20, write the winner to `run/port`. Programmatic uvicorn
   (`uvicorn.Server(Config(...))`), no `--reload`, one worker,
   `multiprocessing.freeze_support()` guard.
4. **Single-instance lock.** Lockfile in `run/` with PID + kernel start time
   (reuse the exact liveness trick from `pi_runtime` snapshots). If a live
   instance holds it: print its URL and open the browser (D10a), exit 0.
5. **Lifecycle.** FastAPI shutdown hook → `PiSessionManager` abort for all
   running tasks (RPC `abort` + terminate fallback already exist). SIGTERM/
   SIGINT handlers → graceful uvicorn exit. Existing snapshot sweep already
   handles unclean death.
6. **Logging.** `logging.handlers.RotatingFileHandler` →
   `~/.comic-canvas/logs/comic-canvas.log` in packaged mode; stdout stays
   for dev. Uvicorn access log off by default, `--verbose` flag re-enables.

*Exit criteria:* `python -m api.appmain` (in-repo, unfrozen) serves UI+API on
one port with token auth; pytest suite green including new middleware tests.

### WS2 — `~/.comic-canvas/` and the rename

1. **Home resolution.** One function, one module (extend the existing
   pattern): `COMIC_CANVAS_HOME` env override → default `~/.comic-canvas`.
   Replace both `LIBRARY_ROOT` definitions (`api/library.py:45`,
   `api/pi_env.py:14`) with imports of it; projects live at
   `<home>/projects` (D2). Keep `PHOTO_WEB_LIBRARY_ROOT` working for one
   release or break it now per D3 — decide with D3.
2. **Config module.** `config.json` load/save (chmod 600 on write), keys:
   `geminiApiKey`, `piBinary?`, `port?`, `authToken`. Env vars override file.
   `.env`/python-dotenv path removed from packaged mode (kept for dev or
   deleted outright — small decision inside D11).
3. **meta.json stamping + version banner** (D12): version constant lives in
   one place (`api/version.py`), written on startup, surfaced via
   `/api/health` and a UI banner on mismatch.
4. **Rename sweep** per D3 decision: binary/window/docs "Comic Canvas";
   README/ARCHITECTURE/AGENTS updated; `./run` exports
   `COMIC_CANVAS_HOME=$ROOT/photo-library` so dev data stays put (or dev dir
   renames too — cosmetic).
5. **No migration code** (C5). README note for the two existing users:
   `mv photo-library ~/.comic-canvas && mv ~/.comic-canvas/projects…` — a
   one-liner in the release notes, not code. (Actual mapping:
   `photo-library/projects` → `~/.comic-canvas/projects`; `.env` key →
   settings UI.)

*Exit criteria:* fresh checkout + `COMIC_CANVAS_HOME=$(mktemp -d)` boots with
an empty library; pytest green with a scratch home; `verify` skill still
works.

### WS3 — Settings surface (frontend + backend)

1. `GET/PUT /api/settings` (token-guarded): gemini key present? (never echo
   the key back — write-only + "configured ✓" boolean), pi status block
   (binary path, version, node version), app version, library path.
2. Settings page/modal in the UI (a seventh nav entry or a gear in the
   shell — small design choice): paste-key flow with validate-before-save
   (cheap Gemini call), pi diagnostics panel (read-only mirror of doctor),
   "your data lives at ~/.comic-canvas/projects" blurb.
3. First-run experience: no key → banner linking to settings; generation
   buttons disabled with tooltip (existing graceful-degrade pattern).

### WS4 — pi preflight, doctor, and extension path

1. **Preflight** (D4/D5): factor `pi_env.find_pi_binary` /
   `ensure_node_runtime` into a `preflight()` returning a structured report
   (found/version/min-ok per dependency). Called by the CLI entrypoint
   before uvicorn starts: failure → human diagnosis (what's missing, how to
   install pi, link) → exit 2. `COMIC_CANVAS_SKIP_PI_CHECK=1` bypass.
   Broaden discovery beyond Homebrew `node@22` paths minimally — since
   launch is terminal-based (D1a), inherited PATH does the real work; keep
   the existing candidates as fallback.
2. **Doctor** (`comic-canvas doctor`): preflight report + live
   `pi --mode rpc` handshake probe + Gemini-key-configured check + library
   path/size + port/lock status. This is the support tool; make its output
   copy-pasteable into a GitHub issue.
3. **Extension path**: `.pi/extensions/photo-web.ts` ships inside the app
   dir (3.2); `pi_runtime` resolves it via `resource_path()` instead of
   `REPO_ROOT`. Same for `.pi/skills` (`pi_env.SKILLS_DIR`) and
   `api/prompt_guides`. Audit for every other `REPO_ROOT` use — this is the
   classic frozen-app breakage; grep and route all of them through the
   helper.
4. **Version pin**: `MIN_PI_VERSION` constant + parse of `pi --version`;
   surfaced in preflight/doctor/settings.

### WS5 — The `comic-canvas` CLI

Single entrypoint (also the frozen binary's entry), argparse-level plumbing:

| Command | Behavior |
|---|---|
| `comic-canvas` / `start` | preflight → lock → server → open browser → foreground until Ctrl-C (D10a). Flags: `--port`, `--no-browser`, `--verbose`. |
| `open` | Open browser to running instance (error if none). |
| `doctor` | WS4.2 report. Exits non-zero on hard failures. |
| `version` | App version + library stamp version. |
| `path` | Print `~/.comic-canvas` (scripting/backup convenience). |
| `logs` | Print log path; `--tail` convenience. |
| `update` | Re-exec the installer (`curl … \| bash`) with the D12 warning prompt. |
| `uninstall` | Remove `app/` + launcher symlink; **never** touches `projects/` (prints how to remove data manually). |

*Exit criteria:* all verbs work unfrozen (`python -m api.cli …`); doctor
output reviewed for tone/usefulness.

### WS6 — Freezing (PyInstaller)

1. `resource_path()` helper honoring `sys._MEIPASS`/onedir layout vs repo
   checkout — single module, used by WS1.1/WS4.3.
2. `comic-canvas.spec`: entry `api/cli.py`; datas: `webui/dist → web/`,
   `.pi/extensions → pi/`, `.pi/skills → pi-skills/`,
   `api/prompt_guides → prompt_guides/`; hiddenimports as discovered
   (uvicorn's loop/protocol modules are the usual suspects). onedir, console
   app (no windowed bundle — D1a).
3. Known checks: reportlab font data present in the frozen tree (booklet
   PDF export is the test); Pillow plugins load; `google-genai` httpx certs
   (`certifi`) bundled.
4. Local build script `scripts/build-release.sh`: `npm run build` →
   `pyinstaller` → smoke test (boot, `curl /api/health` with token, render
   `/` → 200, generate a booklet PDF from a seeded project) → tarball
   `comic-canvas-<version>-<os>-<arch>.tar.gz`.

*Exit criteria:* frozen build passes the smoke script on a dev Mac and in an
ubuntu-22.04 container, including one full pi task against a real system pi.

### WS7 — `install.sh`

Behavior (per D14):

1. Detect OS/arch (`Darwin/arm64`, `Linux/x86_64`); clear error otherwise.
2. Resolve version: `--version vX.Y.Z` or GitHub API `releases/latest`.
3. If upgrading (existing `meta.json`/`app/current`): print the C5 warning
   with current→new versions; prompt unless `--yes`.
4. Download tarball + `checksums.txt` to a temp dir; verify SHA-256.
5. Unpack to `~/.comic-canvas/app/<version>/`; flip `current` symlink;
   prune all but the previous version (D12).
6. Symlink `~/.local/bin/comic-canvas`; if `~/.local/bin` isn't on PATH,
   print the exact `export PATH` line for the user's shell (detect zsh/bash
   from `$SHELL`).
7. Run preflight (WS4.1) in warn-only mode: report pi/node/key status and
   what to do about each; never fail the install for them.
8. Print the quick-start (`comic-canvas` to launch; data lives at …;
   upgrade risk note).
9. Idempotent, re-runnable, `set -euo pipefail`, no sudo ever, works when
   piped (read prompts from `/dev/tty`, with `--yes` for non-tty).

Also `scripts/uninstall.sh` mirroring WS5's `uninstall`.

*Exit criteria:* fresh-install and upgrade paths tested on macOS and in a
clean ubuntu-22.04 container (docker makes the Linux matrix cheap); shellcheck
clean.

### WS8 — Release pipeline (GitHub Actions)

1. **CI (every PR):** existing gates (pytest, `npm run build`) + shellcheck
   on `install.sh` + the unfrozen single-process smoke test.
2. **Release (on tag `v*`):** matrix `[macos-14 (arm64), ubuntu-22.04]` →
   pin CPython (D7) via `actions/setup-python` → `scripts/build-release.sh`
   (which includes the frozen smoke test; the pi-dependent step is skipped
   in CI or run against a pinned pi install if licensing/auth allows — decide
   when writing the workflow) → upload tarballs + `checksums.txt` +
   generated release notes containing the C5 warning template.
3. **Versioning:** semver-ish `v0.X.Y`; bump `api/version.py` in the tag
   commit; a "does this release change on-disk schema?" checkbox in the
   release-notes template so the warning is honest, not boilerplate.
4. README gets the install one-liner + badges.

### WS9 — Testing strategy

| Layer | What |
|---|---|
| Unit/API | Existing pytest + new: token middleware (incl. SSE query token, Origin rejection), home resolution, config chmod, preflight parsing, version stamp. |
| Frontend gate | Existing `tsc + vite build`; api.ts token plumbing typechecked. |
| Packaged smoke | WS6.4 script — the only test that runs against the frozen artifact; keep it fast (<2 min) and in the release job. |
| E2E | Existing Playwright rig gains a mode targeting the packaged server (static-served UI instead of Vite) — catches path/token/SSE integration bugs the unit layer can't. Run pre-release, not per-PR. |
| Installer | Manual on macOS; containerized fresh-install/upgrade/uninstall on Linux in the release workflow. |
| pi integration | One scripted end-to-end pi task (e.g. `discover-characters` on a tiny book) against the packaged build, run manually pre-release — this is the highest-value manual check given C4. |

### WS10 — Documentation

- README: install one-liner, prerequisites (pi + how comic-canvas uses *your*
  pi config/models, Gemini key), upgrade warning (C5), backup guidance
  (`~/.comic-canvas/projects`), uninstall, dev-mode section (`./run`
  unchanged).
- ARCHITECTURE.md: new "Packaging" section (entrypoint, resource_path, home
  resolution, token middleware) so the seams stay documented.
- `docs/` release checklist: tag, verify artifacts, run pi E2E, publish.

### Suggested sequencing

```
WS1 ─┬─ WS2 ─┬─ WS3 (parallel with WS4)
     │       ├─ WS4 ─ WS5 ─ WS6 ─ WS7 ─ WS8
     │       └─ WS10 (rolling)
     └─ WS9 (rolling, gates each WS)
```

WS1+WS2 are the bulk of the code churn and land as normal PRs against the
existing test suite. Everything from WS5 on is additive scaffolding.

---

## 6. Versioning & breaking-change policy (C5 in practice)

- Pre-1.0: **no migrations, no compat shims.** A release that changes
  `project.json`/`canvas.json`/`adaptation.json`/`tags.json` shape just says
  so in its notes.
- The three enforcement points, all warn-not-block: installer upgrade prompt
  (WS7.3), startup version-stamp banner (WS2.3), release-notes checkbox
  (WS8.3).
- Cheap insurance worth taking: the installer's upgrade prompt suggests the
  exact backup command
  (`cp -r ~/.comic-canvas/projects ~/.comic-canvas/projects.bak-<date>`).
  Zero code in the app, saves someone's week.
- When the project matures, this section gets replaced by real
  `schemaVersion` + migration hooks; nothing in this plan blocks that.

## 7. Security posture summary

- Loopback-only bind (unchanged) + per-install bearer token + `Host`/`Origin`
  checks (WS1.2) — closes localhost-CSRF/DNS-rebinding against an API that
  mutates files and spends Gemini credits.
- Secrets: `config.json` chmod 600; key never echoed by the API; env
  override for dev.
- Installer: checksum-verified assets, no sudo, reviewable script at a
  stable URL.
- pi runs with the user's own privileges and their own model credentials —
  comic-canvas adds no credential surface for pi at all (D6).

## 8. Risk register (updated for this plan)

| Risk | Severity | Mitigation |
|---|---|---|
| pi version drift breaks RPC/session-trace parsing | **High** (it's now a hard external dependency) | `MIN_PI_VERSION` gate, doctor handshake probe, pre-release pi E2E (WS9); pin the tested pi version in release notes |
| `REPO_ROOT`-relative paths break when frozen | High likelihood, easy | `resource_path()` sweep (WS4.3/WS6.1) + frozen smoke test |
| Frozen-app respawn loop (uvicorn reload/workers) | Fatal if missed, trivial | Programmatic uvicorn, `freeze_support()` (WS1.3) |
| glibc too new on build machine strands older distros | Medium | Build on ubuntu-22.04; document baseline + no-musl (D7) |
| Browser-downloaded tarball hits Gatekeeper | Low (installer is the documented path) | README note + `xattr` escape hatch (3.4); future: real signing |
| User upgrades and old projects break (C5, accepted) | Accepted | Warn at install + startup; backup suggestion (Section 6) |
| Tab closed, server forgotten, user relaunches | Low | Single-instance lock reuses the live server and reopens the tab (WS1.4) |
| SSE through token middleware regresses | Medium | Explicit query-token path + Playwright packaged-mode test (WS9) |
| `~/.local/bin` not on PATH | High frequency, trivial | Installer prints the exact export line (WS7.6) |
| Port 8787 taken | Low | Auto-increment + `run/port` (WS1.3) |

## 9. Deferred / roads not taken (and why)

- **pywebview/Tauri native window** — deferred behind D1; nothing here
  precludes `comic-canvas --window` later. Revisit if "it's just a browser
  tab" grates.
- **Bundling pi/Node** — explicitly rejected by C4; the system-pi model is
  the feature (user's own models/credentials).
- **macOS signing/notarization, Homebrew tap, .deb/.rpm/AppImage** — mature-
  phase distribution polish. A Homebrew tap is the most likely first
  addition (it's ~30 lines once tarballs+checksums exist).
- **Auto-update framework** — the installer *is* the updater
  (`comic-canvas update`); anything fancier waits for schema stability.
- **Windows** — out of scope (C1).
- **Migration machinery** — out of scope until maturity (C5); Section 6
  leaves the door open.
