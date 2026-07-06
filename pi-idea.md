# pi-idea.md — Narrow pi agents as the engine of photo-web

Status: proposal (2026-07). Companion to [ARCHITECTURE.md](ARCHITECTURE.md) ("The pi agent seam").
Progress: the PiSessionManager runtime, all task profiles (read-book, character list/extract,
concept suggest, panel prompt draft/refine), the imagen prompt guide, and §6 tools-as-API
(`.pi/extensions/photo-web.ts`, env-scoped tool allow-lists, one-tool-call delivery for the
prompt-authoring and concept-suggest profiles) are implemented. Book chat is removed
(§5 done): `book_chat_sessions.py` + `pi_rpc.py` are deleted and the Agent view is a pi task
dashboard (live SSE-attached task panels + the `agent_sessions` history/trace browser).
Panel↔entity wiring is done: panels carry `characterSlugs`/`locationSlug` (agent-tagged via
`set_panel_image_prompt`, human-editable chips in the panel editor), prompt drafting is
blocked (409) until characters are extracted, and "Draft to canvas" turns a saved panel
prompt into a canvas node whose refs are the tagged entities' canonical assets — the
generated asset auto-attaches back onto the panel via the node's `origin`.
Batch profiles and batch generation are dropped as non-features (2026-07): everything
drafts and generates one at a time, human-reviewed. §6.2's finer-grained invalidation
is implemented (`usePiTask` `onMutation` refreshes the launching view per tool result).
Everything in §1 was verified against the installed pi (`@earendil-works/pi-coding-agent` **0.80.3**,
Homebrew npm install at `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`).

The goal: photo-web is an **AI-augmented** app, not a chat app. The human drives story
adaptation — reads the book, highlights passages, creates panels, arranges pages — and
buttons throughout the UI activate pi for one narrow, well-defined task at a time:
extract the characters from this chapter; draft a full image prompt for this panel;
refine this prompt against feedback. Results land **live** in the app's own domain objects
(panels, prompts, concept cards, characters), not in markdown files we parse back and not
in a chat transcript the user has to mine.

**Explicit non-goal: a "super" pi agent.** There is no general chat surface where one
agent has every tool and the whole project in context. We run open-source (weaker) models;
a do-anything agent with 15 tools and a sprawling system prompt is exactly how those models
fail. Instead: many small agents, each doing one thing well.

---

## 0. Product philosophy — narrow agents, human-led workflow

### 0.1 The shape of every pi interaction

Every pi activation in the app follows the same pattern:

