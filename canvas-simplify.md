# canvas-simplify.md — One node, one purpose

Status: plan (2026-07). Companion to [ARCHITECTURE.md](ARCHITECTURE.md).
Per [AGENTS.md](AGENTS.md), every change here is a clean breaking change: no
compatibility shims, no schema versioning. Local canvas data gets regenerated or
hand-fixed once.

---

## 1. The model, stated plainly

**A canvas node is an image.** That's the whole concept.

- Every node holds a **prompt**, generation **settings**, and a list of
  **reference images** it looks at.
- A node that hasn't been generated yet simply **has no picture** — that's what
  "draft" means. Draft is a *state*, not a different kind of thing.
- Generating from a node adds the result(s) to that node's **stack of takes**.
  One take is active (displayed, used as a reference by others). The stack is
  "attempts at the same image"; the node is the image.
- Every generated take permanently records which images were fed in as
  references. The arrows on the board are drawn from those records — **ancestry
  is a birth certificate, never an editable arrow**.

**Tags exist for exactly one reason: consistency.** Image generation doesn't
keep a character/scene/style consistent across images unless you feed it
reference images. So:

- You tag an image as *character X* / *scene Y* / *style Z*.
- One tagged image per entity is marked **canonical**.
- Whenever anything generates an image involving that entity (a panel, a
  concept, a riff), the canonical image is pulled in as a reference —
  automatically.

User tags additionally exist for plain organization/filtering. That's it.
Nothing else on a node changes its nature; there are no special node species.

Everything below is the demolition list for the machinery that currently
contradicts these two paragraphs.

---

## 2. What dies

### 2.1 Text cards — delete entirely

The "child text" feature is a prompt card in a costume: it's created from
another draft, copies its text, renders as an editable note, carries generation
settings it never uses, and sits outside the lineage system (its "child of X"
link is a bespoke label, not an ancestry record). Decision: **remove, no
replacement.**

Delete end to end:

- The "Create child text" action and its sidebar button
  (`webui/src/canvas/useCanvasWorkspace.ts` → `createChildTextArtifact`,
  `webui/src/canvas/sidebars.tsx`).
- The `text-result` role, the `text-result` system tag, and every rendering
  branch keyed on them (`webui/src/canvas/nodes.tsx`, `roles.ts`, `graph.ts`).
- The `text-result-node` CSS in `webui/src/styles/canvas.css`.
- Backend: the `text-result` branch of the role model in `api/models.py` and
  any validation that admits it.

### 2.2 The two node types — collapse to one

Today `canvas.json` stores `type: "draft" | "imageGroup"`, and the two types
have drifted into each other: image groups still carry prompt/params/refs so
they can regenerate; empty image groups render as prompt cards; the frontend
maintains parallel data shapes and a conversion layer full of `??` fallbacks.

Target shape — **one node record**:

```jsonc
{
  "id": "...",
  "x": 0, "y": 0, "width": null,
  "displayName": "",
  "prompt": "",
  "params": { /* model, aspectRatio, imageSize, seed, batchCount */ },
  "refs": ["assetId", ...],          // reference images for the NEXT generation
  "tags": [],                        // user + entity tags
  "assetIds": [],                    // the stack of takes; empty = draft state
  "activeAssetId": null,
  "visualStyleId": null,
  "origin": null                     // see 2.5
}
```

- `assetIds: []` **is** the draft state. No `type` field.
- One Pydantic model replaces the draft/imageGroup union in `api/models.py`;
  one TypeScript node-data shape replaces the draft/imageGroup union in
  `webui/src/canvas/types.ts`.
- One React node component with two visual states (no picture yet → prompt
  card; picture → image card) replaces the two components in
  `webui/src/canvas/nodes.tsx`.
- `flowDocument.ts` conversion collapses to a near-passthrough; most of its
  fallback logic exists only to bridge the two shapes.

### 2.3 Roles — remove the field

Current roles: `text-result` (dies with 2.1), `generated-result` and
`refinement` (vestigial labels nothing meaningfully depends on — verify and
delete), and `style-ref-source` (deletion protection for archetype nodes —
replaced in 2.4). After that the `role` field is empty machinery. **Delete the
field** from `canvas.json`, `api/models.py`, `webui/src/canvas/types.ts`, and
`roles.ts`.

