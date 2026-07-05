# pi-idea.md — Making the pi agent the engine of photo-web

Status: proposal (2026-07). Companion to [ARCHITECTURE.md](ARCHITECTURE.md) ("The pi agent seam").
Everything in §1 was verified against the installed pi (`@earendil-works/pi-coding-agent` **0.80.3**,
Homebrew npm install at `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`).

The goal: the app's actual job — extract story elements from a book, design comic panels,
author image prompts, generate and remix images, place results on a page layout — should be
driven conversationally through pi, with results landing **live** in the app's own domain
objects (panels, prompts, concept cards, characters), not in markdown files we parse back.

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
| `abort` (response includes `cancelled`) | Real cancellation of a running turn — the missing piece for a Cancel button. |
| `new_session { parentSession? }` | **Fork/branch a session inside the same pi process.** Today we spawn a fresh `pi --fork <id>` process per task; a warm process can instead host sequential forked sessions. Answers the "warm pool" unknown in ARCHITECTURE.md. |
| `switch_session`, `fork { entryId }`, `clone`, `get_tree` | Session tree navigation — branch a chat from any past entry. |
| `get_entries { since? }` | **Incremental history** — poll only new entries; ideal for reconnect/catch-up in a streaming UI. |
| `steer`, `follow_up`, `prompt { streamingBehavior }` | Send a message **while a turn is running** (steer interrupts, follow_up queues). Chat UX gold. |
| `get_last_assistant_text`, `get_messages` | Cheap final-answer retrieval without event accumulation. |
| `set_model`, `cycle_model`, `set_thinking_level`, `compact`, `bash`, `export_html`, `set_session_name` | Model switching, manual compaction, session-scoped bash, HTML export — all exposed. |

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
`fetch()` our local FastAPI. pi gets domain tools — `create_panels`, `set_panel_image_prompt`,
`create_concept_card` — and "extract story elements" becomes the agent calling structured
APIs, with results appearing in the UI in real time. We get the SDK's main benefit without a
second service.

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
  intermediate output, no cancel, and a timeout risk. This is why chat feels unusable.
- The Agent view is split across two bridged registries (`agent_sessions` + `book_chat_sessions`)
  with hydration rules — confusing surface for what should be one "sessions" concept.

Related but separate: the old phased extraction pipeline was deleted; the surviving flows
(characters, concept art) still communicate through **files** (`characters/<slug>.md`,
`.concept-scratch/*.md`) validated/parsed by `adaptation_workflow/{character_file,concept_art,
validate}.py`. Files-as-API is the second thing Phase 3 replaces (§5).

---

## 3. Target architecture

```
 UI (React)
   │  POST /…/sessions/{id}/messages     (returns immediately)
   │  POST /…/sessions/{id}/abort
   │  GET  /…/sessions/{id}/events       (SSE — live event stream)
   ▼
 FastAPI ──► pi_runtime.PiSessionManager        (in-process, threads)
               ├─ SessionHandle per live session
               │    ├─ subprocess: `pi --mode rpc --session-dir … --skill … --extension …`
               │    ├─ reader thread → event ring buffer (+ seq numbers)
               │    ├─ writer: RpcCommand JSON lines (prompt/steer/abort/new_session/…)
               │    └─ snapshot → sessions/agent-sessions/<id>/session.json  (restart-safe)
               └─ registry: id → handle | terminal snapshot
   ▲
   │  pi extension `.pi/extensions/photo-web.ts` calls back into
   │  http://127.0.0.1:<port>/api/… (create panels, prompts, cards, …)
   └──────────────────────────────────────────────────────────────
```

Design rules:

- **Transport stays `pi --mode rpc`.** The typed contract (§1.2) is the stability guarantee.
  The SDK/sidecar is not needed for tools (§1.3) and would add a service to babysit.
- **One live pi process per active session**, owned by the manager. Long-lived for chat
  sessions (turns are `prompt` commands to the same process — no respawn per message).
  Batch jobs get a process for the job's duration. The read-book context is forked via
  `new_session { parentSession: bookSessionFile }` instead of process-level `--fork` where
  a warm process already exists.
- **Events are the source of truth for the UI.** Every RPC event is appended to a per-session
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

class SessionHandle:
    id: str                # agent-session id (ULID, same registry as today)
    slug: str              # project
    proc: subprocess.Popen # pi --mode rpc
    events: Deque[PiEvent] # ring buffer (e.g. last 2000)
    seq: int
    state: Literal["starting","idle","running","aborting","exited","failed"]
    listeners: list[queue.Queue]   # SSE fan-out
    lock: threading.Lock

