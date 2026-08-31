# CLAUDE.md — AgentFlow Agent Operating Manual

> Auto-loaded at the start of every Claude Code session in this repo.
> It tells you (the AI agent) **what this project is** and **how to build it correctly**.
> The full build sequence is in **[PLAN.md](PLAN.md)**. Reference specs are in **[docs/](docs/)**.
>
> *(AgentFlow is a working name — the user may rename it. Don't hard-code the name into logic; read it from config.)*

---

## 🚀 Kickoff

When the user says **"follow PLAN.md"** (or "start", "continue", "resume"):

1. Read **[PLAN.md](PLAN.md)** and find the **first phase whose Definition of Done is not yet met**.
2. Read the reference docs that phase points to (`docs/*.md`).
3. Execute that phase's tasks **in order**.
4. Run the phase's **verification commands** and paste the **real output**.
5. **Stop at the phase gate.** Report status, then wait for the user to say "continue".

Never skip ahead. Never batch multiple phases without stopping at each gate.

---

## What we're building

**AgentFlow** — a **workflow-management system for daily development work, where the tasks are cards on a Kanban board and the workers are AI agents.** You drag a card into "In progress"; a crew of AI agents — the models you chose — triages it, plans it, implements it, branches, commits, opens a PR, runs tests, and reviews — while the **card moves itself** across the board and stops at your approval gates.

Think **"Linear/Trello, except the cards get done by a team of AI software engineers you configured."**

### Two surfaces — get this right or the product is wrong

| Surface | Route | What it is | How often |
|---------|-------|------------|-----------|
| 🗂 **Board** (Kanban) | `/` — **the default** | Tasks as cards in columns; live run progress on the card face; approve/reject; Today view. | **Every day.** |
| 🕸 **Canvas** (React Flow) | `/pipelines` | The node graph that automates a *class* of task; per-node model choice. | Occasionally. |

**A Task is the unit of work · a Pipeline is the recipe · a Run is the card in motion.** A full day's work must be possible without opening the canvas. Full spec: **[docs/BOARD.md](docs/BOARD.md)** — read it before touching board, task, or run-status code.

Automation is bound to **columns**: `BoardColumn.pipelineId` means "entering this column starts that pipeline", and `autoAdvance` means "when the run/PR ends this way, move the card there." Recurring cards (`Task.recurrence`) and `schedule-trigger` pipelines cover the daily-iterative work.

**Headline feature — configurable agents/models per node (incl. free & local models):** the user chooses *which AI model/agent does each task* in the pipeline. Every agent node has a model dropdown + effort selector, and the user can build a library of reusable **Agent Profiles** (model + effort + prompt + tools) and drop them onto nodes.

⚠️ **There is NO default or preconfigured AI model.** The user MUST explicitly set a provider + model on every agent node before it can run — an agent node with no model is **invalid**, and the pipeline **cannot run** until it's configured (the graph validator enforces this and the editor flags it). Options include any Claude model, a **free local model (Ollama)**, or a **free API tier**. Model/provider are **data, never hard-coded** — the graph, engine and handlers are provider-neutral, and the worker selects a runner by `provider`. Claude and OpenAI-compatible (Ollama, LM Studio, free hosted tiers) runners both ship; an unknown provider fails loudly rather than falling back.

🔑 **The AI API key is supplied per pipeline, not globally.** For each provider a pipeline uses, the user enters that provider's API key in the pipeline's **Connections / API keys** panel (stored as an encrypted `ProviderCredential` scoped to the pipeline; local models like Ollama need only a base URL). At run time the agent handler resolves the key from the run's pipeline and passes it to the runner in-memory — **never** from a global/env default, never logged, never in the agent's workspace/prompt. A run is blocked until every used provider has a key/base URL set. See [docs/AGENTS.md](docs/AGENTS.md) → *Configurable agents & per-node model selection*, *Any model — including free & local*, and *The API key is supplied per pipeline*.

**Locked product decisions (from the planning conversation):**
- **Deployment model:** **Solo / self-hosted first.** Single user, no accounts, no billing, no multi-tenancy. Runs on the user's own machine/server. (SaaS is a *later*, out-of-scope concern.)
- **How agents execute code:** **GitHub-native via API + Actions.** Agents work through the GitHub API (create branch, commit, open PR) and delegate real code execution/tests to **GitHub Actions runners**. We do **not** build our own container/VM sandbox farm in the MVP.
- **AI stack: pluggable runners, chosen per node by `provider`.** AgentFlow must be fully usable by someone with **no Anthropic account at all**. Two runners ship:
  - `claude` → **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — built-in tools, best coding quality, paid.
  - `ollama` and `openai-compat` → **`OpenAICompatibleRunner`** — any endpoint speaking `POST {baseUrl}/chat/completions`: a **free local model** (Ollama, LM Studio) or a **free hosted tier** (Groq, OpenRouter, Together, DeepSeek…). The agent loop and workspace-confined file tools are implemented by us, since a plain chat endpoint has none.
  - ⚠️ **There is no fallback.** An unknown provider fails with the list of available runners; it never quietly runs on Claude and never spends someone else's key.
- **Primary surface:** the **board**. The canvas is configuration, not the daily driver.
- **MVP target (end of Phase 7):** the **board + the visual editor + node config + ONE working end-to-end agent loop driven from a card** — drag a card into "In progress" → agents implement it → PR opened → the card auto-moves to "Review" with the PR attached and a full timeline. Multi-agent team, recurring work, deploy targets are later phases.

Full node catalog: **[docs/NODES.md](docs/NODES.md)**. Board & work-tracking: **[docs/BOARD.md](docs/BOARD.md)**. Agent/team design: **[docs/AGENTS.md](docs/AGENTS.md)**.

---

## Tech stack (do not substitute without asking)

### App (the AgentFlow product itself) — `web/`
- **Next.js 16 App Router + React 19 + TypeScript** (strict), **Tailwind CSS 4**, alias `@/*` → `./src/*`. (Portfoliov4 is on Next 15; `create-next-app@latest` now ships 16 — same App Router, no migration cost, so we took it.)
- **React Flow** (`@xyflow/react`) — the visual node-graph editor.
- **`@dnd-kit`** — board drag-and-drop (cards between columns). Do not substitute a different DnD lib.
- **Zustand** — editor/canvas + board state.
- **Zod** — validate node configs, pipeline definitions, API payloads.
- **SSE** (a plain route handler, no library) — live run status onto the board. Polling is fallback only.

### Data — `web/` (local, single-user)
- **SQLite** via **Prisma** (or `better-sqlite3` if the builder prefers) — boards, columns, tasks, task events, pipelines, nodes, edges, runs, run-steps, logs, secrets (encrypted at rest). Local file DB; no external service.

### Execution — `worker/`
- A **Node/TypeScript worker process** that runs pipeline executions out-of-band from the web request.
- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — drives agent nodes whose provider is `claude` (built-in Read/Write/Edit/Bash/Glob/Grep tools, the agent loop, subagents, hooks, permissions, MCP). ⚠️ **This is NOT the Anthropic API SDK** — it's a separate library (Claude Code as a library). Verify exact API against the official docs (below); do not guess signatures.
- **Octokit** (`@octokit/rest`) — GitHub API (issues, branches, commits, PRs, Actions status).
- **simple-git** or the SDK's Bash tool — git operations inside per-run workspaces.
- Job queue: start with a **DB-backed in-process queue** (single-user); note **BullMQ + Redis** as the scale-up path.

### Testing
- **Vitest** (unit — pure logic: the graph runner, variable interpolation, node validators, GitHub payload mappers).
- **Playwright** (E2E — building a pipeline on the canvas + driving a full run with mocked agents/GitHub).
- Agent + GitHub calls are **mocked** in tests via injected interfaces (see [docs/TESTING.md](docs/TESTING.md)).

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the layout and data model.

---

## Claude Agent SDK — orientation

- **Package:** `@anthropic-ai/claude-agent-sdk` (TypeScript). Entry point: `query(prompt, options)` drives an agent loop with built-in tools; options cover `systemPrompt`, `model`, allowed/blocked tools, `permissionMode`, **hooks** (gate/inspect tool calls), **subagents**, **sessions**, and **MCP servers**.
- **It is a harness, not managed infra** — it runs on *our* worker; we host and deploy it. Good, because agents must clone repos and run git/tests locally or via Actions.
- **Model:** default **`claude-opus-4-8`**. Use **effort `xhigh` or `high`** for implementer/reviewer agents (best for coding/agentic); **`low`** (or **`claude-haiku-4-5`**) for cheap triage/classification. Never downgrade the coding agents for cost without the user's say-so.
- **Auth:** the runner passes **the pipeline's own API key** to the SDK explicitly (from that pipeline's `ProviderCredential`) — do **not** rely on a global `ANTHROPIC_API_KEY` env var or an `ant auth login` profile for agent runs. Keys are per-pipeline, encrypted, injected in-memory. Never hard-code keys.
- **Official docs (source of truth for exact API): `code.claude.com/docs/en/agent-sdk`.** When wiring the SDK (Phase 4), **read the docs / invoke the `claude-api` skill** and verify signatures before writing — do not invent option names.