The rule "can this node be deleted?" becomes a *derived* question with one
answer: **a node is protected iff its active image is some tag's canonical
image** (see 2.4). No stored flag.

### 2.4 System tags as behavior switches — replace with the canonical pointer

Tags currently do double duty: entity tags do the consistency job (correct!),
but system tags (`archetype`, `generated`, `character-sheet`,
`concept-character`, `concept-location`, `text-result`, ...) act as hidden
type markers that change rendering, deletability, and generation routing. That
reintroduces node species through the back door.

Target:

- **Two tag kinds only**: user tags (organization) and entity tags
  (character / location / style — the consistency machinery).
- Each entity tag record in the tag registry (`tags.json`) gains
  `canonicalAssetId: string | null`. "Canonical" is a pointer *owned by the
  tag*, not a costume worn by the node.
- Reference resolution ("get me consistent refs for character X") reads
  `tag.canonicalAssetId`. Today this lives in `adaptation.json` +
  `api/style_refs.py` conventions; consolidate to the registry and have
  adaptation code read/write through it (`api/library.py` owns the registry).
- Badges in the UI ("Character concept", "Scene archetype") become *derived
  labels* from entity tags, not branches on system tags.
- System tags that only marked provenance (`generated`) or species
  (`character-sheet`) are deleted; anything still reading them is refactored to
  ask a real question (does it have takes? which entity tags does it carry?).

The style archetypes (character/scene) become ordinary nodes carrying a
**style entity tag** whose canonical pointer references their active image.
The separate projection machinery (`api/style_refs.py` →
`sync_style_ref_canvas_nodes`, the undeletable role, the dedicated
generate-style-ref endpoint) shrinks to: seed the two style tags + their prompt
files on project init, and let generation flow through the one normal path
with the style tag attached. *(This is the riskiest cut — phased last, see §4.)*

### 2.5 "Sibling", origin pointers, and the two generate buttons

- **"Sibling" is renamed to what it is: "Duplicate as draft."** It creates a
  new node prefilled with the source take's prompt/refs/settings. No
  relationship is recorded because none exists. (If a recorded relationship is
  ever wanted, it falls out of lineage anyway: duplicates share parents.)
- **`sourcePanelId` and `sourceConceptCardId` merge into one field:**
  `origin: { kind: "panel" | "conceptCard", id } | null` — "which domain
  object spawned this node," used for auto-attaching results back (panels) and
  for cleanup semantics (concept cards). One concept instead of two
  special-cased strings (`api/story_panels.py`, `api/concept_cards.py`,
  `api/library.py` attach logic).
- **One Generate action.** Today "generate" (draft path) and "generate
  variants" (image-group path) are separate handlers with separate payload
  assembly. With one node type there is one action: *generate from this node's
  prompt+refs+settings; results join the stack; the newest take becomes
  active.* The two handlers in `useCanvasWorkspace.ts` merge.

### 2.6 The variant-stack rule — make it statable

One sentence, enforced everywhere: **everything generated *from* a node lands
in that node's stack; a new node exists only when the user explicitly creates
one** (new draft, duplicate, connection-drag into empty space, draft-to-canvas
from a panel/concept/character).

Consequences to align:

- **Chat refinements** join the stack of the node whose image was refined
  (they are "attempts at the same image" by definition). Verify
  `api/chat_sessions.py` attaches to the source node rather than minting nodes.
- **Show-archived mode** stops silently swapping the active take. Archived
  takes are simply visible in the stack (dimmed/badged) and flippable; the
  active pointer doesn't lie. This deletes the "patch the node to pretend an
  archived take is active" logic in `flowDocument.ts` and its call sites.
- **Concept-card delete special cases** normalize: deleting a node always
  means the same thing (archive its takes, remove the card); the concept card
  itself is a separate domain object deleted from its own view.

---

## 3. UI alignment (what the user sees after)

- **One card, three visual states**: *draft* (prompt text, dashed frame,
  Generate button), *generating* (spinner overlay), *image* (active take,
  stack pager `2/5` when >1). Badge row derives from entity tags only.
- **One inspector sidebar** for the one node type: prompt, settings, reference
  strip (thumbnails of `refs` with remove ✕), tag editor, stack manager
  (takes with archive/restore/set-active), and actions: Generate, Duplicate as
  draft, Refine in chat, Delete.