class PiSessionManager:
    def open_session(slug, *, fork_from: str | None, title, kind) -> SessionHandle
    def prompt(session_id, message, *, streaming="followUp") -> None   # non-blocking
    def steer(session_id, message) -> None
    def abort(session_id) -> bool
    def events_since(session_id, since_seq) -> list[PiEvent]
    def subscribe(session_id) -> queue.Queue          # for SSE generator
    def run_job(slug, *, title, kind, steps: Callable[[StepRunner], None]) -> str
        # batch flavor: opens a session, runs StepRunner steps on a worker thread,
        # snapshots status JSON, closes the process at the end
    def shutdown() -> None                            # atexit: abort + terminate all
```

Implementation notes:
- The reader/writer threading already exists in `PiRpcClient`; the manager generalizes it:
  instead of `run_task()` owning the whole lifecycle, the handle keeps the process alive and
  routes commands/events. `PiRpcClient` remains for the subprocess-side `StepRunner`
  (see 4.3 transition) until steps run in-process, then its guts fold into the handle.
- Event projection: reuse `adaptation_workflow/events.py::project_event` (clipping,
  `assistant_text`/`tool_start`/`tool_end` shapes) so the SSE payloads match what
  `PiTraceView` already renders.
- Concurrency: `workers`-agnostic — FastAPI runs single-process here (`./run` uses one
  uvicorn); the manager is a process-global singleton. Guard with an env check and document
  "one worker" in ARCHITECTURE.md.

### 4.2 New/changed routes (`api/routes/sessions.py`)

| Route | Change |
|---|---|
| `POST /projects/{slug}/agent-sessions` | Create + open a session (optionally `forkFromBookSession: true`). Replaces implicit creation inside book-chat turns. |
| `POST /projects/{slug}/agent-sessions/{id}/messages` | Enqueue `prompt` (or `steer` when `{steer: true}`); returns `202` immediately. Replaces the blocking `POST /adaptation/book-chats/{id}/turns`. |
| `POST /projects/{slug}/agent-sessions/{id}/abort` | RPC abort; returns `{cancelled}`. New. |
| `GET /projects/{slug}/agent-sessions/{id}/events` | **SSE** (`text/event-stream`), `Last-Event-ID` replay from ring buffer, then live. New. |
| `GET /projects/{slug}/agent-sessions/{id}/trace` | Unchanged (post-hoc full trace from session file). |
| character/concept job start routes | Same URLs; internally `manager.run_job(...)` instead of `start_logged_process`. Status GETs read the manager registry first, snapshot files second. |

### 4.3 What gets deleted/simplified (in order)

1. `book_chat_sessions.append_turn`'s in-request `PiRpcClient` usage → `manager.prompt()`.
   The turn-persistence logic (writing user/assistant turns into `session.json`) moves to an
   `agent_end` listener on the handle.
2. `adaptation_jobs.start_logged_process` + the bash heredoc + `workflow_python()` → gone once
   character/concept/read-book jobs run through `manager.run_job` on threads. The
   `python -m adaptation_workflow` / `python -m book_session_load` CLI entrypoints become
   thin dev-only wrappers or are deleted (AGENTS.md: no compat shims).
3. `agent_sessions` ↔ `book_chat_sessions` bridging: collapse to **one registry**
   (`agent_sessions`) with `kind: "chat" | "read-book" | "character-extract" | "concept-…"`.
   Book-chat documents become plain agent sessions whose turns are derived from the session
   file. Breaking change to stored session docs — acceptable per AGENTS.md.
4. `process_status`/PID checks shrink to the restart-recovery path only.

### 4.4 Verification

- Unit: manager with a **fake pi** (a tiny python stdin/stdout echo script emitting the RPC
  shapes) — covers prompt/abort/event-seq/replay/restart-snapshot without needing pi.
- Integration (skipped when `pi` missing): open session → prompt "reply DONE" with
  `--no-tools` → assert `agent_end` event and SSE delivery; abort mid-turn → `cancelled`.
- Existing pytest suite must stay green; Playwright smoke unchanged (Agent view still renders
  with zero sessions).

---

## 5. Phase 2 — Chat rebuilt on streaming (the unusable one)

UI work in `webui/src/sessions/`, consuming the SSE endpoint:

- **`useSessionStream(slug, sessionId)`** hook: `EventSource` wrapper with `Last-Event-ID`
  reconnect, mapping projected events into a render model
  (`{ turns: [{ user, assistantText (growing), tools: [{name, args, result, state}] }] }`).
- **Live turn rendering:** assistant text streams in as `message_update`/`assistant_text`
  events arrive; tool calls render as compact activity chips (name + clipped args) that
  expand — the visual grammar already exists in `PiTraceView`; reuse its components for
  the live case instead of only post-hoc traces.
- **Composer:** send = `POST …/messages` (never blocks), input stays enabled; while a turn is
  running the send button becomes **Steer** (RPC `steer`) with a secondary "queue as
  follow-up" (`follow_up`). **Cancel** button wired to `/abort`.
- **Session list**: one list (kinds badged: chat / read-book / extraction / concept), status
  dot driven by SSE `state`, rename via `set_session_name`, fork-from-here via `fork {entryId}`
  surfaced as "Branch from this message".
- **Job UX unification:** character extraction and concept generation appear as sessions in
  the same list with the same live event feed — "run extraction" in the Characters hub deep-
  links to its streaming session instead of the log-tail panel.
- Error/empty states per the toast/banner conventions from the facelift; Escape/focus behavior
  from `shared/` hooks.

Redesign note ("back to the drawing board"): the Agent view becomes a two-pane layout —
sessions rail + conversation pane — and the *book* context stops being a separate mode: a
"Chat about the book" action is just `open_session(forkFromBookSession=true)`.

Verification: extend the Playwright smoke with a fake-pi-backed session (the §4.4 fake echoes
a scripted turn), asserting streamed text appears incrementally and Cancel flips state.

---

## 6. Phase 3 — Domain tools: `.pi/extensions/photo-web.ts`

Replace files-as-API with tools-as-API. A project-trusted pi extension registers tools that
call the local REST API (`PHOTO_WEB_API ?? http://127.0.0.1:8787`; the manager passes the
actual port + project slug via env when spawning pi).

