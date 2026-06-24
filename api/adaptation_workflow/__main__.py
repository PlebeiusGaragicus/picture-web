"""CLI entry: python -m adaptation_workflow run|validate|extract-scene ..."""

from __future__ import annotations

import sys

from adaptation_workflow.runner import (
    run_extract_character,
    run_extract_characters,
    run_extract_scene,
    run_list_characters,
    run_plan_scene,
    run_validate,
    run_workflow,
)


def usage() -> None:
    print(
        """Usage:
  python -m adaptation_workflow run <project-slug> [stage]
  python -m adaptation_workflow validate <project-slug> [stage]
  python -m adaptation_workflow list-characters <project-slug>
  python -m adaptation_workflow extract-character <project-slug> <character-slug> [--force]
  python -m adaptation_workflow extract-characters <project-slug>
  python -m adaptation_workflow extract-scene <project-slug> <scene-slug> [--force]
  python -m adaptation_workflow plan-scene <project-slug> <scene-slug>

Run stages:
  ingest       Phase 0: read-book session + visual style.
  characters   Phase 1: extract all character files.
  scene-list   Phase 2: scene list for the story.
  all          Run ingest, characters, and scene-list (default).

Validate stages:
  ingest, characters, scene-list, scenes, locations, moments, all
""",
        file=sys.stderr,
    )


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args:
        usage()
        return 2
    command = args[0]
    if command == "list-characters":
        if len(args) != 2:
            usage()
            return 2
        return run_list_characters(args[1])
    if command == "extract-character":
        if len(args) not in {3, 4}:
            usage()
            return 2
        force = len(args) == 4 and args[3] == "--force"
        if len(args) == 4 and not force:
            usage()
            return 2
        return run_extract_character(args[1], args[2], force=force)
    if command == "extract-characters":
        if len(args) != 2:
            usage()
            return 2
        return run_extract_characters(args[1])
    if command == "extract-scene":
        if len(args) not in {3, 4}:
            usage()
            return 2
        force = len(args) == 4 and args[3] == "--force"
        if len(args) == 4 and not force:
            usage()
            return 2
        return run_extract_scene(args[1], args[2], force=force)
    if command == "plan-scene":
        if len(args) != 3:
            usage()
            return 2
        return run_plan_scene(args[1], args[2])
    if len(args) < 2 or len(args) > 3:
        usage()
        return 2
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
