# photo-web library package — idea document

How macOS Photos represents a “single library file,” and how photo-web could adopt the same pattern with a custom package in `~/Pictures` (or anywhere the user chooses).

**Status:** Idea / direction — not implemented. Today the app uses `./photo-library/` next to the repo (see [spec.md](spec.md)).

---

## What you see vs what’s on disk

In Finder, **Photos Library** looks like one file: `Photos Library.photoslibrary`. In the terminal it is a normal directory:

```bash
ls -ld ~/Pictures/Photos\ Library.photoslibrary
# drwxr-xr-x@ ... Photos Library.photoslibrary

file ~/Pictures/Photos\ Library.photoslibrary
# directory
```

Inside (names vary by macOS and Photos version), Apple typically stores:

- A **SQLite catalog** (e.g. under something like `database/`) — albums, faces, metadata, relationships
- **Originals / masters** — full-resolution image bytes, often in a hashed or date-based tree
- **Derivatives** — previews, edits, thumbnails
- **Private / internal** folders Photos treats as implementation detail

So “one library file” is **one folder + conventions + OS integration**, not a proprietary single-file blob or a special filesystem object type.

---

## Why Finder treats it as special

Several layers stack together. None of them require a custom disk format.

### 1. Document package (the core trick)

Apple’s model: a directory that should behave like a **document**, not a folder users browse casually.

Apps declare this when they register a type, for example in `Info.plist`:

- **Legacy:** `LSTypeIsPackage` = `true` on a document type
- **Modern:** a custom **UTType** that **conforms to** `com.apple.package`

The extension `.photoslibrary` is bound to an Apple-owned type (along the lines of `com.apple.photos-photoslibrary`) and marked as a package. Finder then:

- Shows **one icon** instead of expanding the tree in normal navigation
- Offers **Open** → launches the owning app (Photos)
- Offers **Show Package Contents** (Option-click or context menu) for power users

Same mechanism as `.app`, `.pages`, `.band`, many `.xcodeproj`, and other “folders that act like files.”

### 2. Default handler (Launch Services)

macOS maps extension / UTType → **which app opens it**. Photos owns `.photoslibrary`, so double-click does not open Finder inside the package; it opens Photos, which reads the internal layout it expects.

photo-web would register its **own** extension and type so double-click opens our desktop app, not Photos and not a bare folder view.

### 3. UX and policy (not filesystem enforcement)

Photos adds behavior on top of the package shape:

- Strong assumption: **only Photos** should mutate that tree while the library is in use
- Warnings when moving or duplicating libraries with iCloud Photos involved
- Internal locking / state so partial edits are less likely to corrupt the catalog

That is **app logic and user education**, not a kernel lock. Anyone with file access can still use **Show Package Contents** and delete or edit files — same as any package.

### 4. Optional polish (not required for the idea)

- **Custom icon** on the package so it reads as a “library” in Finder
- **Spotlight** importers — index inside or skip certain subtrees
- **Quick Look** — preview the package as a whole
- **Sandbox + security-scoped bookmarks** (Mac App Store Photos) — access control separate from package shape; an unsigned dev app in `~/Pictures` is ordinary user-readable files

“Special on macOS” means **package flag + UTType + default app + Photos-specific behavior**, not a different kind of file on APFS.

---

## Containing a library in `~/Pictures`

**Containment** here means:

| Layer | What it gives you |
|--------|-------------------|
| **Package directory** | One named thing in Finder; a clear boundary: “this blob is one library” |
| **Schema inside** | We control layout (`projects/`, `canvas.json`, assets, etc.) — analogous to Photos’ catalog + originals |
| **Single app as writer** | The desktop app is the only component that should create, move, or delete inside while the library is open |
| **Not** | Encryption, tamper-proofing, or hiding data from the user — it is still their disk |

Putting a library at `~/Pictures/Acme Canvas.photoweblibrary/` is reasonable. macOS will **not** treat it like Apple’s Photos library unless we register **our** extension / UTType and ship an app that opens it. Without that, it is just a directory (perhaps with a descriptive name).

---

## Proposed shape for photo-web

Use a **custom extension** — e.g. `.photoweblibrary` — **not** `.photoslibrary` (Apple’s type; confusing for users and Launch Services).

