"""CLI entry: python -m adaptation_workflow list-characters|extract-character|..."""

from __future__ import annotations

import sys

from adaptation_workflow.runner import (
    run_extract_character,
    run_extract_characters,
    run_generate_concept_character,
    run_generate_concept_location,
    run_list_characters,
)


def usage() -> None:
    print(
        """Usage:
  python -m adaptation_workflow list-characters <project-slug>
  python -m adaptation_workflow extract-character <project-slug> <character-slug> [--force]
  python -m adaptation_workflow extract-characters <project-slug>
  python -m adaptation_workflow generate-concept-character <project-slug>
  python -m adaptation_workflow generate-concept-location <project-slug>
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
    if command == "generate-concept-character":
        if len(args) != 2:
            usage()
            return 2
        return run_generate_concept_character(args[1])
    if command == "generate-concept-location":
        if len(args) != 2:
            usage()
            return 2
        return run_generate_concept_location(args[1])
    usage()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
