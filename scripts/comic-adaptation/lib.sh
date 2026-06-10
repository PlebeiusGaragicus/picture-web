#!/usr/bin/env bash

resolve_adaptation_target() {
  local target="${1%/}"
  PROJECT_SLUG=""
  ADAPTATION_ROOT=""
  LEGACY_BOOK_ROOT=""

  if [[ "$target" == books/* ]]; then
    LEGACY_BOOK_ROOT="$target"
    PROJECT_SLUG="$(basename "$target" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//; s/-$//')"
    ADAPTATION_ROOT="$target"
    return
  fi

  if [[ "$target" == photo-library/projects/*/adaptation ]]; then
    ADAPTATION_ROOT="$target"
    PROJECT_SLUG="${target#photo-library/projects/}"
    PROJECT_SLUG="${PROJECT_SLUG%/adaptation}"
    return
  fi

  PROJECT_SLUG="$target"
  ADAPTATION_ROOT="photo-library/projects/$PROJECT_SLUG/adaptation"
}

ensure_project_adaptation_dirs() {
  mkdir -p \
    "$ADAPTATION_ROOT/sessions" \
    "$ADAPTATION_ROOT/style-refs" \
    "$ADAPTATION_ROOT/characters/artifacts" \
    "$ADAPTATION_ROOT/characters/sheets" \
    "$ADAPTATION_ROOT/scenes" \
    "$ADAPTATION_ROOT/locations/prompts"
}
