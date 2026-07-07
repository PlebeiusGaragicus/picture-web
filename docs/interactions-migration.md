# Spec: Migrating image generation from `generateContent` to the Interactions API

Status: draft / proposal — no code changes yet.
Owner: —
Last updated: 2026-07-07 (docs verified against ai.google.dev as of this date).

## 1. Summary

Google's Gemini API now leads with the **Interactions API**
(`client.interactions.create`) as the recommended interface; the
`generateContent` path we use today is labeled **Legacy** in the image
generation docs. `generateContent` "remains fully supported" with **no
announced sunset date**, so this migration is not urgent — but new
capabilities (server-side conversation state, background execution, typed
streaming steps, search grounding) ship on Interactions only, and the gap
will widen.

This spec covers what a migration means for photo-web's two provider call
sites, what we gain, what we lose (notably **seed**), and a phased plan that
keeps `generateContent` as a fallback behind a flag.

**Recommendation:** adopt Interactions for the chat-refinement path first
(where server-side state genuinely simplifies our code), keep single-shot
canvas generation on `generateContent` until the seed question (§6.1) is
resolved, and hide the whole thing behind one provider-boundary flag.

## 2. Current architecture (what has to change)

All Google traffic goes through one module, `api/gemini.py` — this is the
entire migration surface. Two call sites:

### 2.1 Single-shot generation — `gemini.generate_image()`

Used by canvas draft nodes via `library.create_generated_assets()`
(`api/routes/canvas.py` → `api/library.py`).

```python
response = client.models.generate_content(
    model=resolved_model,
    contents=[prompt_text, *parent_pil_images],
    config=types.GenerateContentConfig(
        response_modalities=["IMAGE"],
        seed=seed,                              # incremented per batch item
        image_config=types.ImageConfig(
            aspect_ratio=resolved_aspect_ratio,  # e.g. "16:9"
            image_size=resolved_image_size,      # "512" | "1K" | "2K" | "4K"
        ),
    ),
)
```

Notable properties:

- **Seed is load-bearing**: the UI exposes a seed field
  (`GenerationParams.seed`), and batch generation (`batchCount`) increments
  the seed per item to get distinct-but-reproducible variants.
- Reference images (character/location sheets, parent nodes) are passed as
  PIL images in `contents`, capped by `reference_image_limit()` (3 / 11 / 14
  per model).
- Failure taxonomy (`describe_generation_failure`) inspects
  `prompt_feedback.block_reason` and `candidates[0].finish_reason` to
  classify `safety` / `blocked` / `empty` → HTTP 422 vs 502.
- `serialize_response_metadata()` persists the (stripped) provider response
  next to the asset for provenance.

### 2.2 Chat refinement — `gemini.send_chat_turn()`

Used by `api/chat_sessions.py` for the multi-turn image-refinement panel.

```python
contents = [*history, {"role": "user", "parts": message_parts}]
config = GenerateContentConfig(
    response_modalities=["TEXT", "IMAGE"],
    image_config=ImageConfig(aspect_ratio=..., image_size=...),
    thinking_config=ThinkingConfig(thinking_level=..., include_thoughts=...),
)
```

Notable properties:

- **History is client-side and locally owned.** `ChatSessionDocument`
  persists the full provider history in the library, with image bytes
  stored as blob refs and expanded to base64 per request
  (`provider_history_for_request`). Sessions survive restarts, API-key
  changes, and arbitrary time gaps.
- **Thought signatures** are captured from response parts and replayed in
  history (`ChatImagePart.thought_signature`) — a `generateContent`-specific
  mechanism for preserving thinking context across turns.
- The UI constrains `thinkingLevel` to `minimal` / `high`.

## 3. The Interactions API in brief

An **Interaction** is a stored, server-side record of one complete turn:
input, typed execution steps (thoughts, tool calls, model output), and
output. GA since June 2026. Supported in `google-genai` **≥ 2.3.0** (we are
on **2.8.0** — no SDK upgrade required, though a bump is advisable to pick
up Interactions fixes).

