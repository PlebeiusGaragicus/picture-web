# PyInstaller spec for the comic-canvas single-binary (onedir) build.
#
# Build from the repo root:  pyinstaller packaging/comic-canvas.spec
# Requires webui/dist to exist (npm run build) — the spec fails fast if not.

from pathlib import Path

repo = Path(SPECPATH).resolve().parent  # noqa: F821 - SPECPATH is injected by PyInstaller

web_dist = repo / "webui" / "dist"
if not (web_dist / "index.html").is_file():
    raise SystemExit("webui/dist/index.html missing — run `npm run build` in webui/ first")

# Read-only app resources; destinations mirror the repo layout so
# api/paths.py resolves them identically frozen and unfrozen.
datas = [
    (str(web_dist), "webui/dist"),
    (str(repo / "prompts" / "seed-defaults"), "prompts/seed-defaults"),
    (str(repo / ".pi" / "skills"), ".pi/skills"),
    (str(repo / ".pi" / "extensions"), ".pi/extensions"),
    (str(repo / "api" / "prompt_guides"), "api/prompt_guides"),
]

a = Analysis(
    [str(repo / "api" / "cli.py")],
    pathex=[str(repo / "api")],  # flat imports: `import library`, not `api.library`
    datas=datas,
    hiddenimports=[
        # appmain imports `main` lazily inside build_app(); make it explicit.
        "main",
        # uvicorn resolves these by string at runtime.
        "uvicorn.logging",
        "uvicorn.loops.auto",
        "uvicorn.loops.asyncio",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.http.h11_impl",
        "uvicorn.protocols.http.httptools_impl",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan.on",
    ],
    excludes=["pytest", "playwright"],
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    exclude_binaries=True,
    name="comic-canvas",
    console=True,
    upx=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    name="comic-canvas",
    upx=False,
)
