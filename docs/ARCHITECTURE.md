# ARCHITECTURE.md — Layout, Data Model & Execution Engine

Single source of truth for **how AgentFlow is organized**. [PLAN.md](../PLAN.md) builds toward this shape.

---

## Monorepo layout

```
AgentFlow/
├── CLAUDE.md · PLAN.md · README.md
├── package.json              # npm workspaces: ["web", "worker", "packages/*"]
├── .github/workflows/ci.yml
├── .env.example              # DATABASE_URL, SECRETS_ENC_KEY, GITHUB_TOKEN — NO AI keys
├── prisma/schema.prisma      # SQLite schema (shared)
├── docs/                     # these reference docs
│
├── packages/core/            # ── shared, framework-free ──
│   └── src/
│       ├── types.ts          # Pipeline, Node, Edge, Run, RunStep, ...
│       ├── schemas.ts        # Zod schemas (validation source of truth)
│       ├── graph.ts          # DAG validator (pure)
│       ├── interpolate.ts    # {{variable}} resolution (pure)
│       ├── github/mappers.ts # issue/PR payload mappers (pure)
│       └── integrations/     # deploy contracts
│
├── web/                      # ── Next.js 16 App Router ──
│   └── src/
│       ├── app/
│       │   ├── (board)/      # ⭐ DEFAULT SURFACE — Kanban board + task drawer + Today view
│       │   ├── (editor)/     # React Flow canvas + node config
│       │   ├── runs/[id]/    # run detail (live logs, steps, PR link)
│       │   ├── dashboard/    # run history
│       │   ├── settings/secrets/
│       │   └── api/          # route handlers: tasks, boards, pipelines, runs (enqueue),
│       │                     #   runs/stream (SSE), approvals, secrets
│       ├── components/board/  # Column, TaskCard, TaskDrawer, Timeline, TodayList
│       ├── components/editor/
│       ├── nodes/            # node registry + presets (drives the palette)
│       └── data/             # Prisma repositories (only layer that touches the DB from web)
│
└── worker/                   # ── execution engine (Node/TS process) ──
    └── src/
        ├── index.ts          # queue consumer / run loop
        ├── engine/           # Runner, topo-order, run lifecycle, retry
        │   └── board.ts      # ⭐ board reconciler: run state → TaskEvent + card moves
        ├── scheduler/        # ⭐ cron tick: recurrence templates → new cards; schedule-trigger runs
        ├── handlers/         # one file per node type (run(ctx, config) → output)
        │   ├── manualTrigger.ts · echo.ts · condition.ts · httpRequest.ts
        │   ├── agent.ts
        │   ├── board/        # createTask, updateTask, requireApproval
        │   └── github/       # readIssue, cloneRepo, createBranch, commit, openPr, waitForChecks, mergePr
        ├── agent/            # AgentRunner interface (one runner per provider; test = mock)
        ├── github/           # GitHubClient interface (real = Octokit; test = mock)
        └── workspace/        # per-run isolated temp dirs
```

---

## Module boundaries (rules)

1. **`packages/core` is pure** — types, Zod schemas, graph validation, interpolation, payload mappers. No React, no Prisma, no network, no `Date.now()`/`Math.random()` in tested paths (inject them). Both `web` and `worker` import it; it imports neither.
2. **Only `web/src/data/**` touches the DB from the web side.** Route handlers and components call repositories, never Prisma directly.
3. **The worker owns execution.** The web app *enqueues* runs and *reads* their state; it never runs agents in a request handler.
4. **External systems live behind interfaces.** `AgentRunner` (one implementation per provider) and `GitHubClient` (Octokit) are interfaces so tests inject mocks — no tokens, no network in unit tests.
5. **Node handlers are the extension point.** A node type = `{ id, config schema, handler }`. The editor's node registry and the worker's handler registry are keyed by the **same node-type id** (see [NODES.md](NODES.md)).
6. **The board never executes anything itself.** Web-side board actions (drag, ▶ Run now, approve) only write DB rows — a `Task` move, a `queued` `Run`, an approval flag. The worker is the only thing that runs pipelines and the only thing that *auto*-moves cards. See [BOARD.md](BOARD.md).