```python
interaction = client.interactions.create(
    model="gemini-3.1-flash-image",
    input=[
        {"type": "text", "text": prompt_text},
        {"type": "image", "data": b64_png, "mime_type": "image/png"},
    ],
    response_format={
        "type": "image",
        "mime_type": "image/png",
        "aspect_ratio": "16:9",
        "image_size": "1K",
    },
    generation_config={"thinking_level": "minimal"},
    store=True,           # default; required for chaining
)
png_bytes = base64.b64decode(interaction.output_image.data)

# Multi-turn refinement — no history replay:
followup = client.interactions.create(
    model="gemini-3.1-flash-image",
    input="Make the sky stormy",
    previous_interaction_id=interaction.id,
    response_format={"type": "image", "aspect_ratio": "16:9"},
)
```

Key semantics:

- **State**: `previous_interaction_id` chains turns server-side. Only the
  conversation history carries over; `tools`, `system_instruction`, and
  `generation_config` are interaction-scoped and must be re-sent each turn.
- **Retention**: stored interactions are kept **55 days (paid tier)** /
  **1 day (free tier)**. `store=False` opts out but forbids chaining.
- **Output**: single image via `interaction.output_image` (base64);
  interleaved text+images by iterating `interaction.steps` for
  `model_output` steps and their `content` blocks.
- **Streaming**: SSE with typed `step.delta` events (including
  `type: "thought"`), replacing `streamGenerateContent`.
- **Background**: `background=True` runs the interaction async; poll/fetch
  by id.

## 4. Field-by-field mapping

| Today (`generateContent`) | Interactions | Notes |
|---|---|---|
| `contents=[text, PIL images]` | `input=[{"type":"text",...}, {"type":"image","data":b64,"mime_type":...}]` | We must base64-encode instead of handing PIL objects to the SDK. |
| `contents=[*history, new_turn]` | `previous_interaction_id` | No documented way to pass a full history array as `input`. See §6.2. |
| `config.response_modalities=["IMAGE"]` | `response_format={"type":"image", ...}` | Modality moves out of config. |
| `config.response_modalities=["TEXT","IMAGE"]` | omit strict `response_format`; read interleaved steps | Chat panel case. |
| `config.image_config.aspect_ratio` | `response_format.aspect_ratio` | Same values. |
| `config.image_config.image_size` | `response_format.image_size` | Same values (`"512px"` naming appears in docs for 0.5K — verify exact literal at implementation time; `generateContent` accepts `"512"`). |
| — | `response_format.mime_type` | New: `image/jpeg` now available (smaller files). We keep PNG for the library pipeline. |
| `config.seed` | **no equivalent documented** | See §6.1. |
| `config.thinking_config.thinking_level` | `generation_config={"thinking_level": ...}` | Same values (`minimal` default / `high`). Thinking cannot be disabled and is billed. |
| `config.thinking_config.include_thoughts` | thoughts arrive as typed steps / stream deltas | Better than today: structured, not part-flag-driven. |
| thought signatures replayed in history | not needed | Server-side state preserves thinking context; signatures are a legacy-path concept. |
| `prompt_feedback` / `finish_reason` parsing | `interaction.status` + step inspection | Failure taxonomy must be re-mapped (§7.3). |
| response object → `serialize_response_metadata` | interaction object (has stable `id`) | Persist `interaction.id` in asset provenance — it is also a server-side receipt. |

## 5. New capabilities unlocked

