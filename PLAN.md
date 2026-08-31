# PLAN.md — AgentFlow Build Playbook

> **How to use:** Execute phases **top to bottom**. Do one phase, run its **Verification**,
> confirm every **Definition of Done** box, then **stop at the gate** and wait for "continue".
> Read [CLAUDE.md](CLAUDE.md) first for guardrails.
>
> Each phase: **Objective → Tasks → Files → Tests → Verification (commands) → Definition of Done (gate).**

---

## Legend / conventions

- `web/` = Next.js app (editor + API + DB) · `worker/` = execution engine (agent runners + GitHub).
- ⛔ = a gate you must not cross until green.
- "Paste output" = run it, copy the real terminal result into your gate report.
- **Mock by default**: agent (whichever runner the node names) and GitHub (Octokit) calls go through injected interfaces so tests never hit the network or spend tokens. See [docs/TESTING.md](docs/TESTING.md).

---

## 🎯 MVP milestone = end of Phase 7

Phases **0–7** deliver the agreed MVP: **the Kanban board + the visual editor + node config + ONE working end-to-end agent loop, driven from a card** — drag a card into "In progress" → agents plan and implement in a workspace clone → a branch is pushed, a PR opened → the card moves itself to "Review" with the PR attached. **Phases 8–12** expand it (multi-agent team, recurring work, deploys, hardening, packaging). Stop and celebrate at the Phase 7 gate; the user decides whether to continue.

**The board is the product's front door** ([docs/BOARD.md](docs/BOARD.md)): a Task is the unit of work, a Pipeline is the recipe, a Run is the card in motion. A full day's work should be possible without opening the canvas.

---

## Phase 0 — Bootstrap & tooling

**Objective:** An empty but fully wired monorepo: web app boots, worker process runs, DB migrates, all test runners execute, CI stub exists.

**Tasks**
1. Init git: `git fetch origin` and branch from remote main if a remote exists; else `git init`. **Do not commit** (git policy).
2. Monorepo layout per [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): root `package.json` with npm workspaces `["web", "worker"]` + a shared `packages/core` for types/logic used by both.
3. Scaffold **`web/`**: `create-next-app` (Next 16, App Router, TS, Tailwind 4, ESLint, src-dir, `@/*` alias) — mirror Portfoliov4.
4. Scaffold **`worker/`**: a TS Node project (tsx/tsup or ts-node) with an entrypoint that starts, connects to the DB, logs "worker ready", and idles.
5. Set up **`packages/core`**: shared TypeScript types + Zod schemas (Pipeline, Node, Edge, Run) consumed by web + worker.
6. DB: add **Prisma + SQLite**; create an initial migration for a trivial table; `prisma generate` + `migrate` succeed.
7. Test tooling: **Vitest** in `web`, `worker`, `packages/core`; **Playwright** in `web` (`npx playwright install`).
8. Root scripts: `dev:web`, `dev:worker`, `test`, `test:core`, `test:web`, `test:worker`, `lint`, `e2e`.
9. ESLint + Prettier in each workspace.
10. `.github/workflows/ci.yml` **stub** running `lint` + `test` on push/PR.
11. `.gitignore`, `.env.example` — the app's own config only: `DATABASE_URL`, `SECRETS_ENC_KEY` (used to encrypt stored keys), and optionally `GITHUB_TOKEN`/`GITHUB_WEBHOOK_SECRET`. **Do NOT put AI model API keys here** — those are entered per pipeline in-app and stored encrypted (`ProviderCredential`). The runner passes each pipeline's key to the SDK explicitly; it must not rely on a global `ANTHROPIC_API_KEY` env var.

**Files:** root `package.json`, `web/**`, `worker/**`, `packages/core/**`, `prisma/**`, `.github/workflows/ci.yml`, `.gitignore`, `.env.example`.

**Tests:** one trivial passing test per workspace (`sanity.test.ts`).

**Verification**
```bash
npm run lint
npm test                    # all workspaces' sanity tests pass
npx prisma migrate status   # migrations applied
npm run dev:web             # serves localhost:3000, then stop
npm run dev:worker          # prints "worker ready", then stop
```

**⛔ Definition of Done**
- [ ] `npm test` passes across web/worker/core.
- [ ] `npm run lint` clean.
- [ ] Web dev server serves the default page; worker starts and connects to the DB.
- [ ] Prisma migration applied; `.env.example` documents every required var (no secrets committed).
- [ ] CI stub exists and mirrors the local commands.

