"""CLI entry: python -m adaptation_workflow run|validate <slug> [stage]"""

from __future__ import annotations

import sys

from adaptation_workflow.runner import run_validate, run_workflow


def usage() -> None:
    print(
        """Usage:
  python -m adaptation_workflow run <project-slug> [stage]
  python -m adaptation_workflow validate <project-slug> [stage]

Stages:
  ingest      Phase 0: read-book session + visual style.
  characters  Phase 1: character list, artifacts, and sheets.
  all         Run ingest and characters (default).
""",
        file=sys.stderr,
    )


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) < 2 or len(args) > 3:
        usage()
        return 2
    command = args[0]
    project_slug = args[1]
    stage = args[2] if len(args) == 3 else "all"
    if command == "run":
        return run_workflow(project_slug, stage)
    if command == "validate":
        return run_validate(project_slug, stage)
    usage()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