1. **Server-side multi-turn state.** The chat-refinement panel no longer
   needs to re-upload every prior image every turn. Today a 10-turn session
   re-sends up to 10 base64 images per request; with chaining each turn
   sends only the new message. Faster turns, lower ingress, lower token
   cost (Interactions also does "more efficient context caching across
   turns" per docs).
2. **Background execution** (`background=True`). Natural fit for
   `batchCount > 1` canvas generation: fire N interactions, poll, attach as
   they land. Removes our long-request timeout exposure on 4K generations.
3. **Typed streaming steps.** The chat panel can render live thought
   summaries and progress (we already have UI patterns for this in
   `PiTraceView`).
4. **Search grounding** (`tools=[{"type":"google_search"}]`, plus
   `image_search` on 3.1 Flash). Optional idea: concept-art profiles could
   ground on real reference imagery ("draw X in the style of a 1920s
   Moscow tram"). Not needed for core panel generation.
5. **Video input** (3.1 Flash): out of scope for this app.
6. **Interaction ids as provenance.** Cheap, durable receipt per
   generation while within retention.

## 6. Losses, risks, and open questions

### 6.1 Seed / reproducibility — the blocker

The Interactions API documents **no `seed` parameter**. Our canvas flow
stores a seed per draft, exposes it in the UI, and increments it per batch
item. Under Interactions:

- Identical re-runs produce different images (arguably fine — users mostly
  want *a* good image, and "regenerate" is already treated as a reroll).
- Batch items no longer need seed offsets (each call is independently
  random anyway).

Options:

- **(a)** Keep single-shot generation on `generateContent` until seed lands
  in Interactions (if ever). Zero user-facing change. **Recommended
  initially.**
- **(b)** Migrate and drop the seed field from `GenerationParams`, the UI,
  and receipts. Honest, but destroys a documented UI affordance and stored
  `GenerationReceipt.seed` semantics.
- **(c)** Migrate and keep seed as write-only provenance (recorded, not
  honored). Misleading; not recommended.

Note: even today, seed on the image models is only best-effort —
`generateContent` documents `seed` generically and does not commit to
determinism for image output. That weakens the case for blocking on (a)
forever; revisit after Phase 1 telemetry.

### 6.2 Chat history ownership vs. server retention

Our chat sessions are **locally owned and durable**; Interactions state is
**remote and expiring** (55 days paid / 1 day free — and this app is run by
hobbyists who may be on free tier). If we chain via
`previous_interaction_id` alone:

- A session resumed after retention expiry breaks.
- Switching API keys orphans all chains.
- `store=True` means prompts *and* images persist on Google's side for the
  retention window — a real privacy-posture change for a local-first app
  (§8).

The migration guide shows **no way to replay a full client-side history
array as `input`**, so we cannot simply keep today's model on the new API.

**Design: hybrid chaining with local re-seed.** Keep
`ChatSessionDocument` as the source of truth (unchanged schema, plus a new
`lastInteractionId` + `interactionExpiresAt`). Each turn:

1. If `lastInteractionId` is fresh → chain with `previous_interaction_id`,
   send only the new user parts.
2. If missing/expired/rejected → **re-seed**: send one interaction whose
   `input` is the new user parts *plus* the current source image and a
   compact recap (latest image + prompt summary), not the full turn-by-turn
   history. Store the new id and continue chaining.

This accepts that a re-seeded session has coarser memory than a chained
one. In practice the panel is image-centric — the latest image carries most
of the state — so this is acceptable. The full local history remains for
UI display regardless.

### 6.3 Reference-image limits differ (again)

The Interactions image doc states "up to 14" mixed reference images but
also cites per-model figures (10 for 3.1 Flash in one passage; 6
high-fidelity objects + 5 characters for 3 Pro). These numbers have already
shifted once during the 3.x rollout. Action: re-verify at implementation
time and update `reference_image_limit()`; keep it model-keyed as today.

### 6.4 Error taxonomy re-mapping

`describe_generation_failure()`'s inputs (`prompt_feedback.block_reason`,
`finish_reason`) don't exist on interactions. We must map from
`interaction.status` + step content to our `safety` / `blocked` / `empty`
categories (which drive HTTP 422 vs 502 and user-facing copy). The doc
does not fully enumerate failure statuses — expect an empirical pass
against the live API, and keep the category strings stable so the frontend
is untouched.

### 6.5 Miscellaneous

- **Thinking is always on and billed** on the image models via
  Interactions. Cost per image rises slightly at `minimal`; expose the
  existing thinking dropdown unchanged.
- **Mixed-model chains**: if a session switches models mid-chain, the new
  model must support the prior outputs as inputs. All three image models
  accept image input, so this is fine, but guard model switches through a
  re-seed (§6.2) to be safe.
- **`_safe_json` / receipt serialization** must learn the interaction
  object shape (`model_dump` should still work — the SDK returns pydantic
  models — but verify byte-field stripping still catches inline base64).
- **SDK surface check**: confirm `client.interactions` exists and is GA-
  stable in our pinned `google-genai==2.8.0`; bump if the GA namespace
  landed later than 2.3.0's preview shape.

## 7. Migration plan

Everything stays inside `api/gemini.py` (plus small `chat_sessions.py`
changes for chaining). No route, frontend, or store schema changes except
the two new chat-session fields.

### Phase 0 — groundwork (no behavior change)

- Add `NANO_BANANA_API=generate_content|interactions` env switch (default
  `generate_content`) read alongside the existing `NANO_BANANA_*` vars.
- Extract a thin internal interface so both paths return today's
  dataclasses: `GeneratedImage` and `ChatTurnResult` are the contract; the
  rest of the app must not know which API produced them.
- Add the two fields to `ChatSessionDocument` (`lastInteractionId`,
  `interactionExpiresAt`), unused for now.

### Phase 1 — chat refinement on Interactions

- Implement `send_chat_turn` via `interactions.create` with hybrid
  chaining (§6.2). `store=True` for this path only (chaining requires it);
  surface a settings note about retention (§8).
- Map interleaved output steps → `ChatTurnResult(text, images, ...)`.
  Drop thought-signature plumbing on this path (harmless to keep the
  fields; they'll be `None`).
- Optional follow-up: SSE streaming of thought/step deltas into the panel.

Rationale for going chat-first: it's the path where Interactions is a real
simplification (no history re-upload), it has no seed dependency, and its
blast radius is one panel.

### Phase 2 — single-shot generation on Interactions

- Gate on the seed decision (§6.1). If accepted: `generate_image` via
  `interactions.create` with `store=False` (no chaining needed; don't
  retain user content), `response_format={"type":"image", mime_type:
  "image/png", aspect_ratio, image_size}`, reference images base64-inlined.
- Persist `interaction.id` (when stored) into the receipt; keep
  `GenerationReceipt` shape otherwise.
- Optional follow-up: `background=True` for `batchCount > 1`.

### Phase 3 — cleanup

- Once both paths have soaked, flip the default flag; delete the
  `generateContent` code path, `thinking_config`/`ImageConfig` usage, and
  thought-signature history plumbing; drop or repurpose the seed UI per
  §6.1 decision.

## 8. Privacy & data-handling implications

This is the biggest non-technical change. Today, `generateContent` calls
are transient; with Interactions:

- `store=True` (default, required for chaining) keeps prompts, reference
  images, and outputs on Google's servers for **55 days (paid) / 1 day
  (free)**.
- Book excerpts flow into panel prompts, and character sheets flow in as
  reference images — for copyrighted source material, users should know
  this is retained server-side.

Policy adopted by this spec: **`store=False` everywhere except the chat
panel**, and a one-line disclosure in the chat panel/settings ("Refinement
sessions are retained by Google for up to 55 days"). If that's
unacceptable, chat can also run `store=False` at the cost of falling back
to re-seed on every turn (still functional; loses cross-turn nuance).

## 9. Test plan

- **Unit (offline, faked SDK)**: interaction-response parsing (single
  `output_image`, interleaved steps, no image → each `describe_*` category),
  hybrid chaining state machine (fresh id / expired id / rejected id /
  model switch → re-seed), input assembly (base64 parts, ref-image caps),
  receipt serialization of interaction objects. Mirror the existing
  `test_api.py` fake-provider patterns; both flag values run through the
  same suite.
- **Contract (live, manual, one-off)**: one real call per model ×
  {1K/2K, with/without refs, chained turn}, plus one deliberately unsafe
  prompt to observe the real blocked-status shape (feeds §6.4).
- **E2E**: `/verify` skill run against the flagged-on stack — draft a
  panel prompt, generate, refine in chat panel, confirm auto-attach.

## 10. Decision log / open items

| # | Question | Leaning | Status |
|---|---|---|---|
| 1 | Drop seed vs. hold Phase 2 until parity | Hold initially; drop if Interactions never adds seed (it's best-effort today anyway) | open |
| 2 | Full-history replay possible as `input`? | Docs say no; design assumes re-seed recap instead | needs live confirmation |
| 3 | `store` policy | `False` everywhere except chat; disclose retention | proposed |
| 4 | Ref-image caps per model under Interactions | Re-verify at implementation; update `reference_image_limit()` | open |
| 5 | SDK pin | Verify `interactions` namespace on 2.8.0; bump to latest 2.x regardless | open |
| 6 | `image_size` literal for 0.5K (`"512"` vs `"512px"`) | Verify against SDK enum at implementation | open |