1. **A human clicks a specific button** ("Extract characters", "Draft prompt for this
   panel", "Refine"). There is no free-form entry point that could dispatch to anything.
2. The backend assembles a **task profile**: a task-specific system context, the *minimal*
   set of domain tools for that task (usually 2–5), and only the context slices the task
   needs (surrounding panels, the character list, the scene — never "the whole project").
3. pi runs the task to completion (or the user cancels). Output goes through structured
   tool calls into domain objects the UI already renders.
4. The user reviews/edits the result in the normal UI. Iteration is a *new* narrow task
   (e.g. "refine this prompt: too dark, emphasize the fog"), not a continuing open
   conversation.

### 0.2 Why narrow (the weak-model argument)

- **Tool budget.** Local/open models degrade quickly past a handful of tools. A
  prompt-drafting agent gets `get_panel_context` + `set_panel_image_prompt`, not the full
  catalog. Tool selection errors mostly disappear when there's almost nothing to select.
- **Context budget.** Each task profile injects only what the task needs. The
  prompt-drafter sees ±N surrounding panels, the characters *appearing in this panel*,
  the scene notes, and the imagen prompt guide — not the book. The extractor sees a
  chapter range, not the panel layout.
- **Evaluability.** "One agent, one job" means each agent's output is checkable against a
  concrete artifact (a character record, a prompt string) and each task profile can be
  tuned/swapped (different model, different skill) independently.
- **No steering machinery needed.** With short, single-purpose runs, mid-turn `steer` /
  `follow_up` UX is unnecessary. We keep exactly two run controls: watch progress and
  **Cancel** (RPC `abort`).

### 0.3 Human-led vs. agent-led (division of labor)

| Step | Owner | pi's role |
|---|---|---|
| Reading the book, choosing what becomes a panel | **Human** (highlight → create panel) | none |
| Character / scene / prop extraction | pi (per chapter/range, human-triggered) | **primary use case** — populate structured records the human then curates |
| Panel image prompt authoring | pi (per panel, human-triggered) | **primary use case** — read surrounding panels + characters + scene, draft a full verbose imagen prompt |
| Prompt refinement | pi (human gives short feedback, pi revises) | rewrite one prompt with feedback applied |
| Image generation | Human clicks generate (Gemini) | none in v1 (`generate_image` tool stays deferred) |
| Page layout, panel ordering, visible text | **Human** | none |

Panel *creation* is explicitly human-led. Agents never create or delete panels in v1;
they annotate the panels the human made (prompts, character links, scene tags).
`create_story_panels` as an agent tool is deferred (§6.5) — if it ever ships it is its own
narrow "propose panels for this passage" task with human review, not a chat capability.

### 0.4 The agent catalog (v1)

Each row is a **task profile**: a named configuration of skill/system context + tool
subset + context slices. Profiles live in the backend (constants next to the manager),
so a button maps to a profile id, nothing more.

| Profile | Trigger (UI) | Context injected | Tools | Output |
|---|---|---|---|---|
| `read-book` | Adaptation setup | book text (existing flow) | none | warm forked session other extractors branch from |
| `extract-characters` | Characters hub → "Extract" (per chapter/range) | forked book session or chapter slice | `list_characters`, `upsert_character` | character records |
| `extract-scenes` | Scenes list → "Extract" | chapter slice, existing scene list | `list_scenes`, `upsert_scene` | scene/location records |
| `extract-props` | Props list → "Extract" | chapter slice, existing prop list | `list_props`, `upsert_prop` | prop records (new, small model — same shape as locations) |
| `draft-panel-prompt` | Panel editor → "Draft prompt" | this panel's story text, ±N surrounding panels, characters appearing (records + canonical look prompts), scene record, **imagen prompt guide** (§0.5), active visual style | `get_panel_context`, `set_panel_image_prompt` | verbose imagen-ready prompt on the panel |
| `refine-panel-prompt` | Panel editor → "Refine" + one-line feedback | current prompt, the feedback, prompt guide, same panel context | `set_panel_image_prompt` | revised prompt |
| `draft-concept-prompt` | Concept art view → "Draft" | character/location record, prompt guide, visual style | `create_concept_card` | concept card prompt |

Batch profiles are a **non-feature**: drafting and generating stay one-at-a-time,
human-reviewed. No `batch-draft-prompts`, no batch generation (decision 2026-07).

Notes:
- Extraction profiles fork the read-book session (`new_session { parentSession }`) so the
  model already "knows" the book without re-injecting it. Prompt-drafting profiles do
  **not** — they run cold with a small assembled context, which is cheaper and keeps weak
  models focused.
- Every profile's tool list is passed to pi explicitly (extension registers all tools;
  the task profile's system context names the allowed ones **and** the manager rejects
  out-of-profile tool calls server-side — see §6.4).

### 0.5 The imagen prompt guide

Prompt quality is the product. Every prompt-authoring profile injects
`api/prompt_guides/imagen.md` (new, versioned in-repo): a distilled guide to what the
specific image API we call (Gemini image generation via `gemini.py`) responds well to —
subject-first phrasing, camera/lens vocabulary, lighting terms, composition directives,
how to reference character appearance consistently, what it ignores, prompt length sweet
spot, negative-prompt caveats. The guide is:

- **Model-specific and swappable** — if we change image backends, we swap the guide file,
  not the agents.
- Injected as task context (not a pi skill) so it's versioned with the code that calls
  the API, and testable: unit tests assert profiles include it.
- Paired with a required output shape in the profile context: subject → action →
  setting → characters (canonical descriptors) → style → composition/lighting, so drafts
  are structurally consistent across panels.

---

## 1. What pi actually provides (verified)

### 1.1 The npm package is a real SDK, not just a CLI