---

## Data model (Prisma / SQLite)

> **Two halves.** `Board`/`BoardColumn`/`Task`/`TaskEvent` are the **work-tracking** half (what you look at daily — full spec in [BOARD.md](BOARD.md)). `Pipeline`/`Run`/`RunStep` are the **execution** half. `Task ←→ Run` is the seam that makes cards live.

```prisma
model Board {
  id        String        @id @default(cuid())
  name      String
  columns   BoardColumn[]
  tasks     Task[]
  createdAt DateTime      @default(now())
}

model BoardColumn {
  id          String   @id @default(cuid())
  boardId     String
  name        String
  order       Int
  kind        String   // backlog | ready | working | waiting | done
  wipLimit    Int?
  pipelineId  String?  // entering this column starts THIS pipeline (null = manual column)
  autoAdvance Json?    // { onRunSucceeded?, onRunFailed?, onPrMerged? } → column ids
  board       Board    @relation(fields: [boardId], references: [id], onDelete: Cascade)
  tasks       Task[]
}

model Task {
  id          String      @id @default(cuid())
  boardId     String
  columnId    String
  title       String
  body        String?     // markdown — the brief the agent reads
  order       Float       // fractional index for drag-reorder
  priority    String      @default("normal")
  labels      Json        // string[]
  estimate    Int?
  repo        String?     // "owner/name"
  issueNumber Int?        // linked GitHub issue
  prNumber    Int?
  prUrl       String?
  blockedBy   Json        // string[] of Task ids
  dueAt       DateTime?
  recurrence  String?     // cron/RRULE — template card respawns on schedule
  archivedAt  DateTime?
  runs        Run[]
  events      TaskEvent[]
  createdAt   DateTime    @default(now())
  updatedAt   DateTime    @updatedAt
}

model TaskEvent {          // human + agent activity in one timeline
  id        String   @id @default(cuid())
  taskId    String
  actor     String   // "user" | "agent:<nodeId>" | "system" | "github"
  kind      String   // moved | commented | run_started | run_step | run_failed | pr_opened | approved
  message   String
  meta      Json?
  createdAt DateTime @default(now())
}

model Pipeline {
  id          String               @id @default(cuid())
  name        String
  nodes       PipelineNode[]
  edges       PipelineEdge[]
  variables   Variable[]
  credentials ProviderCredential[] // the AI provider API keys for THIS pipeline
  runs        Run[]
  createdAt   DateTime             @default(now())
  updatedAt   DateTime             @updatedAt
}

// ⭐ Node ids are scoped to their pipeline, NOT global. They are author-chosen
// and readable (`planner`, `implementer`) because prompts interpolate them as
// {{ nodes.planner.output.tasks }} — so two pipelines may both hold an `agent-1`.
model PipelineNode {
  id         String
  pipelineId String
  type       String   // node-type id — matches the handler + registry
  label      String
  config     Json     // validated by the node type's Zod schema
  x          Float
  y          Float
  pipeline   Pipeline @relation(fields: [pipelineId], references: [id], onDelete: Cascade)
  @@id([pipelineId, id])
}

model PipelineEdge {
  id         String
  pipelineId String
  source     String   // PipelineNode.id, within this pipeline
  target     String
  sourceHandle String? // for conditional branches (e.g. "true"/"false")
  pipeline   Pipeline @relation(fields: [pipelineId], references: [id], onDelete: Cascade)
  @@id([pipelineId, id])
}

model Variable {           // pipeline-level reusable vars
  id         String   @id @default(cuid())
  pipelineId String
  key        String
  value      String
  pipeline   Pipeline @relation(fields: [pipelineId], references: [id], onDelete: Cascade)
}

model AgentProfile {       // reusable agent definitions the user builds in the Agents panel
  id           String   @id @default(cuid())
  name         String    // "Senior Implementer", "Cheap Triager", ...
  provider     String    // REQUIRED — user picks; NO default (e.g. "claude", "ollama", "openai-compat")
  model        String    // REQUIRED — user picks; NO default (e.g. "claude-opus-4-8", "qwen2.5-coder")
  effort       String    @default("high")     // low | medium | high | xhigh | max
  systemPrompt String
  allowedTools Json      // string[] — which built-in tools this agent may use
  maxTokens    Int?      // cost guard
  version      Int       @default(1)          // bump on edit; nodes may pin a version
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
}
// An `agent` PipelineNode's config is either:
//   { agentProfileId, profileVersion?, overrides?: Partial<AgentConfig> }   ← reference a profile
//   or a fully inline AgentConfig                                            ← one-off
// Effective config = profile fields merged with overrides. Nodes may pin
// profileVersion so an in-flight run isn't changed by a later profile edit.
// ⚠️ provider + model are REQUIRED with NO default. An agent node whose effective
//    config has no provider/model is INVALID — the graph validator rejects the
//    pipeline and the runner refuses to execute it until the user sets one.

model Run {
  id         String    @id @default(cuid())
  pipelineId String
  taskId     String?   // ⭐ the card this run belongs to (null for canvas test-runs)
  task       Task?     @relation(fields: [taskId], references: [id])
  status     String    // queued | running | awaiting_approval | succeeded | failed | canceled
  trigger    Json      // the triggering payload (the task card, or an issue/manual input)
  steps      RunStep[]
  logs       LogEntry[]
  tokensUsed Int       @default(0)
  error      String?
  startedAt  DateTime?
  endedAt    DateTime?
  createdAt  DateTime  @default(now())
}

model RunStep {
  id        String   @id @default(cuid())
  runId     String
  nodeId    String
  status    String   // pending | running | succeeded | failed | skipped
  output    Json?    // node output, merged into run context under nodes.<nodeId>.output
  error     String?
  startedAt DateTime?
  endedAt   DateTime?
}

model LogEntry {
  id        String   @id @default(cuid())
  runId     String
  nodeId    String?
  level     String   // debug | info | warn | error
  message   String   // secrets are ALWAYS redacted before write
  createdAt DateTime @default(now())
}

model Secret {           // encrypted at rest — app/integration tokens (GitHub, Vercel, Netlify)
  id         String   @id @default(cuid())
  name       String   @unique  // e.g. GITHUB_TOKEN, VERCEL_TOKEN
  ciphertext String   // AES-GCM(SECRETS_ENC_KEY); plaintext never stored/logged
  createdAt  DateTime @default(now())
}

model ProviderCredential {   // the AI model API key the user supplies FOR THIS PIPELINE
  id         String   @id @default(cuid())
  pipelineId String
  provider   String   // "claude" | "openai" | "gemini" | "groq" | "openrouter" | "ollama" | "openai-compat" ...
  label      String?  // optional display name, e.g. "My Anthropic key"
  keyCipher  String?  // AES-GCM(SECRETS_ENC_KEY) of the API key; write-only, never logged. Null for keyless local providers.
  baseUrl    String?  // for local/self-hosted/compatible endpoints, e.g. http://localhost:11434 (Ollama)
  createdAt  DateTime @default(now())
  pipeline   Pipeline @relation(fields: [pipelineId], references: [id], onDelete: Cascade)
  @@unique([pipelineId, provider])   // one credential per provider per pipeline
}
// Each agent node picks a provider+model; the run resolves the key from THIS pipeline's
// ProviderCredential for that provider, decrypts it in-memory, and hands it to the runner
// at call time. Keyless local providers (Ollama) need only baseUrl. The key never enters
// the agent's workspace/context and is never logged.
```