### 6.1 Tool surface (v1)

| Tool | Parameters (typebox) | Backing endpoint |
|---|---|---|
| `list_story_panels` | `{}` | `GET /story-panels` (returns ids, order, titles, text, prompt presence) |
| `create_story_panels` | `{ panels: [{ title, storyText, visibleText?, panelKind?, imagePrompt? }] , insertAfterPanelId? }` | `POST /story-panels/panels` (batched loop) |
| `update_story_panel` | `{ panelId, patch: { title?, storyText?, visibleText?, imagePrompts? } }` | `PATCH /story-panels/panels/{id}` |
| `set_panel_image_prompt` | `{ panelId, prompt }` | `PATCH` writing `imagePrompts` (model field exists: `StoryPanelImagePrompt`) |
| `get_book_text` | `{ startOffset?, endOffset? }` | `GET /story-panels/book` (ranged to keep context small — pi usually has the book in its forked session anyway; this is for non-book sessions) |
| `list_characters` / `upsert_character` | character record shapes | `GET/POST/PUT /adaptation/files/characters` |
| `create_concept_card` | `{ subjectKind, displayName, prompt }` | `POST /concept-cards` |
| `list_assets` | `{ tag? }` | `GET /assets` (titles/tags/ids only — never pixels) |
| `generate_image` *(v1.1, gated)* | `{ prompt, refAssetIds?, aspectRatio? }` | `POST /generate` — off by default; enable per-session ("agent may spend Gemini credits") |

Design rules for the extension:
- `promptSnippet` one-liners so the tools appear in pi's *Available tools* section;
  `promptGuidelines` bullets that **name the tool** (per docs: no "this tool" phrasing).
- Every `execute` honors `signal` (abort propagates from RPC `abort` into in-flight fetches)
  and uses `onUpdate` for batch progress ("created 4/8 panels").
- Tool results return compact JSON summaries (ids + titles), not full documents — context
  discipline.
- The extension is pure fetch — no file mutations, so `withFileMutationQueue` is unneeded;
  concurrency safety lives server-side in the API like every other client.

### 6.2 How results reach the UI live

Two complementary channels:
1. The SSE stream already shows `tool_start/tool_end` — the chat pane displays
  "create_story_panels ✓ 8 panels".
2. The affected views need data refresh: add a lightweight **invalidation event** — the API
   bumps a per-project `rev` on mutating endpoints; the SSE stream (or a tiny
   `GET /projects/{slug}/rev` poll piggybacked on tool_end events in the chat UI) triggers
   `useStoryPanelDocument.load()` / `loadProject()`. v1 can simply refresh on `tool_end`
   for tools known to mutate.

