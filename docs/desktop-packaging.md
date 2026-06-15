# Desktop packaging plan

How `photo-web` could move from the current two-server development setup to a packaged desktop application for macOS and Linux.

**Status:** Planning note. Not implemented. Today the app is launched with `./run`, which starts FastAPI and Vite development servers.

---

## Current shape

The project is currently a local web app:

- `api/` is a FastAPI backend.
- `webui/` is a Vite/React frontend.
- `./run` creates or reuses `.venv`, installs Python dependencies, installs web dependencies, starts FastAPI with reload, and starts the Vite dev server.
- The frontend calls relative `/api/...` URLs. In development, Vite proxies those to `http://127.0.0.1:8787`.
- The backend stores data in `REPO_ROOT / "photo-library"` and loads secrets from `photo-library/.env`.

This is good for development, but not a distributable desktop application. A packaged app should not depend on the user running `npm`, managing a virtualenv, or launching two visible servers.

---

## Recommended first target: pywebview + PyInstaller

The lowest-friction desktop path is:

```text
PyInstaller executable / .app
  Python desktop entrypoint
  FastAPI backend
  built Vite static assets
  bundled prompts/scripts
  user-selected library directory
```

At runtime, a small Python entrypoint would:

1. Resolve bundled resource paths.
2. Resolve the user library path.
3. Start FastAPI on `127.0.0.1` with a random available port.
4. Open a pywebview window pointed at that local server.
5. Shut down the backend when the window exits.

This keeps the existing Python backend as the application core and avoids adding an Electron or Tauri control plane before the app needs one.

---

## Why this fits the project

The backend is already filesystem-backed and has clear boundaries around the local library. The frontend already uses relative `/api` URLs, which can work unchanged if FastAPI serves both static assets and API routes from one origin.

The main implementation work is path resolution:

```text
Current development shape:
  REPO_ROOT / "photo-library"
  REPO_ROOT / "prompts" / "seed-defaults"
  webui dev server proxies /api

Packaged shape:
  PHOTO_LIBRARY_ROOT or app-selected library path
  bundled prompt/resource directory
  FastAPI serves webui/dist and /api
```

This also pairs naturally with the `.photoweblibrary` package idea in [photoweblibrary-package.md](photoweblibrary-package.md). On macOS, the desktop app can register `.photoweblibrary` as a document package. On Linux, the same directory layout can be used without Finder package behavior.

---

## Linux requirement

This approach can work on Linux, but Linux needs to be treated as a first-class packaging target.

pywebview supports Linux through GTK/WebKitGTK. That means a Linux build may require system packages such as:

- WebKitGTK
- GTK
- GObject introspection bindings

The exact package names vary by distribution. This makes Linux less predictable than macOS, where the webview stack is built into the platform.

For Linux distribution, likely options are:

- **AppImage** for a broad portable desktop artifact.
- **`.deb`** if Ubuntu/Debian are the primary targets.
- **`.rpm`** if Fedora/RHEL-style systems matter.
- **Flatpak** if sandboxing and desktop-store distribution become important.

For early internal builds, target one known Linux environment first, for example Ubuntu LTS, then widen from there.

---

## macOS target

For macOS, PyInstaller can produce a `.app` bundle. A polished distribution would then add:

- App icon and bundle metadata.
- Code signing.
- Notarization.
- Optional `.dmg` packaging.
- Optional `.photoweblibrary` document type registration.

The document package model is separate from the app packaging model. The app can ship first with a normal user-selected library directory, then later add `.photoweblibrary` as a nicer Finder-facing wrapper.

---

## Required app changes

### Serve the built frontend

Add a production mode where FastAPI serves `webui/dist`:

- `/api/...` remains API traffic.
- `/assets/...` and frontend routes serve static files.
- Unknown non-API routes fall back to `index.html`.

The Vite dev proxy remains useful for development, but the packaged app should not run Vite.

### Make paths configurable

Replace hardcoded repo-relative runtime paths with resolver functions:

- `PHOTO_LIBRARY_ROOT` or an app-selected library path for user data.
- A bundled resource root for prompts and scripts.
- A development fallback that preserves the current repo-relative behavior.

In a PyInstaller build, resource paths usually need to account for `sys._MEIPASS` or an equivalent application resource directory.

### Move secrets out of repo-local assumptions

Today, Gemini credentials are expected in `photo-library/.env`.

For packaged builds, early options are:

- Keep `.env` inside the selected library directory.
- Use a per-user config directory.
- Use platform key stores later, such as macOS Keychain and Linux Secret Service.

For initial local packaging, `.env` in the library directory is probably simplest. For broader distribution, use the OS key store.

### Manage backend lifecycle

The desktop entrypoint should own the backend process/thread:

- Pick a random local port.
- Wait until `/api/health` responds before opening the window.
- Keep the server bound to `127.0.0.1`.
- Shut it down cleanly on window close.
- Surface startup failures in a user-visible error window or log file.

### Decide what to do with shell workflows

The adaptation workflow currently shells out through `bash`, calls `python3`, depends on `PATH`, and has a Homebrew-specific Node path fallback.

That is the largest packaging risk. Before shipping, choose one of these policies:

- Bundle the required tools and scripts.
- Disable those workflows in packaged builds.
- Treat them as advanced features that require external tool installation.

For Linux support, remove macOS-specific assumptions such as `/opt/homebrew/opt/node@22/bin` from runtime logic or isolate them behind platform-specific setup.

---

## Packaging artifacts

Recommended initial artifacts:

```text
macOS:
  photo-web.app
  optional photo-web.dmg

Linux:
  AppImage or .deb for one target distro
```

Build on each target OS. Do not assume a macOS build can produce a correct Linux artifact or vice versa.

---

## Suggested phases

### Phase 1: Production web serving

- Add `webui` production build output.
- Serve built assets from FastAPI.
- Verify the app works without Vite.

### Phase 2: Runtime path cleanup

- Introduce library/resource path resolvers.
- Add `PHOTO_LIBRARY_ROOT`.
- Preserve current development defaults.
- Verify tests can use temporary library roots.

### Phase 3: Desktop shell

- Add a Python desktop entrypoint.
- Start FastAPI internally.
- Open pywebview.
- Shut down cleanly.

### Phase 4: First packaged builds

- Add PyInstaller configuration.
- Build and smoke-test macOS `.app`.
- Build and smoke-test one Linux artifact.
- Document required Linux system packages if they are not bundled.

### Phase 5: Distribution polish

- Add icons and app metadata.
- Add macOS signing/notarization.
- Add Linux desktop file metadata.
- Add `.photoweblibrary` registration on macOS.
- Move secrets to platform key stores if distribution requires it.

---

## Open questions

- Should packaged builds support the full adaptation workflow, or should image/library management ship first?
- Should one library contain many projects, as today, or should each `.photoweblibrary` package represent a narrower workspace?
- Should `GOOGLE_API_KEY` live inside the library package during early desktop development?
- Which Linux target should be first: Ubuntu `.deb`, AppImage, or Flatpak?
- Is automatic update in scope? If yes, Electron may become more attractive later despite its size.

---

## Summary

`pywebview + PyInstaller` is a reasonable first desktop packaging route for this project and can satisfy the Linux requirement. The main work is not the window shell; it is making runtime paths explicit, serving the built frontend from FastAPI, choosing a user data location, and deciding how much of the current shell-based adaptation workflow belongs in packaged builds.