`package.json` exports `.` → `dist/index.js` with first-class programmatic APIs:

- **`AgentSession`** / `createAgentSession` / `AgentSessionConfig` / `AgentSessionEvent` /
  `AgentSessionEventListener` / `PromptOptions` / `SessionStats` — host an agent session
  in-process (Node).
- **`SessionManager`** — session files, forks, trees, compaction entries. This is the same
  format `api/pi_session_trace.py` parses off disk, now confirmed as a first-class API.
- **`RpcClient`, `RpcCommand`, `RpcResponse`, `RpcSessionState`, `runRpcMode`** — the
  `--mode rpc` protocol is an **exported, typed contract** (`dist/modes/rpc/rpc-types.d.ts`),
  not an internal detail. Our Python `PiRpcClient` speaks a published surface.
- `defineTool`, `createCodingTools`, `loadSkills`, extension runtime, etc.

Implication: the SDK is Node/TypeScript. Our backend is Python. Using the SDK directly means
a long-lived Node sidecar. **We don't need it for anything below** — but it's the documented
escalation path (§8).

### 1.2 The RPC protocol is much richer than what we use

`api/adaptation_workflow/pi_rpc.py` today uses exactly four commands: `get_state`, `prompt`,
`get_session_stats`, `abort` (as cleanup). The published protocol also includes:

| Command | Why it matters for us |
|---|---|
| `abort` (response includes `cancelled`) | Real cancellation of a running task — the missing piece for a Cancel button. |
| `new_session { parentSession? }` | **Fork/branch a session inside the same pi process.** Today we spawn a fresh `pi --fork <id>` process per task; a warm process can instead host sequential forked sessions. Answers the "warm pool" unknown in ARCHITECTURE.md. |
| `switch_session`, `fork { entryId }`, `clone`, `get_tree` | Session tree navigation (post-hoc trace/debugging use for us; not a user-facing feature). |
| `get_entries { since? }` | **Incremental history** — poll only new entries; ideal for reconnect/catch-up in a streaming UI. |
| `get_last_assistant_text`, `get_messages` | Cheap final-answer retrieval without event accumulation. |
| `set_model`, `set_thinking_level`, `compact`, `bash`, `export_html`, `set_session_name` | Model switching per task profile, manual compaction, HTML export — all exposed. |