### 6.3 What this replaces

- `steps.step_character_list` / `step_character_file` prompting skills to **write files** →
  a session prompt + `upsert_character` tool calls. `character_file.py` parsing/validation
  shrinks to whatever the editable-files UI still needs.
- `.concept-scratch/*.md` + `concept_art.py` validators → `create_concept_card` calls.
- The panel/story-element gap (nothing exists today) → `create_story_panels` (+ per-panel
  prompts), which is the actual product feature that was lost when the phased pipeline died.
- Skills (`.pi/skills/*`) remain for *how to think* (extraction quality guidance); tools
  define *where results go*. `read-book` skill stays as-is.

### 6.4 Trust & safety

- Extension lives in-repo (`.pi/extensions/`), loaded with explicit `--extension` by the
  manager (not discovery), so headless sessions don't depend on project-trust prompts
  (`--no-approve` semantics stay predictable; RPC auto-cancels `extension_ui_request` today —
  keep that behavior).
- Tools hit `127.0.0.1` only; the API already binds localhost. Destructive endpoints
  (delete project/assets) are **not** exposed as tools.

---

## 7. Phase 4 — Close the image loop (panels ⇄ canvas)

With prompts attached to panels (Phase 3), connect generation and placement:

- **Generate from panel:** button (and later a `generate_image` tool call) on a panel with an
  `imagePrompt` → `POST /generate` with the prompt + optional character/style refs (resolved
  via entity tags, the same mechanism the Characters hub uses) → returned asset auto-assigned
  to `panel.assetIds`/`activeAssetId`. `PanelImagePicker` already handles manual pick; this
  adds the direct path.
- **Panel → canvas remix roundtrip:** "Open on canvas" from a panel (create/locate an image
  group for its active asset), remix there (multi-select refs → generate, refine chat), then
  "Send back to panel" (set `activeAssetId`). The canvas side exists; the two navigation
  actions are new.
- **Batch generate:** "Generate all missing panel images" as a manager job with SSE progress
  — the same runtime as Phase 1, no new machinery.

---

## 8. Rejected / deferred alternatives

- **Node sidecar using the SDK** (`createAgentSession` in a long-lived Node service, HTTP/WS
  to FastAPI or the UI): maximal control (in-process events, no stdout framing), but a second
  service to supervise, and duplicated session/registry logic across languages. Revisit only
  if the RPC transport proves limiting (e.g. we need custom `ExtensionUIContext` dialogs or
  per-token latency the line-buffered stdout can't deliver).
- **WebSockets instead of SSE**: chat is server→client streaming; commands are plain POSTs.
  SSE + `Last-Event-ID` replay is simpler and proxy-friendly through Vite.
- **Rebuilding the phased pipeline**: the deleted phases 0–4 baked the workflow into rigid
  stages. The tools+chat model keeps pi's flexibility (steer mid-extraction!) while landing
  results in the same structured objects.

## 9. Risks

| Risk | Mitigation |
|---|---|
| RPC schema drift across pi upgrades | Pin the pi version expectation; the contract is typed upstream — add a startup `get_state` handshake that logs `pi --version` and fails soft with a clear session error. |
| Long-lived pi processes leak (API crash) | Manager `atexit` + startup sweep: kill any recorded PIDs whose start-time matches (mechanism exists in `adaptation_jobs`). |
| SSE through the Vite proxy | Verify `proxy` streams (Vite http-proxy does); fall back to direct API origin in dev if buffering appears. |
| Tool spam / runaway loops | Tools are read/append-only + `promptGuidelines`; `generate_image` gated per session; abort is one click. |
| Single-worker assumption | Document in ARCHITECTURE.md; `./run` already runs one uvicorn. Refuse to start the manager under multi-worker env. |

## 10. Sizing & order

| Phase | Scope | Size | Blocks |
|---|---|---|---|
| 1 | `pi_runtime.py`, SSE + message/abort routes, jobs on manager, registry unification | L (backend) | 2, 3, 4 |
| 2 | streaming chat UI, unified Agent view, cancel/steer | M–L (frontend) | — |
| 3 | `.pi/extensions/photo-web.ts`, tool endpoints where missing, refresh-on-tool_end | M | 4 |
| 4 | panel↔generate↔canvas loop | M | — |

Each phase keeps the standing gates (pytest, `npm run build`, Playwright smoke on committed
baselines) and lands as reviewable commits per AGENTS.md conventions.
