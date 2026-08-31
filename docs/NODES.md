# NODES.md — Node Catalog & Config Schemas

Every node type AgentFlow ships. A node type = **`{ id, config schema (Zod), inputs, outputs, handler }`**. The editor's palette (registry) and the worker's handler registry are keyed by the same **`id`**. Adding a node = registering it in both — no scattered edits.

**Contract:** every handler is `run(ctx, config) → output`. Config values may contain `{{ variables }}` resolved against the run context before the handler runs (see [ARCHITECTURE.md](ARCHITECTURE.md)). Handlers throw a friendly error on bad input; the runner records it and fails the run cleanly.

**Phase tags:** 🟢 MVP (Phases 0–7) · 🔵 later (Phases 8–12).

---

## Implementation order

Triggers + `echo` (P4) → `agent` (P5) → GitHub read/branch/commit/PR (P6) → board nodes + wire the golden loop (P7) → `condition` + role presets (P8) → `schedule-trigger` (P9) → `http-request`/deploy/merge (P10).

---

## Triggers

### `manual-trigger` — 🟢
Starts a run from a manual payload (used for testing + ad-hoc runs).
- **Config:** `{ inputSchema?: JSON }` (optional shape for the manual input).
- **Output:** `{ input: <payload> }` → available as `{{ trigger.input.* }}`.

### `task-trigger` — 🟢 ⭐
**The primary trigger.** A card entering a column bound to this pipeline starts the run. See [BOARD.md](BOARD.md).
- **Config:** `{ boardId?: string, columnId?: string, requireLabels?: string[] }` — usually left blank; the binding lives on `BoardColumn.pipelineId` and the editor fills these in for display.
- **Output:** `{ task: { id, title, body, labels, priority, repo, issueNumber, dueAt } }` → read as `{{ trigger.task.title }}`, `{{ trigger.task.body }}`.
- The card's markdown body **is** the agent's brief — the editor labels it that way so the user writes it accordingly.

### `schedule-trigger` — 🔵 ⭐
Runs on a clock with no card at all (nightly audit, morning digest).
- **Config:** `{ cron: string, timezone: string }`.
- **Output:** `{ scheduledFor: ISOString }`. Fired by the worker's scheduler; idempotent per slot.

### `github-issue-trigger` — 🟢
Starts a run from a GitHub issue (via webhook or manual "run on issue #N").
- **Config:** `{ repo: "owner/name", issueNumber?: number }` (number for manual; webhook fills it live).
- **Output:** the issue → `{{ trigger.issue.{number,title,body,labels,author} }}`.
- Real fetch via `GitHubClient` (Phase 6). Payload mapper is pure + tested.

---

## Core flow

### `echo` — 🟢
Returns its interpolated config. Exists to prove the engine end-to-end without agents/GitHub.
- **Config:** `{ value: string }` · **Output:** `{ value: <interpolated> }`.

### `condition` — 🔵
Routes execution by evaluating a variable/expression; the runner follows the matching `sourceHandle`.
- **Config:** `{ expression: string, cases: [{ handle: string, equals: string }], default: string }`.
- **Output:** `{ matched: <handle> }`; the runner enqueues only successors on that handle.
- Example: route by `{{ trigger.issue.labels }}` or `{{ nodes.reviewer.output.verdict }}`.

### `http-request` — 🔵
A generic call to **any API/endpoint** — this is the node that satisfies "set an API/endpoint/variables on a node" for arbitrary backends/deploy targets.
- **Config:** `{ method, url, headers?: Record<string,string>, body?: JSON, secretRefs?: string[] }` — all interpolatable; `secretRefs` inject decrypted secrets into headers/body at call time (never logged).
- **Output:** `{ status, headers, body }`.

---

## Agent node

