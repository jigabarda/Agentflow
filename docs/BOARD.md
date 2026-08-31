# BOARD.md — Task Board, Work Tracking & Board-Driven Automation

The **board is the product's front door.** [NODES.md](NODES.md) and [ARCHITECTURE.md](ARCHITECTURE.md) describe the engine that moves cards; this doc describes the work-tracking layer the user actually lives in every day.

---

## The two surfaces

| Surface | What it is | When you use it |
|---------|------------|-----------------|
| 🗂 **Board** (Kanban) | Your tasks as cards in columns. Cards move as agents work. | **Every day.** Add work, watch it progress, approve, review, close. |
| 🕸 **Canvas** (React Flow) | The pipeline that automates a *class* of task. | **Occasionally.** When you're teaching the system how a kind of task gets done. |

> Rule of thumb: **a Task is the unit of work; a Pipeline is the recipe; a Run is the card in motion.**
> You should be able to do a full day's work without opening the canvas once.

---

## Core concept — a card is a run

```
   BACKLOG        TODO           IN PROGRESS       REVIEW           DONE
  ┌─────────┐   ┌─────────┐     ┌──────────┐     ┌─────────┐     ┌─────────┐
  │ #14     │   │ #12     │     │ #11      │     │ #9      │     │ #8      │
  │ refactor│   │ fix     │ ──▶ │ ⚙ impl   │ ──▶ │ 🔗 PR   │ ──▶ │ ✓ merged│
  │         │   │ login   │     │ ▓▓▓░ 3/5 │     │  #204   │     │         │
  └─────────┘   └─────────┘     └──────────┘     └─────────┘     └─────────┘
    manual        manual         agents run       human gate       auto
     (you)      (you drag)       (automatic)      (you approve)
```

Dragging a card into a column with a **task trigger** starts the pipeline bound to that column. From then on, the **card moves itself**: the runner writes the card's status, progress, and links as the run advances. The user's job shrinks to *deciding what to work on* and *approving what agents produced*.

---

## Data model additions

Added to the Prisma schema in [ARCHITECTURE.md](ARCHITECTURE.md).

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
  name        String   // "Backlog", "Todo", "In progress", "Review", "Done"
  order       Int
  kind        String   // backlog | ready | working | waiting | done  (semantic; drives UI + automation)
  wipLimit    Int?     // soft cap; UI warns when exceeded
  pipelineId  String?  // ⭐ entering this column starts THIS pipeline (null = no automation)
  autoAdvance Json?    // { onRunSucceeded?: columnId, onRunFailed?: columnId, onPrMerged?: columnId }
  board       Board    @relation(fields: [boardId], references: [id], onDelete: Cascade)
  tasks       Task[]
}

model Task {
  id          String     @id @default(cuid())
  boardId     String
  columnId    String
  title       String
  body        String?    // markdown — the brief the agent reads
  order       Float      // fractional index: drag-reorder without renumbering neighbours
  priority    String     @default("normal")  // low | normal | high | urgent
  labels      Json       // string[]
  estimate    Int?       // optional points/minutes — Today view only
  repo        String?    // "owner/name" — the repo this task acts on
  issueNumber Int?       // linked GitHub issue (optional, two-way sync)
  prNumber    Int?       // filled by the pipeline when a PR is opened
  prUrl       String?
  blockedBy   Json       // string[] of Task ids — card shows 🔒 until they're done
  dueAt       DateTime?
  recurrence  String?    // ⭐ cron/RRULE — respawns this card on a schedule (see Recurring work)
  archivedAt  DateTime?
  runs        Run[]      // every run this card triggered (newest = current)
  events      TaskEvent[]
  createdAt   DateTime   @default(now())
  updatedAt   DateTime   @updatedAt
}

model TaskEvent {          // the card's activity feed — human + agent actions in ONE timeline
  id        String   @id @default(cuid())
  taskId    String
  actor     String   // "user" | "agent:<nodeId>" | "system" | "github"
  kind      String   // moved | commented | run_started | run_step | run_failed | pr_opened | approved | ...
  message   String
  meta      Json?
  createdAt DateTime @default(now())
}