(`steer` / `follow_up` / `prompt { streamingBehavior }` also exist for mid-turn
interaction; per §0.2 we deliberately don't build UX on them.)

Events stream as JSON lines on stdout alongside responses (we already consume
`agent_start/turn_start/message_update/tool_execution_*/agent_end` via
`adaptation_workflow/events.py` projections).

### 1.3 Extensions can register LLM-callable tools — no SDK/sidecar required

From `docs/extensions.md`: extensions are TypeScript modules loaded by the pi process itself
(`--extension <path>`, or auto-discovered under `.pi/extensions/` with project trust). They can:

- **Register custom tools the model can call**: `pi.registerTool({ name, description,
  promptSnippet, promptGuidelines, parameters: Type.Object({...}), async execute(toolCallId,
  params, signal, onUpdate, ctx) { ... } })` — typebox-schema'd parameters, cancellation via
  `signal`, streaming progress via `onUpdate`.
- Intercept tool events, inject context, add slash commands, control TUI rendering.

**This is the headline.** The tool executes inside the pi (Node) process and can simply
`fetch()` our local FastAPI. pi gets domain tools — `upsert_character`,
`set_panel_image_prompt`, `create_concept_card` — and each narrow task becomes the agent
calling structured APIs, with results appearing in the UI in real time. We get the SDK's
main benefit without a second service.

### 1.4 Resolved unknowns from ARCHITECTURE.md

| Unknown | Answer |
|---|---|
| Does pi ship a programmatic API? | Yes — Node SDK (§1.1). No Python SDK; no server mode. |
| Is the `--mode rpc` schema documented/stable? | Yes — exported typed contract (§1.2). |
| Cancellation in RPC mode? | Yes — `abort`, plus per-tool `AbortSignal` inside extensions. |
| Can one pi process host multiple sessions (warm pool)? | Sequentially, yes — `new_session`/`switch_session`/`fork`. Not concurrent turns per process; concurrency = multiple processes. |
| Session file format stability? | `SessionManager`/`SessionEntry` are exported types; `pi_session_trace.py` parses a public shape. |

---

## 2. Current state (what's wrong with the seam)

Two invocation paths exist today (see ARCHITECTURE.md):

**A. Async jobs** — character list/extract, concept generation, read-book:
```
route → adaptation_jobs.start_logged_process
      → detached `bash -lc "cd api && python -m adaptation_workflow <cmd> …"`
      → runner.py / steps.py → PiRpcClient → `pi --mode rpc` subprocess
```
Problems:
- **Three-layer subprocess sandwich** (bash → python CLI shim → pi) exists only because jobs
  must survive detachment from the request; status flows through *files*
  (`run-<stage>-status.json`, log, launcher log) plus a bash heredoc that patches the return
  code. Fragile, unobservable, and `workflow_python()`/login-shell env are packaging hazards.
- **No cancellation.** Once launched, a job can only be awaited or killed by hand.
- **No live events to the UI.** The UI polls a status endpoint that re-reads a growing log
  file (`process_status` truncates at 400 KB); progress is "tail the log".
- **One process per pi task.** Every character extraction re-forks the book session into a
  fresh `pi` process (Node startup + session load each time).

**B. Sync chat turns** — `book_chat_sessions.append_turn`:
- Runs `PiRpcClient.run_task()` **inside the FastAPI request**. A pi turn can take minutes;
  the HTTP request (and a worker) blocks the whole time; the UI shows "Sending…" with no
  intermediate output, no cancel, and a timeout risk.
- Beyond the mechanics, the book-chat feature itself is off-strategy per §0: an open-ended
  chat with the whole book in context is the "super agent" shape we're moving away from.
  It gets **retired**, not rebuilt (§5). The Agent view's two bridged registries
  (`agent_sessions` + `book_chat_sessions`) collapse with it.

Related but separate: the old phased extraction pipeline was deleted; the surviving flows
(characters, concept art) still communicate through **files** (`characters/<slug>.md`,
`.concept-scratch/*.md`) validated/parsed by `adaptation_workflow/{character_file,concept_art,
validate}.py`. Files-as-API is the second thing Phase 3 replaces (§6).

---

## 3. Target architecture

```
 UI (React) — task buttons all over the app
   │  POST /…/tasks                      { profile, targetIds, feedback? } → 202 + taskId
   │  POST /…/tasks/{id}/abort
   │  GET  /…/tasks/{id}/events          (SSE — live event stream)
   ▼
 FastAPI ──► pi_runtime.PiSessionManager        (in-process, threads)
               ├─ TaskHandle per running task
               │    ├─ task profile → context assembly + tool allow-list
               │    ├─ subprocess: `pi --mode rpc --session-dir … --extension …`
               │    ├─ reader thread → event ring buffer (+ seq numbers)
               │    ├─ writer: RpcCommand JSON lines (prompt/abort/new_session/…)
               │    └─ snapshot → sessions/agent-sessions/<id>/session.json  (restart-safe)
               └─ registry: id → handle | terminal snapshot
   ▲
   │  pi extension `.pi/extensions/photo-web.ts` calls back into
   │  http://127.0.0.1:<port>/api/… (upsert characters, set prompts, cards, …)
   └──────────────────────────────────────────────────────────────
```

Design rules:

- **Transport stays `pi --mode rpc`.** The typed contract (§1.2) is the stability guarantee.
  The SDK/sidecar is not needed for tools (§1.3) and would add a service to babysit.
- **One live pi process per running task**, owned by the manager, closed when the task
  ends. Extraction tasks fork the warm read-book session via
  `new_session { parentSession: bookSessionFile }` where a warm process exists; prompt
  tasks start cold with assembled context (§0.4).
- **Task profiles are the unit of configuration.** Profile = system context template +
  context assemblers + tool allow-list + model/thinking-level. Buttons post a profile id
  and target ids; the backend owns everything else.
- **Events are the source of truth for the UI.** Every RPC event is appended to a per-task
  ring buffer with a monotonically increasing `seq`. SSE clients replay from `Last-Event-ID`
  and then follow live. On restart, history comes from the session file
  (`get_entries` shape ≈ what `pi_session_trace.py` already parses).
- **Status files remain as snapshots, not as the mechanism.** The manager periodically writes
  the same `AdaptationWorkflowStatus`-compatible JSON so an API restart reports "interrupted"
  instead of a stale "running" (keeps the PID+start-time check from `adaptation_jobs.py` for
  the crash case only).
- **Cancellation** = RPC `abort` (graceful, mid-turn) with process-group terminate as the
  fallback after a timeout.

---

## 4. Phase 1 — Pi runtime foundation (backend)

### 4.1 New module: `api/pi_runtime.py`

```python
class PiEvent(TypedDict):
    seq: int
    ts: str
    event: dict            # raw RPC event or projected form (events.py projections)

class TaskHandle:
    id: str                # task id (ULID, same registry as today)
    slug: str              # project
    profile: str           # task profile id (§0.4)
    proc: subprocess.Popen # pi --mode rpc
    events: Deque[PiEvent] # ring buffer (e.g. last 2000)
    seq: int
    state: Literal["starting","running","aborting","done","failed","cancelled"]
    listeners: list[queue.Queue]   # SSE fan-out
    lock: threading.Lock

class PiSessionManager:
    def run_task(slug, *, profile: str, target_ids: list[str],
                 feedback: str | None = None) -> TaskHandle
        # assembles profile context, opens/forks a session, prompts,
        # closes the process at agent_end
    def abort(task_id) -> bool
    def events_since(task_id, since_seq) -> list[PiEvent]
    def subscribe(task_id) -> queue.Queue          # for SSE generator
    def shutdown() -> None                         # atexit: abort + terminate all
```

Implementation notes:
- The reader/writer threading already exists in `PiRpcClient`; the manager generalizes it:
  instead of `run_task()` owning the whole lifecycle, the handle keeps the process alive and
  routes commands/events. `PiRpcClient` remains for the subprocess-side `StepRunner`
  (see 4.3 transition) until steps run in-process, then its guts fold into the handle.
- Task profiles live in `api/pi_profiles.py`: per-profile system context template, context
  assembler functions (pull panels/characters/scenes/prompt-guide slices), allowed tool
  names, model settings. Pure data + functions; unit-testable without pi.
- Event projection: reuse `adaptation_workflow/events.py::project_event` (clipping,
  `assistant_text`/`tool_start`/`tool_end` shapes) so the SSE payloads match what
  `PiTraceView` already renders.
- Concurrency: `workers`-agnostic — FastAPI runs single-process here (`./run` uses one
  uvicorn); the manager is a process-global singleton. Guard with an env check and document
  "one worker" in ARCHITECTURE.md.

### 4.2 New/changed routes (`api/routes/sessions.py`)

| Route | Change |
|---|---|
| `POST /projects/{slug}/pi-tasks` | Start a task: `{ profile, targetIds, feedback? }` → `202 { taskId }`. One endpoint for every pi button in the app. |
| `POST /projects/{slug}/pi-tasks/{id}/abort` | RPC abort; returns `{cancelled}`. New. |
| `GET /projects/{slug}/pi-tasks/{id}/events` | **SSE** (`text/event-stream`), `Last-Event-ID` replay from ring buffer, then live. New. |
| `GET /projects/{slug}/pi-tasks/{id}` | Status snapshot (state, profile, targets, timing) for non-streaming consumers. |
| `GET /projects/{slug}/agent-sessions/{id}/trace` | Unchanged (post-hoc full trace from session file — the debugging window into any past task). |
| `POST /adaptation/book-chats/{id}/turns` | **Deleted** with the book-chat feature (§4.3). |
| character/concept job start routes | Same URLs become thin aliases for `POST /pi-tasks` with the matching profile, or are replaced outright (breaking change fine per AGENTS.md). |

### 4.3 What gets deleted/simplified (in order)

1. **Book chat, wholesale**: `book_chat_sessions.py`, its routes, and the chat pane of the
   Agent view. Off-strategy (§0); nothing to migrate. The Agent view becomes a task
   history/trace viewer (§5).
2. `adaptation_jobs.start_logged_process` + the bash heredoc + `workflow_python()` → gone once
   character/concept/read-book jobs run through `manager.run_task` on threads. The
   `python -m adaptation_workflow` / `python -m book_session_load` CLI entrypoints become
   thin dev-only wrappers or are deleted (AGENTS.md: no compat shims).
3. Registry collapse: **one registry** (`agent_sessions`) whose records are tasks
   (`profile`, `targetIds`, timing, state, session file pointer). Breaking change to stored
   session docs — acceptable per AGENTS.md.
4. `process_status`/PID checks shrink to the restart-recovery path only.

### 4.4 Verification

- Unit: manager with a **fake pi** (a tiny python stdin/stdout echo script emitting the RPC
  shapes) — covers prompt/abort/event-seq/replay/restart-snapshot without needing pi.
- Unit: profile assembly — each profile builds the expected context (e.g.
  `draft-panel-prompt` includes surrounding panels, this panel's characters, the imagen
  guide) and the expected tool allow-list.
- Integration (skipped when `pi` missing): run a task → prompt "reply DONE" with
  `--no-tools` → assert `agent_end` event and SSE delivery; abort mid-turn → `cancelled`.
- Existing pytest suite must stay green; Playwright smoke unchanged (Agent view still renders
  with zero sessions).

---

## 5. Phase 2 — Task-run UX (replaces "chat rebuilt on streaming")

There is no chat to rebuild — the deliverable is a **reusable task-run surface** that any
button in the app can summon, plus a task history in the Agent view.

UI work in `webui/src/sessions/` (+ small hooks used from other feature dirs):

- **`usePiTask(slug)`** hook: `start(profile, targetIds, feedback?)` → holds
  `{ taskId, state, events }` via an `EventSource` wrapper with `Last-Event-ID` reconnect.
  Events map to a render model of `{ assistantText (growing), tools: [{name, args,
  result, state}] }`.
- **`PiTaskPanel`** component: an inline/slide-over panel showing live progress — streaming
  assistant text, tool-call activity chips (name + clipped args, expandable — reuse
  `PiTraceView`'s visual grammar), a **Cancel** button, terminal state (done / failed with
  error / cancelled). Embeddable next to the button that launched it: the panel editor
  shows it under the prompt field; the Characters hub shows it in place of the old
  log-tail panel.
- **Refine affordance:** prompt fields get a one-line feedback input + "Refine" button →
  `start('refine-panel-prompt', [panelId], feedback)`. This is the *entire* iteration UX —
  no composer, no threads.
- **Agent view = task history:** one list of past/running tasks (profile badge, targets,
  status dot, duration), click-through to the live panel or the post-hoc trace
  (`PiTraceView`). Book-chat UI is removed.
- **On-completion refresh:** when a task's SSE stream reports `tool_end` for a mutating
  tool (or terminal `done`), the launching view reloads its data
  (`useStoryPanelDocument.load()`, character list reload). v1 keeps this simple:
  refresh-on-terminal-state.
- Error/empty states per the toast/banner conventions from the facelift; Escape/focus
  behavior from `shared/` hooks.

Verification: extend the Playwright smoke with a fake-pi-backed task (the §4.4 fake echoes
a scripted run), asserting streamed text appears incrementally, the target object updates
on completion, and Cancel flips state.

---

## 6. Phase 3 — Domain tools: `.pi/extensions/photo-web.ts`

Replace files-as-API with tools-as-API. A project-trusted pi extension registers tools that
call the local REST API (`PHOTO_WEB_API ?? http://127.0.0.1:8787`; the manager passes the
actual port + project slug via env when spawning pi).

The extension registers the **full** tool catalog once; which tools a given task may use is
decided per task profile (§6.4). Tools are deliberately fine-grained so profiles can compose
tiny surfaces.

### 6.1 Tool surface (v1), grouped by the agents that use them

**Extraction agents** (`extract-characters` / `extract-scenes` / `extract-props`):

| Tool | Parameters (typebox) | Backing endpoint |
|---|---|---|
| `list_characters` | `{}` | `GET /adaptation/files/characters` (names + one-line summaries only) |
| `upsert_character` | character record shape (name, aliases, physical description, wardrobe variants, first appearance) | `POST/PUT /adaptation/files/characters` |
| `list_scenes` / `upsert_scene` | scene record shapes (name, location, time-of-day, mood, key visual details) | scene endpoints (extend existing locations) |
| `list_props` / `upsert_prop` | prop record shapes | new, mirrors locations |

**Prompt-authoring agents** (`draft-panel-prompt` / `refine-panel-prompt` / `draft-concept-prompt`):

| Tool | Parameters (typebox) | Backing endpoint |
|---|---|---|
| `get_panel_context` | `{ panelId, radius? }` | `GET /story-panels/…` — returns this panel's story text, ±radius neighbor summaries, characters appearing (with canonical look descriptors), scene record. One call, one focused payload — the agent doesn't assemble context from four list-tools. |
| `set_panel_image_prompt` | `{ panelId, prompt }` | `PATCH /story-panels/panels/{id}` writing `imagePrompts` (model field exists: `StoryPanelImagePrompt`) |
| `create_concept_card` | `{ subjectKind, displayName, prompt }` | `POST /concept-cards` |

**Shared / rarely allowed:**

| Tool | Parameters | Backing endpoint |
|---|---|---|
| `get_book_text` | `{ startOffset?, endOffset? }` | `GET /story-panels/book` (ranged; only for extraction profiles running cold without a forked book session) |

### 6.2 How results reach the UI live

Two complementary channels (both implemented):
1. The SSE stream already shows `tool_start/tool_end` — the task panel displays
  "upsert_character ✓ Ishmael".
2. The affected views refresh their data on terminal task state, and `usePiTask`
   additionally fires `onMutation` on each successful `tool_end` so multi-target
   tasks (extract-all-characters) refresh the launching view as each result lands.

### 6.3 What this replaces

- `steps.step_character_list` / `step_character_file` prompting skills to **write files** →
  an `extract-characters` task + `upsert_character` tool calls. `character_file.py`
  parsing/validation shrinks to whatever the editable-files UI still needs.
- `.concept-scratch/*.md` + `concept_art.py` validators → `create_concept_card` calls.
- The missing panel-prompt feature (nothing exists today) → `draft-panel-prompt` /
  `set_panel_image_prompt`, which is the actual product feature that was lost when the
  phased pipeline died.
- Skills (`.pi/skills/*`) remain for *how to think* (extraction quality guidance); the
  imagen prompt guide (§0.5) covers *how to write for the image model*; tools define
  *where results go*. `read-book` skill stays as-is.

### 6.4 Per-profile tool scoping (enforcement, not vibes)

The extension registers everything, but a weak model must not even *see* irrelevant tools:

- The manager passes the profile's allow-list to the extension via env
  (`PHOTO_WEB_ALLOWED_TOOLS=get_panel_context,set_panel_image_prompt`); the extension
  registers **only** those tools for that process. Out-of-list tools don't exist in the
  system prompt — the strongest form of scoping.
- Belt-and-suspenders: the API can additionally check a per-task capability token
  (task id header) against the profile's allow-list, so a confused agent (or stale
  extension) can't call endpoints outside its task.