### `agent` — 🟢
Runs an AI agent (Claude Agent SDK in the MVP) in the run's isolated workspace. **The user chooses the model/agent for this node** — either by referencing a reusable **Agent Profile** or configuring it inline. See [AGENTS.md](AGENTS.md) → *Configurable agents & per-node model selection*.
- **Config (either reference a profile, or inline):**
  ```ts
  {
    // Option A — reference a saved Agent Profile (define once, reuse):
    agentProfileId?: string,
    profileVersion?: number,          // pin a version so a later edit won't change an in-flight run
    overrides?: Partial<AgentConfig>, // override any profile field for this node only

    // Option B (or overrides shape) — inline AgentConfig:
    provider: string,                 // REQUIRED — no default (e.g. "claude", "ollama", "openai-compat")
    model: string,                    // REQUIRED — no default; the user must pick one
    effort?: "low"|"medium"|"high"|"xhigh"|"max",  // may default "high"; "xhigh" for hard coding
    systemPrompt?: string,            // the agent's instructions (interpolatable)
    allowedTools?: string[],          // e.g. ["Read","Write","Edit","Grep","Glob","Bash"]
    inputs?: Record<string,string>,   // map run-context values into the prompt (interpolatable)
    maxTokens?: number                // per-node cost guard
  }
  // Effective config = profile fields merged with overrides (Option A) or the inline fields (Option B).
  ```
- ⚠️ **`provider` + `model` are REQUIRED — there is no default.** The node's config schema rejects an empty model; the **graph validator marks the pipeline invalid** and the run is blocked until every agent node has a model set. The editor shows "Set a model" on any unconfigured agent node. No AI runs (and no cost is incurred) without the user's explicit choice.
- 🔑 **The API key is not on the node — it's on the pipeline.** The node only names a `provider`; the actual key for that provider is supplied once per pipeline in the **Connections / API keys** panel (`ProviderCredential`, encrypted). At run time the handler resolves the key from the pipeline. A run is blocked until every used provider has a key (or, for local models like Ollama, a base URL) set on the pipeline. See [AGENTS.md](AGENTS.md) → *The API key is supplied per pipeline* and [SECURITY.md](SECURITY.md).
- **Editor UX:** the config panel shows a **required model dropdown** (populated from configured providers — Claude, local Ollama, free tiers), an **effort** selector, a **profile picker** ("use a saved agent"), the system prompt, and the tool allowlist — so a single pipeline can mix models (a free/local triager + a strong implementer + a reviewer), all explicitly chosen by the user.
- **Output:** `{ result: string, filesChanged?: string[], usage: { tokens } }`.
- **Execution:** runs the SDK's `query()` scoped to `ctx.workspaceDir`; streams events to logs; tool use gated by [SECURITY.md](SECURITY.md). Behind the `AgentRunner` interface (mockable).
- **Role presets** (Phase 8) provide ready-made configs: Triager, Planner, Implementer, Reviewer — see [AGENTS.md](AGENTS.md).

---

## Board nodes — ⭐ ([BOARD.md](BOARD.md))

These are what make the board *management*, not just a viewer: agents write progress, decompose work, and stop for you.

### `update-task` — 🟢
Write back to the card mid-run: move it, set fields, post to its timeline.
- **Config:** `{ taskId?: string, columnId?: string, priority?: string, addLabels?: string[], comment?: string, setFields?: { prNumber?, prUrl?, estimate? } }` — all interpolatable; `taskId` defaults to the run's own card.
- **Output:** `{ task }` (the updated card).
- Typical use: after `open-pr`, `{ columnId: "col_review", comment: "PR {{ nodes.openPr.output.prUrl }} ready" }`.

### `create-task` — 🟢
Create new card(s) — the decomposition node. An agent that plans a large task emits subtasks; this node turns them into cards.
- **Config:** `{ boardId, columnId, tasks: Array<{ title, body?, labels?, priority?, repo?, blockedBy?: string[] }> }` (interpolatable — feed it `{{ nodes.planner.output.tasks }}`).
- **Output:** `{ createdTaskIds: string[] }`.
- Cards created this way carry `parentTaskId` in their event feed so the origin is traceable.