On disk, wrap the layout we already use under `photo-library/`:

```text
~/Pictures/Acme Canvas.photoweblibrary/     ← package (directory)
  library.json                              ← optional manifest: formatVersion, createdAt, …
  .env                                      ← API key / defaults (or Keychain later)
  projects/
    <slug>/
      canvas.json
      assets/
        <ulid>.json
        <ulid>.png
        …
```

The backend today resolves the library relative to the repo:

```text
REPO_ROOT / "photo-library"
```

For a shipped desktop app, **`PHOTO_LIBRARY_ROOT`** (or equivalent) would point at the **package directory path** — the folder whose name ends in `.photoweblibrary`, not a single file inside it.

We do **not** need one SQLite file for the “Photos feel.” Photos uses SQLite **inside** the package for **their** catalog. Our catalog is already JSON + PNG on disk, which fits inside a package as-is. We can add SQLite later inside the package if scale demands it, without changing the outer package model.

---

## How to implement “one of those”

1. **Pick an extension** — e.g. `.photoweblibrary`.
2. **Register a UTType** in the desktop app’s `Info.plist`, conforming to `com.apple.package` (and optionally `public.composite-content` or similar for document semantics).
3. **Create libraries as directories** with that suffix; the API reads/writes only under that path.
4. **Open flow** — double-click opens our app; **File → Open Library** uses `NSOpenPanel` filtered to our type.
5. **One writer** — document that users should not edit the package in Finder while the app has it open; optional advisory lockfile (e.g. `.photoweblibrary/.lock`) while running.

### Minimal manifest (recommended)

A small `library.json` at the package root helps detect wrong folders and support future breaking layout changes (consistent with [AGENTS.md](../AGENTS.md) — change shape directly, no long migration chains unless rescuing data):

```json
{
  "formatVersion": 1,
  "kind": "photo-web-library",
  "createdAt": "2026-05-30T12:00:00Z"
}
```

Refuse to open directories that lack this file or have an unknown `formatVersion`, with a clear error in the UI.

---

## Photos vs photo-web (comparison)

| | Photos | photo-web-style library |
|--|--------|-------------------------|
| On-disk shape | Package directory | Same |
| Catalog | Mostly SQLite inside | JSON + files today (SQLite optional later) |
| Pixels | Inside package tree | `assets/*.png` per project |
| “One file” in Finder | Yes (package) | Yes, if we register the type |
| System integration | Apple UTType, iCloud, etc. | Our UTType + our desktop app |
| True security boundary | Sandboxed app + entitlements | Only with sandbox + security-scoped bookmarks |

---

## Relation to desktop packaging

This idea pairs with shipping a **desktop app** that:

- Spawns or embeds the FastAPI backend
- Sets `PHOTO_LIBRARY_ROOT` to the opened `.photoweblibrary` path (or a default under `~/Pictures`)
- Owns the library lifecycle (open, create, save, quit)

See future desktop packaging notes in conversation / separate doc when written. The package model is independent of Tauri vs Electron vs pywebview: all of them need a **stable, user-visible library location**; the package is how that location looks and behaves in Finder.

---

## Non-goals (for this idea)

- Impersonating `.photoslibrary` or opening Photos libraries
- Hiding library contents from the user (no encryption-by-obscurity)
- iCloud sync or multi-machine sync
- Guaranteeing Finder or other apps cannot modify files inside the package

---

## Open questions

- Default library location: `~/Pictures/<name>.photoweblibrary` vs `~/Library/Application Support/photo-web/` vs user-picked only
- Whether `.env` stays in the package or API keys move to Keychain with only non-secret defaults in JSON
- Multiple libraries vs one global library with many projects (current model is many projects under one `photo-library/` root — likely one package = many projects, same as today)
- Icon and marketing name for the package type in Finder (“photo-web Library” vs product name)

---

## Summary

A Photos library is **a directory with a registered package type and a dedicated app**. Containing work in `~/Pictures` means **one named package, one schema inside, one app that owns writes** — not a special APFS file format.

For photo-web, the natural direction is a **custom `.photoweblibrary` package** holding today’s `photo-library` layout, opened by the desktop shell, with the API’s library root pointing at that package path instead of a repo-relative folder.