- Destructive endpoints (delete project/assets/panels) are never registered as tools.

### 6.5 Deferred tools (deliberately not in v1)

- `create_story_panels` / `update_story_panel` beyond prompts — panel creation is
  human-led (§0.3). Revisit only as a standalone "propose panels" profile with explicit
  human review UX.
- `generate_image` — spending image credits stays a human click. If it ships, it is
  per-task gated, never a standing capability.
- `list_assets` — no current profile needs it.

### 6.6 Trust & safety

- Extension lives in-repo (`.pi/extensions/`), loaded with explicit `--extension` by the
  manager (not discovery), so headless tasks don't depend on project-trust prompts
  (`--no-approve` semantics stay predictable; RPC auto-cancels `extension_ui_request` today —
  keep that behavior).
- Tools hit `127.0.0.1` only; the API already binds localhost.

---

## 7. Phase 4 — Close the image loop (panels ⇄ canvas)

With prompts attached to panels (Phase 3), connect generation and placement — all
human-triggered, no agent involvement:

- **Generate from panel:** button on a panel with an `imagePrompt` → `POST /generate` with
  the prompt + optional character/style refs (resolved via entity tags, the same mechanism
  the Characters hub uses) → returned asset auto-assigned to
  `panel.assetIds`/`activeAssetId`. `PanelImagePicker` already handles manual pick; this
  adds the direct path.