### `require-approval` — 🟢 (gate)
Parks the run and hands the decision to you on the board.
- **Config:** `{ columnId: string, message: string, showDiff?: boolean, timeoutHours?: number }`.
- **Output:** `{ approved: boolean, comment?: string, decidedAt }`; on reject the run fails with your comment as the reason.
- Sets the run to `awaiting_approval`, moves the card to a `waiting` column, and surfaces **Approve / Reject** on the card face. **Put this before anything outward or destructive** (push to main, merge, deploy) — see [SECURITY.md](SECURITY.md).

---

## GitHub nodes (via `GitHubClient` / Octokit — [INTEGRATIONS.md](INTEGRATIONS.md))

### `read-issue` — 🟢
Fetch an issue's data into context. **Config:** `{ repo, issueNumber }` (interpolatable). **Output:** `{ issue }`.

### `clone-repo` — 🟢
Clone the target repo into the run workspace at a base branch. **Config:** `{ repo, ref?: string }`. **Output:** `{ path, headSha }`.

### `create-branch` — 🟢
Create + check out a branch (typically named from the issue). **Config:** `{ repo, branchName, fromRef?: string }`. **Output:** `{ branch }`.

### `commit-changes` — 🟢
Commit the agent's workspace diff and push the branch. **Config:** `{ repo, branch, message }`. **Output:** `{ commitSha, pushed: boolean }`.

### `open-pr` — 🟢
Open a pull request. **Config:** `{ repo, head, base, title, body }` (interpolatable, e.g. body from the planner). **Output:** `{ prNumber, prUrl }`.

### `wait-for-checks` — 🔵
Poll GitHub Actions / check-runs for the PR's head SHA until complete. **Config:** `{ repo, ref, requiredChecks?: string[], timeoutSec }`. **Output:** `{ conclusion: "success"|"failure"|"timed_out", checks }`. This is how agents "run tests" — execution is delegated to **GitHub Actions**, not a sandbox we host.

### `merge-pr` — 🔵 (gated)
Merge a PR **only if** required checks are green. **Config:** `{ repo, prNumber, method: "merge"|"squash"|"rebase" }`. **Output:** `{ merged, mergeSha }`. Destructive/outward → requires a passing gate ([SECURITY.md](SECURITY.md)).

---

## Deploy nodes — 🔵 ([INTEGRATIONS.md](INTEGRATIONS.md))

### `deploy-vercel`
Trigger a Vercel deployment. **Config:** `{ projectId?, deployHookUrl? | token secretRef, target: "preview"|"production" }`. **Output:** `{ deploymentUrl, state }`.

### `deploy-netlify`
Trigger a Netlify deploy. **Config:** `{ siteId, token secretRef, prod: boolean }`. **Output:** `{ deployUrl, state }`.

> Any other host/backend is reachable via the generic **`http-request`** node.

---

## Registry shape

```ts
// packages/core — the type; web/src/nodes/registry.ts — the list
export interface NodeType<Config = unknown, Output = unknown> {
  id: string;                       // 'agent', 'open-pr', ...
  label: string;
  category: "trigger" | "flow" | "agent" | "board" | "github" | "deploy";
  phase: "mvp" | "later";
  configSchema: ZodSchema<Config>;  // drives the config form + validation
  inputs: string[];                 // context paths it reads (docs/UX aid)
  outputs: string[];                // keys it writes to nodes.<id>.output
}
```

- The **config form** in the editor is generated from `configSchema`.
- The **worker handler** for a node id must exist before that node can run.
- Registry test asserts: unique ids, valid schemas, every MVP node has a handler.

---

## Tier summary

| Tier | Nodes |
|------|-------|
| 🟢 MVP | **task-trigger**, manual-trigger, github-issue-trigger, echo, agent, **update-task**, **create-task**, **require-approval**, read-issue, clone-repo, create-branch, commit-changes, open-pr |
| 🔵 Later | condition, **schedule-trigger**, http-request, wait-for-checks, merge-pr, deploy-vercel, deploy-netlify + agent role presets |