---

## Execution engine

### Run context

A single object threaded through every node during a run:

```ts
interface RunContext {
  pipeline: { vars: Record<string, string> };   // pipeline-level Variables
  trigger: unknown;                              // the triggering payload (task card, issue, manual input)
  task?: { id: string; title: string; body?: string; repo?: string; issueNumber?: number };
                                                 // ⭐ the card, when this run came from the board
  nodes: Record<string, { output: unknown }>;   // outputs of already-run nodes, by node id
  runId: string;
  workspaceDir: string;                          // this run's isolated dir
}
```

Board-triggered runs read the card as `{{ trigger.task.title }}`, `{{ trigger.task.body }}`, `{{ trigger.task.repo }}` — so the card *is* the agent's brief.

### The Runner (worker/src/engine)

1. Load the pipeline; validate it's a DAG (reuse `core/graph.ts`).
2. **Topologically order** the nodes.
3. For each node: mark its `RunStep` running → resolve its `config` via interpolation against the current `RunContext` → call the node's handler → store `output` into `ctx.nodes[nodeId].output` → mark succeeded. Stream `LogEntry` rows throughout.
4. On a handler throw: mark the step + run `failed`, record the error, clean up the workspace, stop (retry/resume added in Phase 9).
5. **Conditional edges**: a `condition` node returns which `sourceHandle` to follow; the runner only enqueues successors on that handle.
6. **Board reconciliation** (`engine/board.ts`) — after *every* step transition and at terminal state, if `run.taskId` is set: append a `TaskEvent`, update the card's live badge, and apply the source column's `autoAdvance` rule on success/failure/PR-merge. Pure decision function (`nextColumn(run, column) → columnId | null`) so it's unit-tested without a DB.
7. **Pause / resume**: a `require-approval` node throws a sentinel that parks the run at `awaiting_approval` and moves the card to a `waiting` column. The approval API flips a flag; the worker picks the run back up at the *next* node with its context intact. No polling agent, no held process.