- **Panel → canvas remix roundtrip:** "Open on canvas" from a panel (create/locate an image
  group for its active asset), remix there (multi-select refs → generate, refine chat), then
  "Send back to panel" (set `activeAssetId`). The canvas side exists; the two navigation
  actions are new.
Batch generation is a **non-feature** (see §0.4): every generation is a single
human click on a single panel or node.

---

## 8. Rejected / deferred alternatives

- **A general chat agent ("super pi")**: one session with every tool and the whole project
  in context. Rejected on strategy (the app is button-driven AI augmentation, §0) and on
  capability (open-source models degrade with large tool catalogs and sprawling context).
  Book chat, its two-registry bridge, and steer/follow-up UX all fall away with it.
- **Node sidecar using the SDK** (`createAgentSession` in a long-lived Node service, HTTP/WS
  to FastAPI or the UI): maximal control (in-process events, no stdout framing), but a second
  service to supervise, and duplicated session/registry logic across languages. Revisit only
  if the RPC transport proves limiting (e.g. we need custom `ExtensionUIContext` dialogs or
  per-token latency the line-buffered stdout can't deliver).
- **WebSockets instead of SSE**: task progress is server→client streaming; commands are
  plain POSTs. SSE + `Last-Event-ID` replay is simpler and proxy-friendly through Vite.
- **Rebuilding the phased pipeline**: the deleted phases 0–4 baked the workflow into rigid
  stages. Narrow task profiles keep flexibility (any button, any order, human curates
  between steps) while landing results in the same structured objects.
- **Agent-led panel creation**: deferred (§6.5). The human's read of the story *is* the
  adaptation; agents annotate.

## 9. Risks

| Risk | Mitigation |
|---|---|
| RPC schema drift across pi upgrades | Pin the pi version expectation; the contract is typed upstream — add a startup `get_state` handshake that logs `pi --version` and fails soft with a clear task error. |
| Long-lived pi processes leak (API crash) | Manager `atexit` + startup sweep: kill any recorded PIDs whose start-time matches (mechanism exists in `adaptation_jobs`). |
| Weak model produces bad/malformed prompts | Structured output shape in the profile context (§0.5); `set_panel_image_prompt` validates length/emptiness server-side; human always reviews in the panel editor; Refine loop is one click. |
| Profile context too big for local models | Context assemblers have explicit budgets (e.g. ±2 panels, char records truncated to look descriptors); budgets are constants in `pi_profiles.py`, tuned per model. |
| SSE through the Vite proxy | Verify `proxy` streams (Vite http-proxy does); fall back to direct API origin in dev if buffering appears. |
| Tool spam / runaway loops | Tiny per-profile tool surfaces (§6.4) + `promptGuidelines`; abort is one click. |
| Single-worker assumption | Document in ARCHITECTURE.md; `./run` already runs one uvicorn. Refuse to start the manager under multi-worker env. |

## 10. Sizing & order

| Phase | Scope | Size | Blocks |
|---|---|---|---|
| 1 | `pi_runtime.py` + `pi_profiles.py`, task routes (start/abort/SSE), jobs on manager, registry unification, book-chat removal | L (backend) | 2, 3, 4 |
| 2 | `usePiTask` + `PiTaskPanel`, task-history Agent view, refine affordance, cancel | M (frontend) | — |
| 3 | `.pi/extensions/photo-web.ts`, per-profile tool scoping, `get_panel_context` + prompt endpoints, imagen prompt guide | M | 4 |
| 4 | panel↔generate↔canvas loop | M | — |

Each phase keeps the standing gates (pytest, `npm run build`, Playwright smoke on committed
baselines) and lands as reviewable commits per AGENTS.md conventions.
