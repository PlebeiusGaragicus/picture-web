"""Test bootstrap: never let tests touch the real ~/.comic-canvas.

Individual tests monkeypatch the per-module LIBRARY_ROOT constants, but
background threads (pi task on_success hooks) can outlive a test's
monkeypatch teardown and fall back to the import-time default. Point that
default at a throwaway dir before any module under test is imported.
"""

import os
import tempfile

os.environ.setdefault("COMIC_CANVAS_HOME", tempfile.mkdtemp(prefix="comic-canvas-tests-"))