// Run gains:  taskId String?   — the card this run belongs to (null for canvas test-runs)
```

**Invariants**

1. A Task always belongs to exactly one column; moving = updating `columnId` + `order`.
2. `Run.taskId` is the join that makes the board live — run progress renders on the card.
3. A card with unresolved `blockedBy` **cannot** enter a `working` column (UI blocks the drop; API rejects it).
4. Deleting a pipeline does not delete cards; the column's `pipelineId` goes null and automation stops (cards still move manually).

---

## Board-driven automation (the heart of the system)

Three rules, evaluated by the worker, keep the board honest:

**1. Enter a column → start a run.**
When `BoardColumn.pipelineId` is set, dropping a card there enqueues a `Run` for that pipeline with the card as the trigger payload:

```ts
trigger = { task: { id, title, body, labels, priority, repo, issueNumber, dueAt } }
// agents read it as {{ trigger.task.title }} / {{ trigger.task.body }} / {{ trigger.task.repo }}
```

**2. Run progresses → card reflects it.**
Every `RunStep` transition writes a `TaskEvent` and updates the card's live badge: `⚙ step 3/7 · implementer`. Failures surface on the card face (`✗ failed at open-pr`) — never buried in a log page.

**3. Run/PR reaches a terminal state → card advances.**
`BoardColumn.autoAdvance` maps outcomes to destination columns:

```json
{ "onRunSucceeded": "col_review", "onRunFailed": "col_todo", "onPrMerged": "col_done" }
```

Auto-advance is **opt-in per column** and always overridable by dragging. Nothing moves without a rule the user set.

> **Human gates live on the board.** A `require-approval` node parks the run and moves the card to a `waiting` column with an **Approve / Reject** control on the card face. Approve resumes the run; reject fails it with your comment as the reason. This is where "AI agents do the work" stays safe — see [SECURITY.md](SECURITY.md).

---

## Recurring & daily work

The daily-iterative case is a first-class feature, not a cron script bolted on:

- **`recurrence` on a Task** — a *template card* respawns a fresh card into its column on schedule (`0 9 * * 1-5` → every weekday 9am). The template never moves; its children do.
- **`schedule-trigger` node** — a pipeline that runs on a clock with no card at all (nightly dependency audit, morning CI digest).
- **Today view** — a flat, board-agnostic list of what's due, overdue, in flight, and waiting on you, with a one-click ▶ Run for each. This is the screen to open at 9am.

```
TODAY · Tue 19 Aug                                  3 due · 1 waiting on you
───────────────────────────────────────────────────────────────────────────
⏰ 09:00  Daily dep + CI digest        schedule    ✓ ran 09:02 → digest
▶  now    Fix login redirect  #12      agents      ⚙ implementer · 4/7
⏸  —      Refactor auth module #9      needs you   [Approve] [Reject] [Diff]
○  14:00  Client report — Acme         manual      not started
```

---

## UI spec

### Board view (default route `/`)
- Columns as flex tracks with horizontal scroll; **drag-and-drop** within/between columns (`@dnd-kit`), optimistic move with rollback if the API rejects it.
- **Card face:** title · priority stripe · labels · repo/issue chip · **live run badge** (queued / running step x-of-y / succeeded / failed) · PR chip when open · 🔒 when blocked. No avatars — single user.
- **Column header:** name, count, WIP-limit warning, and a ⚡ chip when a pipeline is bound (click → jumps to that pipeline on the canvas).
- **Quick add** at the top of every column — title only, everything else optional. Friction here kills the whole system.
- Filters: label, priority, repo, "waiting on me", "failed".

### Task detail (drawer, not a page navigation)
Opens over the board so you never lose your place:
1. **Brief** — title + markdown body. This *is* the agent's prompt input; the UI says so explicitly.
2. **Automation** — which pipeline this column runs, a ▶ Run now button, and the model each agent node will use.
3. **Timeline** — merged `TaskEvent` feed: your comments, every agent step, PR events, failures. Live-updating.
4. **Artifacts** — PR link, branch, files changed, diff summary, run logs (collapsed by default).

### Live updates
Board and drawer subscribe to run state over **SSE** (`/api/runs/stream`); polling is the fallback only. A step transition must reach the card in under a second — that liveness is what makes this feel like a system instead of a form.

### Keyboard
`n` new card · `/` filter · `j`/`k` move selection · `Enter` open drawer · `1`–`9` move to column N · `r` run now. The board must be fully operable without the mouse.

---

## GitHub issue sync (optional, per board)

- **Import:** issues matching a filter (label, milestone) become cards; `issueNumber` links them.
- **Push:** card → new issue on demand (button in the drawer).
- **Mirror:** card moved to a `done` column closes the issue; an issue closed on GitHub archives the card.
- Sync is **one job, idempotent, and never destructive** — conflicts always resolve in favour of *not* deleting. Contract in [INTEGRATIONS.md](INTEGRATIONS.md).

> The board is the source of truth for *your work*. GitHub is the source of truth for *code*. Keep them linked, not merged.