---

## Phase 1 — Domain model & persistence

**Objective:** The work-tracking + pipeline data model and a tested repository layer. This is the backbone everything else builds on.

**Tasks**
1. Define the schema in Prisma per [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): **`Board`, `BoardColumn`, `Task`, `TaskEvent`** (the work-tracking half — see [docs/BOARD.md](docs/BOARD.md)) plus `Pipeline`, `PipelineNode`, `PipelineEdge`, `Run` (**with `taskId`**), `RunStep`, `LogEntry`, `Secret`, `ProviderCredential` (the per-pipeline AI model API keys), `Variable`. Migrate.
2. Mirror the domain types + **Zod schemas** in `packages/core` (single source of truth for validation).
3. Repository functions (`web/src/data/`): CRUD for **boards, columns, and tasks** (incl. `moveTask(taskId, columnId, order)` and `appendTaskEvent`), CRUD for pipelines (with nodes/edges), create/read runs + steps, append logs, get/set secrets & variables.
3b. **Fractional ordering** helper (pure, in core): `orderBetween(prev?, next?) → number` so a drag-reorder writes **one** row, never renumbers a column. Tested for repeated inserts at the same slot (precision floor → renormalize).
3c. **Board reconciler decision function** (pure, in core): `nextColumn(run, column) → columnId | null` implementing `autoAdvance` (`onRunSucceeded` / `onRunFailed` / `onPrMerged`). No DB, no clock — fully unit-tested here, used by the worker in Phase 7.
4. **Secrets & per-pipeline provider keys** stored **encrypted at rest** (AES-GCM with `SECRETS_ENC_KEY`) — both the global `Secret` store (GitHub/deploy tokens) and each pipeline's `ProviderCredential` (AI model API keys). Repository returns decrypted only on explicit in-memory read; never logs values. See [docs/SECURITY.md](docs/SECURITY.md).
5. A **graph validator** (pure, in core): a pipeline is valid iff nodes have unique ids, edges reference existing nodes, there's exactly one trigger, the graph is acyclic (DAG), **and every agent node has a `provider` + `model` set** (via an assigned profile or inline — **no default is ever supplied**). An agent node without a model makes the pipeline invalid and un-runnable.

**Files:** `prisma/schema.prisma`, `packages/core/src/{types,schemas,graph}.ts`, `web/src/data/**`.

**Tests (core + web)**
- Board: create board with default columns (Backlog/Todo/In progress/Review/Done); create task → move between columns → order + `columnId` correct; `TaskEvent` appended on every move.
- `orderBetween`: insert at head/tail/middle; 100 repeated middle-inserts stay strictly ordered.
- `nextColumn`: each `autoAdvance` key routes correctly; a column with no rule returns `null` (card stays put); an unknown outcome never throws.
- Blocked cards: a task with unresolved `blockedBy` is rejected when moved into a `working` column.
- Zod schemas: valid pipeline parses; malformed rejected.
- Graph validator: unique-ids, dangling-edge, missing/duplicate-trigger, cycle, **and an agent node with no provider/model** (must be rejected — no default is filled in) all covered.
- Repository: create pipeline → read back with nodes/edges; run + steps + logs round-trip.
- Secrets + provider keys: stored ciphertext ≠ plaintext; decrypt returns original; a log helper redacts them; a `ProviderCredential` is scoped to its pipeline and unique per provider.
- Pre-run readiness check: a pipeline missing a credential for a provider its agent nodes use is flagged un-runnable (key required for hosted providers; base URL for local).

**Verification**
```bash
npm run test:core
npm run test:web -- src/data
npx prisma migrate status
```

**⛔ Definition of Done**
- [ ] Schema + validation + repository tests pass.
- [ ] Board/Task/TaskEvent round-trip; `orderBetween` and `nextColumn` fully unit-tested (pure, no DB).
- [ ] DAG validator rejects cycles and dangling edges.
- [ ] Secrets are ciphertext at rest and never appear in logs (test proves redaction).

---

## Phase 2 — Pipeline editor (visual canvas)

**Objective:** Build/edit a pipeline visually: drag nodes, connect edges, configure each node (APIs, endpoints, variables), save/load.

> Route note: build it at `(editor)` now; **Phase 3 moves it to `/pipelines`** and makes the board the default surface. The canvas is the *configuration* surface — powerful, but not where the day is spent.