### Board-driven enqueue

The web app never runs anything. Moving a card into a column whose `pipelineId` is set writes a `Run` row with `status: queued`, `taskId`, and the card snapshot as `trigger`. The worker picks it up like any other run — so board automation, manual ▶ Run now, webhooks, and the scheduler all converge on **one** code path.

### Scheduler (`worker/src/scheduler`)

A cron tick (default 60s) that: (a) spawns child cards from `Task.recurrence` templates due now, and (b) enqueues runs for pipelines whose trigger is `schedule-trigger`. Idempotent — a missed or double tick must never double-spawn (dedupe on `templateId + scheduled slot`).

### Node handler interface

```ts
interface NodeHandler<Config, Output> {
  type: string;                                   // node-type id
  configSchema: ZodSchema<Config>;                // validates node.config
  run(ctx: RunContext, config: Config): Promise<Output>;
}
```

Handlers are pure w.r.t. their inputs *except* for the external effects they exist to cause (calling an agent, GitHub, HTTP). Those effects go through injected interfaces (`AgentRunner`, `GitHubClient`) so they're mockable.

### Queue (single-user MVP)

- The web API writes a `Run` row with `status: queued`.
- The worker polls for `queued` runs (DB-backed queue), claims one (transactional status flip to `running`), executes it, updates status.
- On worker restart, any run left `running` is recoverable (Phase 9).
- **Scale-up path:** swap the DB poll for **BullMQ + Redis** without changing handlers.

---

## Variable interpolation (`core/interpolate.ts`)

Node configs and prompts use `{{ path }}` templates resolved against the `RunContext`:

- `{{ pipeline.vars.repoUrl }}`
- `{{ trigger.issue.title }}` / `{{ trigger.issue.number }}`
- `{{ nodes.planner.output.tasks }}`

Rules: dotted paths; a missing path throws a **friendly, catchable** error (never a crash and never silently `undefined`); values are stringified predictably; literal `{{`/`}}` can be escaped. Pure + fully unit-tested (every case in [TESTING.md](TESTING.md)).

---

## Naming & conventions

- TypeScript **strict** everywhere.
- Node-type ids are kebab-case (`open-pr`, `agent`, `github-issue-trigger`) and are the join key between the editor registry and the worker handler registry.
- Files: components `PascalCase.tsx`, logic/handlers `camelCase.ts`, tests `*.test.ts(x)` beside source.
- No secrets in code; read from env / the encrypted `Secret` store. See [SECURITY.md](SECURITY.md).
