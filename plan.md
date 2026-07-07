# Plan: variants first-class + schema slim-down + locations become structured records

Status legend: `[ ]` todo · `[x]` done · `[~]` in progress. **Update this file as work lands.**
If resuming from fresh context: read AGENTS.md + ARCHITECTURE.md first; run the test
commands at the bottom of each phase to see where reality is.

## Context (why)

The 2026-07-06 refactor (commits fb109c3, 5181ee3) moved characters from markdown
files to structured `CharacterRecord`s in `adaptation.json`, mutated via pi tools
(`register_character`/`list_characters`/`update_character`) and edited in a
structured modal. A zoom-out review then found four things that no longer make
sense, and the user approved fixing all of them:

1. **`mode`/`styleRef`/`finalized` on variants are dead file-era machinery.**
   Nothing reads them: generation never looks at them, and the "edit-reference"
   behavior they encoded already emerges from the canonical system (a variant's
   canvas node is tagged with the character, so the entity tag's canonical — the
   base sheet — is auto-attached as a generation ref by `canonical_refs_for_tags`).
2. **Variants are second-class, contradicting the product goal** (reference sheet
   per durable look — young/adult, healthy/sick — feeding panel consistency).
   Entity tags/canonicals exist only per character (base); no per-variant Draft
   button; panels can't say *which look*; `storyContext` is stored but unused.
3. **Locations are the remaining markdown anachronism** (`locations/prompts/*.md`,
   `sync_location_links`, `parse_prompt_sections`, the whole adaptation-files CRUD
   exists only for them). Also discovered: **no locations editor UI exists at all**
   — the location adaptation-file api.ts methods are unused by any view.
4. **Flat-key draft API is ambiguous string-munging** —
   `import_artifact_to_canvas("character-sheet", "gilda-molting")` prefix-matches
   slugs; replace with explicit per-variant endpoints.

Slugs stay (decision): they are minted, stable, human-readable ids woven through
tags.json / node tags / panel `characterSlugs` / agent prompts. Slug follows
display name only until images exist (already implemented in the hub view).

Key verified facts to rely on:
- `story_panels.draft_panel_to_canvas` resolves panel entities → refs purely via
  the tag registry (`entity_tags[normalize_tag_id(key)].canonicalAssetId`), so
  variant-aware panels need **no change** there once variant tags + canonicals exist.
- `library.sync_entity_tags(..., preserve_orphan_locked_entity_tags=False)` drops
  locked entity tags not in the passed key set — stale variant tags clean up free.
- `webui/e2e/seed.ts` — check whether it seeds locations via adaptation-files
  before deleting that API (phase C).
- Real data: only `photo-library/projects/cupcake` has characters (3, already in
  new record shape); its `locations` dict is empty. Breaking changes preferred,
  no migrations (AGENTS.md).

---

## Phase A — slim the variant schema  ✅ COMMITTED

Goal: `CharacterVariant` → renamed `EntityVariant` (locations adopt it in C) with
only meaningful fields: `label`, `storyContext`, `prompt`, `assetIds`,
`activeAssetId`. Drop `mode`, `styleRef`, `finalized`, stored `status`.

- [x] `api/models.py`: rename model `CharacterVariant` → `EntityVariant`; fields =
      label, storyContext, prompt, assetIds, activeAssetId. `CharacterVariantPatch`
      → label/storyContext/prompt only. `CharacterRecord.variants: dict[str, EntityVariant]`.
- [x] `api/adaptation.py`: `_variant_with_status` deleted; add derived helper
      `variant_status(variant) -> 'missing'|'ready'|'generated'` (assetIds → generated,
      prompt → ready). Split `_clear_stale_link_group` into the location version
      (AdaptationAssetLink, keeps status) and `_clear_stale_variant_group`
      (EntityVariant, no status write). Update `update_character` variant merge.