---

## 🛑 Guardrails (non-negotiable)

1. **Phases run in order.** Don't start a phase until the previous phase's **Definition of Done** is met and its verification passes.
2. **Tests are written alongside code, every phase.** A phase isn't done until its tests pass.
3. **Never claim green without running.** Run the verification command and paste real output. If you can't run something (e.g. no GitHub token, no ANTHROPIC key), say so explicitly and describe what you *did* verify (mocks).
4. **Security is first-class — this app runs AI agents that execute code and hold tokens.** Follow [docs/SECURITY.md](docs/SECURITY.md): secrets encrypted at rest and never logged; agent tool use gated by the SDK's permission/hook system; every run in an isolated per-run workspace; destructive/outward actions (push, merge, deploy) behind explicit gates.
5. **Determinism where it matters.** The graph runner, variable interpolation, and payload mappers are **pure and unit-tested**. No `Date.now()`/`Math.random()` inside tested pure logic — inject them.
6. **Minimal dependencies.** Use the libraries named above and in the docs. Ask before adding others.
7. **Verify the Agent SDK against its docs** before writing SDK-specific code (see orientation above). Don't guess API shapes.
8. **Git policy (strict):**
   - Work on a branch created from **remote `main`** (`git fetch origin && git switch -c <branch> origin/main`).
   - **Do NOT `git commit` or `git push` until the user explicitly says so.** (This is about *our own* AgentFlow repo. It's separate from the agents' own git actions inside a run, which are a product feature.)
   - At each phase gate, leave changes staged/working but uncommitted, report, and wait.
