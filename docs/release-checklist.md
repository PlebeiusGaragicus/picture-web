# Release checklist

1. **Version bump.** Set `APP_VERSION` in `api/version.py`. The release
   workflow fails if the tag doesn't match.
2. **Gates green locally.**
   - `.venv/bin/python -m pytest api/ -q`
   - `cd webui && npm run build`
   - `shellcheck install.sh scripts/*.sh run`
   - `scripts/build-release.sh` (freezes + runs the frozen smoke test)
3. **Real pi task against the frozen build** (the one thing CI can't do —
   CI runners have no pi):
   - `dist-release/build/comic-canvas/comic-canvas start --no-browser` with a
     scratch `COMIC_CANVAS_HOME`
   - create a project, upload a tiny `book.txt`, run `read-book` then
     `discover-characters`, confirm a character record lands.
   - `comic-canvas doctor` shows all checks ok.
4. **Schema honesty.** Did this release change the shape of `project.json`,
   `canvas.json`, `tags.json`, `adaptation.json`, `panels.json`, or asset
   metadata? Note it explicitly in the release body ("Schema changes:" line —
   the draft template has a placeholder). Pre-1.0 there are NO migrations;
   the warning is the contract.
5. **Tag and push.** `git tag vX.Y.Z && git push origin vX.Y.Z`. The release
   workflow builds macos-arm64 + linux-x86_64, checksums, and opens a
   **draft** release.
6. **Fill in the draft** (schema-changes line, highlights) and publish.
7. **Verify install path.**
   `curl -fsSL https://raw.githubusercontent.com/PlebeiusGaragicus/picture-web/main/install.sh | bash`
   on a machine (or container for Linux), then `comic-canvas doctor`.