**Tasks**
1. Integrate **React Flow** (`@xyflow/react`) in `web/src/app/(editor)/`: canvas, pan/zoom, add/connect/delete nodes.
2. **Node palette** driven by the node registry in [docs/NODES.md](docs/NODES.md) (data-driven, like DevTools' tool registry — adding a node type = registering it).
3. **Node config panel**: per-node form generated from the node's Zod config schema — set API URLs/endpoints, variables, prompts. For `agent` nodes this includes a **model dropdown**, an **effort** selector, a system prompt, and a tool allowlist (the user picks the AI model/agent for each task). Save into the node's `config`.
4. **Agents library** (⭐ core feature): an "Agents" panel to create/edit reusable **Agent Profiles** (name, model, effort, system prompt, tool allowlist) per [AGENTS.md](docs/AGENTS.md). An `agent` node can **reference a profile** (with optional per-node overrides) or be configured inline. Editing a profile updates referencing nodes; versioning keeps in-flight runs stable.
5. **Connections / API keys panel (per pipeline)** (⭐): the user adds the **API key for each AI provider this pipeline uses** (or a base URL for a local model like Ollama) — stored as an encrypted `ProviderCredential` scoped to the pipeline. Keys are **write-only** (masked after save). The editor shows a pre-run warning if an agent node's provider has no key set on the pipeline.
6. **Pipeline-level variables** editor (define reusable `{{vars}}`).
7. Persist: save the graph + agent profiles + provider credentials to the DB (Phase 1 repositories); load an existing pipeline back onto the canvas.
8. Client validation surfaces the validator's errors inline — can't save/run an invalid graph, and can't run until each used provider has a key (or base URL) set.

**Files:** `web/src/app/(editor)/**`, `web/src/components/editor/**`, `web/src/nodes/registry.ts`.

**Tests**
- Unit: node registry has unique ids + valid config schemas; config-form generator renders required fields; validation errors surface.
- Unit: Agent Profile CRUD; an `agent` node resolves `agentProfileId + overrides` to an effective config; the model dropdown lists available models.
- E2E (Playwright): create an Agent Profile → add trigger + agent node → assign the profile (and change the model on one node) → connect → save → reload → graph + agent config persisted.

**Verification**
```bash
npm run test:web -- src/nodes src/components/editor
npm run e2e -- editor.spec.ts
```

**⛔ Definition of Done**
- [ ] Node registry + config-form tests pass.
- [ ] Agent Profiles can be created and assigned to nodes; per-node model/effort selectable; effective-config resolution tested.
- [ ] E2E: a pipeline (with an agent + chosen model) can be built, configured, saved, and reloaded intact.
- [ ] Adding a node type requires only registering it (no scattered edits).

---

## Phase 3 — 🗂 Task board (the daily driver)

**Objective:** A usable Kanban board **before** any engine exists — add cards, drag them between columns, open a task drawer, edit the brief. At this gate the app is already a decent manual task tracker; Phases 4–7 make the cards move themselves. Full spec: [docs/BOARD.md](docs/BOARD.md).

**Tasks**
1. **Board route as the app's default surface** (`web/src/app/(board)/`) — the canvas moves to `/pipelines`. Opening the app lands you on the board, not the editor.
2. **Columns + cards**: render `BoardColumn`s as tracks with cards ordered by `order`. Seed a default board (Backlog · Todo · In progress · Review · Done) on first run.
3. **Drag and drop** (`@dnd-kit`): move within and between columns → `moveTask` with `orderBetween`; **optimistic update with rollback** if the API rejects (e.g. a blocked card, WIP limit hard-stop).
4. **Quick add** at the top of each column — title only, `Enter` commits, focus stays for the next one. Keep this frictionless; it decides whether the system gets used.
5. **Task drawer** (overlay, not a route change): title, markdown body labelled **"the agent's brief"**, priority, labels, repo, due date, blockedBy. Autosave on blur.
6. **Timeline** in the drawer, reading `TaskEvent` — for now: created, moved, commented. Agent/run events join it in Phase 7.
7. **Column settings**: rename, reorder, set `kind`, set `wipLimit`. The `pipelineId` binding is stubbed in the UI (a disabled "Automate this column" control) and enabled in Phase 7.
8. **Keyboard**: `n` new card · `/` filter · `j`/`k` select · `Enter` drawer · `1`–`9` move to column N. Fully mouse-free.
9. **Filters**: label, priority, repo, text. Filter state lives in the URL so a view is linkable.

**Files:** `web/src/app/(board)/**`, `web/src/components/board/**` (`Column`, `TaskCard`, `TaskDrawer`, `Timeline`, `QuickAdd`), `web/src/app/api/tasks/**`.

**Tests**
- Unit: `TaskCard` renders priority/labels/blocked state; drawer edits call the right repo functions; filter reducer.
- Unit: optimistic move rolls back and restores the original column on a rejected API response.
- E2E (Playwright): quick-add a card → drag it two columns right → reload → it's still there in the right place and order → open the drawer, edit the brief, reload → persisted.
- E2E: a card blocked by an unfinished task cannot be dropped into a `working` column (drop rejected, card returns, reason shown).

**Verification**
```bash
npm run test:web -- src/components/board
npm run e2e -- board.spec.ts
```

**⛔ Definition of Done**
- [ ] The app opens on the board; a card can be created, dragged, edited, and survives reload.
- [ ] Drag-and-drop writes one row (fractional order) and rolls back cleanly on rejection.
- [ ] Keyboard flow works end-to-end without a mouse.
- [ ] Board tests + `board.spec.ts` E2E pass (paste output).

---

## Phase 4 — Execution engine core (the runner)

**Objective:** A deterministic engine that walks a pipeline DAG, passes context/variables between nodes, records run state + logs. Prove it with **no-op nodes** (no agents/GitHub yet).

**Tasks**
1. In `worker/src/engine/`: a **Runner** that topologically orders a pipeline, executes nodes in order, threads a **run context** (variables + prior node outputs) through, and writes `RunStep` + `LogEntry` rows.
2. **Variable interpolation** (pure, in core): resolve `{{ pipeline.vars.x }}`, `{{ trigger.issue.title }}`, `{{ nodes.<id>.output.y }}` against the run context. Fully unit-tested.
3. **Node handler interface**: `run(ctx, config) → output`. A node type = a handler registered by id. Implement two trivial handlers: `manual-trigger` and `echo` (returns its interpolated config).
4. Run lifecycle: `queued → running → (per-step) → succeeded | failed`; a failed step marks the run failed and stops (configurable later).
5. Trigger a run from the web app (enqueue) → worker picks it up (DB-backed queue) → executes → status/logs visible via a run-detail API.

**Files:** `worker/src/engine/**`, `packages/core/src/interpolate.ts`, `worker/src/handlers/{manualTrigger,echo}.ts`, `web/src/app/api/runs/**`.

**Tests**
- Interpolation: nested paths, missing vars (friendly error, no crash), escaping — every documented case.
- Runner: linear graph executes in topological order; context passes A→B; a throwing handler fails the run and records the error.
- Integration: enqueue a 2-node echo pipeline → worker runs it → run row is `succeeded`, steps + logs recorded.

**Verification**
```bash
npm run test:core -- interpolate
npm run test:worker -- engine
# End-to-end (no agents): enqueue an echo pipeline and confirm it completes
npm run test:worker -- engine/run.integration
```

**⛔ Definition of Done**
- [ ] Interpolation + runner tests pass (incl. failure path).
- [ ] An echo pipeline runs end-to-end via the queue; steps + logs persisted.
- [ ] Adding a node handler = registering it against its node id (matches the editor registry).

---

## Phase 5 — Agent node (pluggable runners)

**Objective:** A node type that runs an agent **on whichever provider the node names** in an isolated per-run workspace and returns its output — with logs streamed and tool use gated. **Verify the SDK API against `code.claude.com/docs/en/agent-sdk` before writing** (see [docs/AGENTS.md](docs/AGENTS.md)).

**Tasks**
1. Per-run **workspace manager** (`worker/src/workspace/`): a fresh temp dir per run; cleaned up after. Agents operate only inside it.
2. **Agent handler** (`worker/src/handlers/agent.ts`): resolves the node's **effective agent config** (a referenced Agent Profile merged with per-node overrides, or the inline config — `provider` + `model` **required, no default**; `effort` may default `high`; plus system prompt, allowed tools, input mapping); resolves the **API key from the run's pipeline** (`ProviderCredential` for that provider), decrypted in-memory, passed to the runner at call time (base URL for local providers) → runs the agent in the workspace → captures the result + streams events into `LogEntry`. **If provider/model is missing, or no credential exists for the provider on this pipeline, the handler fails fast with a clear error — it never falls back to a default model or a global/env key.** The user's chosen model/effort/key is honored per node.
3. Wrap every backend behind an **`AgentRunner` interface** (takes `provider`/`model` as data) so tests inject a **mock** (no tokens, no network). The worker selects the runner by `provider`: `claude` uses the Claude Agent SDK, `ollama` and `openai-compat` use the `OpenAICompatibleRunner` so a free local or free-tier model works with no Anthropic account. An unknown provider fails loudly — never a fallback to Claude.
4. **Permission/hook gating**: dangerous tools (Bash, network, writes outside workspace) are gated per [docs/SECURITY.md](docs/SECURITY.md) — deny-by-default for outward/destructive actions; log every tool call.
5. Config surfaces in the editor node panel (Phase 2): role prompt, model, effort, tool allowlist, input variable mapping.

**Files:** `worker/src/handlers/agent.ts`, `worker/src/agent/AgentRunner.ts` (+ mock), `worker/src/workspace/**`.

**Tests**
- With the **mock AgentRunner**: agent node runs, its output lands in the run context, logs are recorded; a simulated tool-denied event is handled gracefully.
- Effective-config resolution: a node referencing an Agent Profile + overrides produces the right `provider`/`model`/`effort`/tools; an inline node works too; a pinned `profileVersion` is honored.
- The `MockAgentRunner` receives the **user-selected model** (e.g. a Haiku node vs an Opus node) — asserts per-node model selection is actually passed through.
- Workspace: created per run, isolated, cleaned up; agent cannot write outside it (path-guard test).
- Config validation: a **missing model/provider fails fast** (no default fallback); a **missing per-pipeline API key for the provider fails fast** (no env/global fallback); effort/tool-allowlist parse correctly.
- Key handling: the resolved API key is passed to the (mock) runner but **never appears in any log/step output** (redaction test).

**Verification**
```bash
npm run test:worker -- handlers/agent workspace
# Optional live smoke (only if ANTHROPIC_API_KEY is set): a trivial agent task in a scratch workspace.
# If no key: state that you verified via the mock and skipped the live call.
```

**⛔ Definition of Done**
- [ ] Agent-node tests pass with the mock runner.
- [ ] Workspaces are isolated + cleaned up; out-of-workspace writes blocked.
- [ ] Tool-use gating enforced and every tool call logged.
- [ ] SDK usage verified against the official Agent SDK docs (note what you confirmed).

---

## Phase 6 — GitHub integration nodes

**Objective:** Nodes that read an issue, create a branch, commit the agent's changes, and open a PR — via **Octokit**, per [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).

**Tasks**
1. **GitHub client** behind a `GitHubClient` interface (real = Octokit; test = mock). Auth via a stored, encrypted token (Phase 1 secrets).
2. Node handlers: `github-issue-trigger` / `read-issue`, `create-branch`, `commit-changes` (commit the workspace diff), `open-pr`. Each maps run-context inputs → GitHub API calls → structured outputs (issue data, branch name, PR url/number).
3. Payload **mappers are pure + unit-tested** (issue JSON → context shape; PR inputs → Octokit params).
4. Real code execution/tests are **delegated to GitHub Actions**: pushing a branch triggers the repo's Actions; a `wait-for-checks` node polls check-run status and returns pass/fail (this is how agents "run tests" without us hosting a sandbox).

**Files:** `worker/src/github/GitHubClient.ts` (+ mock), `worker/src/handlers/github/*.ts`, `packages/core/src/github/mappers.ts`.

**Tests**
- Mappers: issue→context and PR-params round-trips; edge cases (missing body, labels).
- Handlers with the **mock GitHubClient**: create-branch/commit/open-pr produce correct calls + outputs; error responses handled.
- `wait-for-checks`: pending→success and pending→failure polling paths.

**Verification**
```bash
npm run test:core -- github
npm run test:worker -- handlers/github
# Optional live smoke against a throwaway repo only if GITHUB_TOKEN is set; otherwise verify via mock and say so.
```

**⛔ Definition of Done**
- [ ] Mapper + handler tests pass with the mock client.
- [ ] Branch/commit/PR/wait-for-checks handlers produce correct API calls + outputs.
- [ ] Token read from encrypted secrets; never logged.

---

## Phase 7 — 🎯 The golden loop (drag a card → agents work → card returns with a PR)

**Objective:** Join the two halves. Wire Phases 3–6 into **one working end-to-end loop driven from the board** — the MVP. You drag a card into "In progress"; agents plan and implement it in a workspace clone; a branch is pushed and a PR opened; **the card moves itself to "Review" with the PR attached**, and its timeline shows every step.

**Tasks**
1. **Board nodes** ([docs/NODES.md](docs/NODES.md) → Board nodes): implement `task-trigger`, `update-task`, `create-task`, `require-approval` — registry entries + worker handlers.
2. **Board-driven enqueue**: moving a card into a column with `pipelineId` set writes a `Run` (`status: queued`, `taskId`, card snapshot as `trigger`). Enable the "Automate this column" control stubbed in Phase 3, plus **▶ Run now** in the drawer. The web app still never executes — it only enqueues.
3. **Board reconciler** (`worker/src/engine/board.ts`): on every step transition and at terminal state, append a `TaskEvent`, update the card's live badge, and apply `autoAdvance` via the pure `nextColumn` from Phase 1.
4. **Live updates**: SSE endpoint `/api/runs/stream`; the board and drawer subscribe. A step transition reaches the card in **under a second**; polling only as fallback.
5. **Approval gate on the board**: `require-approval` parks the run at `awaiting_approval` and moves the card to a `waiting` column with **Approve / Reject** on the card face. Approve resumes at the next node with context intact; reject fails the run with your comment as the reason.
6. Assemble the golden pipeline (in the editor and as a seed/fixture): `task-trigger → clone-repo → agent(implementer) → create-branch → commit-changes → open-pr → update-task(column: Review, prUrl)`. Keep a `github-issue-trigger` variant as an alternate entry point.
7. **Implementer agent** config per [docs/AGENTS.md](docs/AGENTS.md): system prompt = "senior engineer: implement this task in this repo", the task body as the brief, `claude-opus-4-8`, effort `xhigh`, tools = Read/Write/Edit/Grep/Glob/Bash (git), workspace-scoped.
8. Run-detail UI: live log stream, per-step status, PR link — reachable from the card, not only from `/runs`.
9. Graceful failure: any step failing marks the run failed with a clear reason, surfaces `✗ failed at <node>` **on the card face**, applies `onRunFailed` (default: back to Todo), and cleans up the workspace.

**Files:** `worker/src/handlers/board/**`, `worker/src/engine/board.ts`, `web/src/app/api/runs/stream/route.ts`, `web/src/app/api/tasks/[id]/approve/route.ts`, editor seed fixture, `worker/src/handlers/github/cloneRepo.ts`, run-detail page `web/src/app/runs/[id]/**`.

**Tests**
- Unit: `update-task` / `create-task` / `require-approval` handlers against a mock repo layer; `require-approval` parks rather than blocks a thread.
- Integration with **mock agent + mock GitHub**: card enters the automated column → run executes in order → PR url in the final output → card lands in Review with `prUrl` set and a complete `TaskEvent` timeline. Failure mid-run leaves the card in the failure column with the reason attached.
- Integration: an approval gate parks the run, the approve API resumes it from the correct node, and reject fails it with the comment.
- E2E (Playwright, mocked backend): drag a card into "In progress" → watch the live badge advance → card auto-moves to Review → PR chip is on the card and the timeline is populated.

**Verification**
```bash
npm run test:worker -- pipelines/golden.integration handlers/board
npm run e2e -- golden-loop.spec.ts
# Optional full live run (needs a provider key on the pipeline + GITHUB_TOKEN + a test repo):
#   drag a real card and confirm a real PR is opened. If creds absent, verify via mocks and state that.
```

**⛔ Definition of Done (MVP gate)**
- [ ] Dragging a card into an automated column starts a run; the card shows live progress and auto-advances on success.
- [ ] Golden loop runs end-to-end with mocks; produces a PR output; failure path leaves the card correct and legible.
- [ ] Approval gate parks, resumes, and rejects correctly from the card face.
- [ ] E2E golden-loop passes.
- [ ] (If creds available) one real run opened a real PR — paste the PR URL. If not, say mocks-only and what's needed for a live run.
- [ ] Run-detail UI shows live logs, step status, and the PR link, reachable from the card.

> 🎉 **This is the MVP.** Stop here and report. Phases 8–12 are expansion — proceed only when the user says "continue".

---

## Phase 8 — Multi-agent team

**Objective:** Turn the single implementer into a **crew**: Triage → Planner → Implementer → Reviewer, wired as pipeline nodes (and/or Claude Agent SDK subagents), per [docs/AGENTS.md](docs/AGENTS.md).

**Tasks**
1. Add agent roles as configurable node presets: **Triager** (cheap: `claude-haiku-4-5`/effort `low` — classify/label/decide), **Planner** (produce a task breakdown), **Implementer** (code), **Reviewer** (review the diff, request changes or approve).
2. Reviewer node can **loop**: on "changes requested", route back to the implementer (bounded max iterations — surface the cap in logs, never silently).
3. Optionally use the SDK's **subagent** feature for parallel sub-tasks within a node; otherwise model the team as sequential/branching nodes.
4. Conditional edges (a `condition` node: route by a variable, e.g. issue label or reviewer verdict).
5. **Decomposition onto the board**: the Planner's breakdown feeds `create-task` ([docs/NODES.md](docs/NODES.md)), so one big card becomes several subtask cards in Backlog, linked back to the parent in their timelines. This is where the crew starts managing *your* board, not just your code.

**Files:** role presets in `web/src/nodes/presets.ts`, `worker/src/handlers/condition.ts`, reviewer-loop logic in the engine.

**Tests**
- Condition routing (both branches); reviewer loop terminates at the cap and logs it.
- Team pipeline (mocked agents): triage→plan→implement→review→PR executes; a "changes requested" verdict loops once then proceeds.

**Verification**
```bash
npm run test:worker -- handlers/condition pipelines/team.integration
npm run e2e -- team-run.spec.ts
```

**⛔ Definition of Done**
- [ ] Conditional routing + bounded reviewer loop tested (cap logged, never silent).
- [ ] Team pipeline runs end-to-end with mocks.
- [ ] A planner run creates linked subtask cards on the board (parent traceable from each child's timeline).

---

## Phase 9 — ⏰ Recurring work, Today view & GitHub sync

**Objective:** Make the *daily iterative* case first-class: work that shows up on its own every morning, one screen that tells you what to do, and cards that stay in step with GitHub issues.

**Tasks**
1. **Scheduler** (`worker/src/scheduler/`): a cron tick (default 60s) that spawns child cards from `Task.recurrence` templates due now and enqueues runs for `schedule-trigger` pipelines. **Idempotent** — dedupe on `templateId + scheduled slot` so a missed or doubled tick never double-spawns.
2. **`schedule-trigger` node** ([docs/NODES.md](docs/NODES.md)): `{ cron, timezone }` → `{ scheduledFor }`. Cardless runs (nightly dependency audit, morning CI digest).
3. **Recurrence editor** in the task drawer: a plain-language picker ("every weekday at 9am") writing a cron/RRULE string, with the next 3 fire times previewed. Template cards are visually distinct and never move.
4. **Today view** (`/today`): due, overdue, in flight, and waiting-on-you across all boards, each with a one-click ▶ Run. This is the 9am screen — see [docs/BOARD.md](docs/BOARD.md).
5. **GitHub issue sync** (per board, opt-in): import issues matching a filter as cards; push a card to a new issue on demand; mirror done→closed and closed→archived. One job, **idempotent, never destructive** — conflicts resolve in favour of not deleting.
6. **Digest** (optional): a seeded pipeline that summarises yesterday's runs into a card each morning — the first thing the system does *for* you.

**Files:** `worker/src/scheduler/**`, `worker/src/handlers/scheduleTrigger.ts`, `web/src/app/today/**`, `web/src/components/board/RecurrenceEditor.tsx`, `worker/src/github/sync.ts`.

**Tests**
- Unit (pure, injected clock — no `Date.now()`): due-slot calculation across timezones and DST; a tick at T and again at T+30s spawns **exactly one** card; a worker down for 3 hours catches up without spawning 180 duplicates.
- Unit: recurrence string ↔ human description round-trip; next-fire-time preview.
- Unit: issue sync is idempotent (running it twice changes nothing) and never deletes a card.
- E2E: set a card to recur → advance the injected clock → a child card appears in the right column; Today view lists it.

**Verification**
```bash
npm run test:worker -- scheduler github/sync
npm run e2e -- today.spec.ts
```

**⛔ Definition of Done**
- [ ] A recurring card reliably respawns exactly once per slot, proven with an injected clock (including a catch-up after downtime).
- [ ] `schedule-trigger` runs a cardless pipeline on its cron.
- [ ] Today view shows due / in-flight / waiting-on-you with working ▶ Run.
- [ ] Issue sync is idempotent and non-destructive (test proves both).

---

## Phase 10 — Deploy & Actions gate

**Objective:** After merge, deploy to a target; formalize the GitHub Actions test gate. Per [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).

**Tasks**
1. `merge-pr` node (gated — outward/destructive; requires the Actions checks to be green first).
2. **Deploy nodes**: `deploy-vercel` and `deploy-netlify` via their deploy APIs/hooks (token from encrypted secrets). Return the deployment URL into the run context.
3. `wait-for-checks` (from Phase 6) becomes the merge gate: don't merge unless required checks pass.
4. A generic **HTTP-request node** (configurable API/endpoint/headers/body with `{{var}}` interpolation) so any other deploy target/backend can be called — this satisfies the "set an API/endpoint on a node" requirement generically.

**Files:** `worker/src/handlers/{mergePr,deployVercel,deployNetlify,httpRequest}.ts`, integration contracts in `packages/core/src/integrations/`.

**Tests**
- HTTP-request node: interpolates config, calls a mock server, returns the response; error status handled.
- Deploy handlers (mock clients): return a deployment URL; failures surface.
- Merge gate: refuses to merge when checks are pending/failing.

**Verification**
```bash
npm run test:worker -- handlers/httpRequest handlers/deploy handlers/mergePr
```

**⛔ Definition of Done**
- [ ] HTTP-request + deploy + merge-gate handlers tested with mocks.
- [ ] Merge is blocked unless required checks are green.
- [ ] Deploy nodes return a deployment URL into the run context.

---

## Phase 11 — Observability, resilience & security hardening

**Objective:** Make runs debuggable, recoverable, and safe. Per [docs/SECURITY.md](docs/SECURITY.md).

**Tasks**
1. Run history + a run dashboard (list, filter, drill into steps/logs/token usage).
2. **Retries & resume**: a failed run can be retried from the failed step; the worker recovers in-flight runs on restart (DB-backed queue).
3. **Secrets management UI** (add/rotate tokens; write-only; never displayed after save).
4. Security pass: audit that no secret is logged; agent tool gating enforced on every handler; per-run workspace isolation; a rate/cost guard (max tokens per run) surfaced in the UI.
5. Structured logging + a redaction filter proven by test.

**Files:** `web/src/app/dashboard/**`, `web/src/app/settings/secrets/**`, `worker/src/engine/retry.ts`, redaction filter.

**Tests**
- Retry-from-failed-step resumes correctly; worker recovers a `running` run after a simulated restart.
- Redaction filter scrubs secrets from every log path (property test over sample payloads).
- Cost guard aborts a run that exceeds the token cap and records why.

**Verification**
```bash
npm run test:worker -- engine/retry security/redaction
npm run e2e -- dashboard.spec.ts
```

**⛔ Definition of Done**
- [ ] Retry/resume + restart-recovery tested.
- [ ] Redaction proven; no secret reaches any log.
- [ ] Cost guard enforced; dashboard shows history + usage.

---

## Phase 12 — Packaging & self-host

**Objective:** One-command self-host + green CI + docs.

**Tasks**
1. `docker-compose.yml` running web + worker + (optional Redis if BullMQ adopted); volumes for the SQLite DB + workspaces; env from `.env`.
2. Finalize `.github/workflows/ci.yml`: install, lint, `test:*`, `next build`, Playwright (headless). Note whether any live agent/GitHub E2E is manual (needs secrets) — document it, never imply coverage that didn't run.
3. Quickstart in [README.md](README.md): set env → `docker compose up` → open the editor → import the golden pipeline → run it.
4. Threat-model note + operator checklist from [docs/SECURITY.md](docs/SECURITY.md) (this app runs code-executing agents — the operator must understand the trust boundary).

**Files:** `docker-compose.yml`, `Dockerfile`(s), `.github/workflows/ci.yml`, README quickstart.

**Verification**
```bash
docker compose build
docker compose up   # web + worker healthy; open the editor; run the golden pipeline; then stop
# Open a PR; confirm CI runs and passes.
```

**⛔ Definition of Done**
- [ ] `docker compose up` brings up a working AgentFlow; the golden pipeline runs.
- [ ] CI passes on a real PR (lint + unit + build + Playwright).
- [ ] README quickstart is accurate; security/operator checklist complete.
- [ ] No secrets in the repo; all tokens via env/encrypted store.

---

## Done = self-hostable product

At the Phase 12 gate: you can `docker compose up` AgentFlow, open a **board** of your day's work, drag a card, and watch a crew of AI agents (whichever models you configured) take it all the way to a PR (and, with the later nodes, through tests, review, merge, and deploy) — the card moving itself, stopping at your approval gates, and recurring work showing up on its own each morning. Running on your own infrastructure, single-user, with secrets encrypted and agent actions gated.