9. **Stop and report at every gate.** One phase per turn unless told otherwise.
10. **Windows environment.** Primary shell is PowerShell; a Bash tool is available. Prefer cross-platform npm scripts.
11. **The board is the front door, and it must stay fast.** The default route is the board; every run-state change must reach the card in under a second (SSE). Board interactions are **optimistic with rollback** — never a spinner-and-wait. If a feature can only be reached through the canvas, it isn't finished.
12. **The web app never executes.** Board actions (drag, ▶ Run now, approve) only write rows — a task move, a `queued` run, an approval flag. The worker is the only thing that runs pipelines and the only thing that *auto*-moves cards.
13. **Clocks are injected.** The scheduler (recurring cards, `schedule-trigger`) must be testable with a fake clock and **idempotent per slot** — a missed or doubled tick may never double-spawn a card.

---

## How to report at a phase gate

```
✅ Phase N — <name> complete
- What I built: <1–3 bullets>
- Tests: <command> → <pass/fail counts, pasted output>
- Verification: <what I ran / observed>
- Definition of Done: <checklist, all ticked>
- Next: Phase N+1 — <name>. Say "continue" to proceed.
```

If a gate **fails**, stop, report what failed, your diagnosis, and the proposed fix.

---

## Resuming / new session

State lives in code + git, not memory. To resume:
1. Re-run the verification for the last-claimed-complete phase to confirm it still passes.
2. Re-read the next phase in [PLAN.md](PLAN.md).
3. Continue.

---

## Reference docs map

| File | What's in it |
|------|--------------|
| [PLAN.md](PLAN.md) | The ordered build phases + gates (**the playbook**) |
| [docs/BOARD.md](docs/BOARD.md) | ⭐ The board: tasks, columns, card-driven automation, approvals, recurring work, board UI spec |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layout, data model, execution-engine design, variable interpolation |
| [docs/NODES.md](docs/NODES.md) | Every node type: config schema, inputs/outputs, MVP vs later |
| [docs/AGENTS.md](docs/AGENTS.md) | The AI team: agent roles, Claude Agent SDK usage, models/effort, the PR flow |
| [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) | GitHub API + Actions, Vercel, Netlify contracts; secrets |
| [docs/TESTING.md](docs/TESTING.md) | Test pyramid, commands, mocking agents/GitHub, E2E flows |
| [docs/SECURITY.md](docs/SECURITY.md) | Running code-executing agents safely; secrets; gates; sandboxing |