- **Canonical is a visible, first-class act**: in the tag editor, tagging an
  image with an entity tag offers "★ Make canonical for X"; the canonical
  image shows a small ★ on its card. Deleting is blocked with "This is the
  canonical image for X — pick a new canonical first."
- **Reference behavior is legible**: dragging from an image to a draft adds a
  ref chip; the draft shows exactly what will be attached at generation time —
  including auto-attached canonical refs for tagged entities, shown as chips
  with a ★ so nothing is invisible magic.
- Concept Art and Characters canvases remain **filtered views of the same
  board** (unchanged), but the filter is now "has this entity-tag kind,"
  with no species tags involved.

---

## 4. Refactor roadmap

Ordered so each phase lands green on its own (`npm run typecheck`, targeted
pytest, `npm run test:e2e`; refresh baselines in the same commit whenever a
phase intentionally changes pixels).

**Phase 1 — Delete text cards.** ✅ Done (committed with this plan). Pure
removal: the create action, sidebar button, `text-result` role (frontend union
+ backend Pydantic model), edge derivation, rendering branches, system tag,
and CSS. Existing `text-result` nodes in local canvases will be rejected by
validation on next save — delete them from `canvas.json` by hand if any exist.

**Phase 2 — One node shape.** ✅ Done. One `CanvasNode` model on both sides
(no `type` field; draft = empty stack), one React Flow card with two visual
states, one `updateNode` patch path, and one Generate action
(`generateFromNode`, with optional param overrides from the takes panel;
the node's `prompt`/`refs`/`params` are the recipe, falling back to the
active take's receipt for pre-unification nodes). Old canvases load as-is —
the stray `type` key is ignored on read and dropped on the next save.
Connection drops now target any node still drafting, not just `draft_`-id
nodes.

**Phase 3 — Kill roles; canonical pointer in the tag registry.** ✅ Done.
`role` is deleted end to end (field, models, `roles.ts`); old data's `role`
keys are ignored on read and dropped on save. Derived replacements:
style-archetype sources = style tags + draft state (deletion protection,
sidebar file-backed UI); generated children = the `generated_<sourceId>` id
convention (edges, variant-fold skip, badges). Entity tags now carry
`canonicalAssetId`, kept in sync by `adaptation.status()` from
character/location records, and panel draft-to-canvas resolves reference
images from the registry. Remaining for later phases: adaptation records
still *write* canonicals (registry is the read path); UI ★ canonical
affordances are §3 work.

**Phase 4 — Origin + naming + stack rule.** ✅ Done (with two explicit
deferrals). `origin: {kind, id}` replaces `sourcePanelId`/`sourceConceptCardId`
(old keys in local data are ignored/dropped — re-draft a panel/concept if an
existing prompt node loses its link). "Create sibling" is now "Duplicate as
draft" in UI and code. Chat refinements join the source node's stack instead
of minting `chat_*` nodes (the standalone-node path remains only for sessions
with no canvas source). Archived mode no longer persists active-pointer swaps
while browsing takes. Deferred to the §3 UI work: the full stack-manager
treatment of archived takes (badged, in-stack) and normalizing the
concept-card delete special case.

**Phase 5 (stretch, separate decision) — Fold style archetypes into ordinary
tagged nodes.** Retire `sync_style_ref_canvas_nodes`, the dedicated style-ref
generation endpoint, and the projection lifecycle in favor of seeded style
tags + the normal generate path. Riskiest phase; do it only after 1–4 have
soaked, and take it as its own branch.

Each phase updates ARCHITECTURE.md's canvas-model section in the same commit;
after Phase 4, that section should read almost verbatim like §1 of this file.
When the plan is fully executed, delete this file — the architecture doc is
the durable home.

---

## 5. What deliberately does not change

- **Lineage records** on generated assets (immutable receipts) and derived
  edges.
- **The tag registry as the consistency mechanism** — this plan *narrows* tags
  to that purpose; it doesn't touch how refs reach the generation API.
- **Panel ⇄ canvas wiring** (`origin` renames the pointer, semantics
  identical) and the pi task profiles — agents keep delivering into panels and
  concept cards exactly as today.
- **Asset storage** (`{id}.json` + `{id}.png`) and the archive model.