- [x] `.pi/extensions/photo-web.ts`: `update_character.variants` drops mode/styleRef.
- [x] `.pi/skills/extract-character/SKILL.md` + `refine-character/SKILL.md`: remove
      mode/style_ref rules; keep verbatim Layout block + exactly-four Expressions;
      non-base prompts still state only the visual delta from base ("Same design as
      the reference image…") — the base sheet arrives as a reference automatically.
- [x] `api/pi_profiles.py`: `_character_record_context` drops mode/styleRef.
- [x] webui `types.ts`: `CharacterVariant` type slims to label/storyContext/prompt/
      assetIds/activeAssetId (+ drop status/finalized/mode/styleRef);
      `CharacterVariantPatchPayload` likewise.
- [x] webui `CharacterEditModal.tsx`: delete the "Advanced" disclosure (mode/styleRef
      inputs); `CharacterVariantDraft` slims.
- [x] Tests: `test_api.py` (variant asserts drop mode/styleRef/status),
      `test_adaptation_workflow.py` `_registered_record`, `test_pi_runtime.py`
      (FAKE_PI_CALL_TOOL bodies, BASE_SHEET_PROMPT unchanged).
- [x] Data: strip dead fields from cupcake's adaptation.json variants (one-off jq/py).
- [x] Verify: `.venv/bin/python -m pytest api/test_api.py api/test_adaptation_workflow.py api/test_pi_runtime.py -q`
      && `cd webui && npm run typecheck`.

## Phase B — variants become first-class entities  ✅ COMMITTED

Goal: every variant gets its own entity tag (`slug` for base, `slug-<variant>`
otherwise) with its own canonical; per-variant draft-to-canvas; panel drafting
knows storyContext and can tag a specific look.

- [x] `api/adaptation.py` `write_metadata`: pass **flat keys** to
      `library.sync_entity_tags` — for each character, `variant_entity_key(slug, k)`
      per variant (a record with no variants still contributes its base slug so the
      character tag never disappears). Names map: base → record.name; non-base →
      `f"{record.name} ({label or key})"`.
- [x] `status()` canonical seeding: seed per-variant flat keys from each variant's
      `activeAssetId or assetIds[0]` (was base-only).
- [x] `api/canvas_nodes.py` `spawn_from_character_variant`: node tags =
      `("comic-adaptation", "character-sheet", slug, flat_key)` (flat key only when
      non-base) — base canonical auto-attaches while the variant sheet is being made,
      variant canonical auto-attaches for its own regenerations.
- [x] New endpoint `POST /api/projects/{slug}/characters/{character_slug}/variants/{variant_key}/draft-to-canvas`
      (routes/characters.py → `adaptation.draft_character_variant_to_canvas`,
      returns AdaptationCanvasImportResponse). Delete the `character-sheet` branch of
      `import_artifact_to_canvas` (+ `resolve_character_flat_link`; keep
      `variant_entity_key`; `resolve_character_variant_key` needed by panel validation).
- [x] `api/story_panels.py` `validate_panel_entities`: accept flat variant keys in
      `characterSlugs` (valid set = all `variant_entity_key(slug, k)`).
      `draft_panel_to_canvas` + `attach sourcePanelId` path: no change (registry-driven).
- [x] `api/pi_profiles.py` `_panel_prompt_context_lines`: one line per variant —
      base as today; non-base as `- {flat_key}: [{storyContext}] {prompt-or-label}`
      with instruction to pick the variant slug matching the panel's story moment.
- [x] webui: `api.ts` `draftCharacterVariant(slug, characterSlug, variantKey)`;
      `useCanvasWorkspace` gains `draftCharacterVariantToCanvas` (set canvas, reload,
      focus node — mirror `draftArtifactToCanvas`); hub card Draft = base via new
      endpoint; modal variant cards get a **Draft to canvas** button (disabled until
      prompt non-empty); main.tsx prop wiring updated.
- [x] Tests: new pytest for variant tag sync (tags appear/drop with variants, names
      from label), per-variant canonical seeding, new draft endpoint (404s, 400 no
      prompt, node tags include flat key), panel `characterSlugs` accepting
      `hero-young` and draft-to-canvas pulling the variant canonical; update
      import-artifact tests (character branch gone).
- [x] Verify: backend pytest + `npm run build && npm run test:e2e` (characters.png
      baseline may change if modal/card visuals changed — refresh in same commit).

## Phase C — locations become structured records (+ the missing UI)

Goal: repeat the character recipe for locations; delete the adaptation-files
subsystem and markdown parsing entirely.

Backend:
- [ ] `api/models.py`: `LocationRecord` = slug, name, summary, visualDescription,
      continuityNotes, userTags, `variants: dict[str, EntityVariant]` (base +
      durable states: "after the fire"), createdAt/updatedAt. `LocationCreate`,
      `LocationPatch` (mirror character ones incl. rename + removeVariants).
      `AdaptationMetadata.locations: dict[str, LocationRecord]`, version → 4.
      DELETE: `AdaptationAssetLink`, `AdaptationFileKind/Document/Create/Update`.
- [ ] `api/adaptation.py`: location CRUD mirroring characters
      (`list/create/update/delete_location`, `location_is_extracted`,
      `draft_location_variant_to_canvas`); `write_metadata` passes location flat
      keys + names; `status()` seeds location variant canonicals; counts →
      `locations`/`locationsExtracted`. DELETE: `sync_location_links`,
      `parse_prompt_sections`, `format_prompt_file`, `format_adaptation_file`,
      `prompt_link`, `file_kind_config`, `adaptation_file_path`,
      `adaptation_file_from_link`, `list/create/update/delete_adaptation_file`,
      `import_artifact_to_canvas` (fully — location draft goes through the new
      endpoint), `artifact_link_groups`, location branches of stale-asset sweep
      (use the variant sweep for both kinds). `ensure_adaptation` stops creating
      `locations/` dirs.
- [ ] `api/routes/`: locations router (GET/POST/PATCH/DELETE
      `/api/projects/{slug}/locations`, `POST .../locations/{key}/variants/{vkey}/draft-to-canvas`);
      adaptation.py router drops the files + import-artifact endpoints.
- [ ] `api/canvas_nodes.py` `spawn_from_location` → record + variant based, tags
      `("comic-adaptation", "location-prompt", key, flat_key?)`.
- [ ] `api/story_panels.py`: `locationSlug` validation accepts location flat keys.
- [ ] Tools (`photo-web.ts`): `register_location {name, summary}`,
      `list_locations {}`, `update_location {slug, …}` — clone character tools.
- [ ] Profiles (`pi_profiles.py`): `discover-locations`, `extract-location`
      (target), `extract-all-locations`, `refine-location` (target+instructions) —
      clone the character plans/prechecks/delivery checks; generalize helpers
      (`_registered_characters` → parameterized by kind) rather than copy-paste.
      `AgentSessionKind`/`PiTaskProfile` updated. `_suggest_concept_plan` location
      context lines switch from locations/index.md + prompts dir to registered records.
- [ ] Skills: `discover-locations`, `extract-location`, `refine-location` SKILL.md —
      location sheet prompt rules (wide establishing shot, camera height, lighting,
      no characters in frame, no text/labels; variants state only the visual delta).
- [ ] Delete `.pi/skills/concept-location` references to locations/index.md if any.

Frontend (the missing surface):
- [ ] Extend the Characters view into a two-section hub: "Characters" grid (as
      today) + "Locations" grid below with the same card anatomy (thumb from
      location-tagged nodes, Extract-when-empty, Draft, state). Toolbar gains
      "Find locations" / "Extract all locations" (or a segmented pair — keep it
      one toolbar row; label the buttons explicitly, no icon-only).
- [ ] Generalize `CharacterEditModal` → parameterized entity modal
      (`kind: 'character'|'location'`): locations hide Performance notes; task
      profiles + API calls passed in/branched by kind. Keep file name or rename to
      `EntityEditModal.tsx`.
- [ ] `api.ts` location CRUD + draft methods; `types.ts` LocationRecord etc.;
      delete AdaptationFile* types + api methods (unused by UI — verified).
- [ ] `main.tsx` wiring; view title likely stays "Characters" (nav rename deferred — decide during implementation).
- [ ] e2e seed.ts: check whether it seeds locations/adaptation files; refresh baselines for the two-section layout.

Tests & data:
- [ ] Rewrite location parts of `test_api.py` (adaptation-files tests → /locations
      CRUD; import-artifact test → variant draft endpoints; entity-tag asserts for
      location flat keys). `test_pi_runtime.py`: location profile tests cloned from
      character ones (precheck/skip/live tool/fails-without-tool; extract-all
      labels). `test_adaptation_workflow.py`: suggest-location context lines test.
- [ ] Real data: delete `adaptation/locations/` dirs from cupcake/tom/farm-comic (believed empty of md files — verify); cupcake metadata.locations is empty, so no rescue expected.
- [ ] Docs: ARCHITECTURE.md (module map, storage layout, pi seam tool list,
      profiles list), user-guide.md §4/§5 (locations flow through the same hub).
- [ ] Verify: full backend pytest; `npm run build && npm run test:e2e` with
      baseline refresh; grep sweep:
      `grep -rn "AdaptationAssetLink\|adaptation/files\|sync_location_links\|parse_prompt_sections" api webui/src .pi` → zero hits.

## Commit sequencing

1. Phase A+B together (one backend+frontend commit is acceptable if small, else
   A backend commit then B backend+frontend commit). Baselines refreshed with any
   pixel change, noted in message.
2. Phase C as its own commit (large; backend + tools/skills + UI + baselines).

## Post-phase checklist (run after EVERY phase)

- `.venv/bin/python -m pytest api/test_api.py api/test_adaptation_workflow.py api/test_pi_runtime.py api/test_pi_session_trace.py -q`
- `cd webui && npm run build && npm run test:e2e` (refresh baselines in-commit when pixels change)
- Update THIS FILE's checkboxes + status notes.

## Progress log

- 2026-07-07: plan written; starting Phase A.
- 2026-07-07: Phase A done — EntityVariant slim schema (label/storyContext/prompt/assetIds/activeAssetId), derived variant_status, tools/skills/UI/tests updated, cupcake variants stripped. 119 backend tests + tsc green. Starting Phase B.
- 2026-07-07: Phase B done — per-variant entity tags + canonicals, variant draft endpoint (import_artifact character branch deleted), panel flat-key validation, variant-aware panel context, per-variant Draft buttons in modal. 124 backend tests + build + e2e green (no pixel change). Committing A+B, then Phase C.
