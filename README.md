# AgentFlow

A **workflow-management system for your daily dev work: your tasks are cards on a Kanban board, and the workers are AI agents.** Drag a card into *In progress* — a crew of AI agents — the models you chose — triages it, plans it, implements it, opens a PR, runs tests and reviews — while the **card moves itself** across the board and stops at your approval gates.

Behind the board is a **visual pipeline canvas** where each node is configurable (model, prompt, APIs, endpoints, variables) — that's where you teach the system how a *class* of task gets done.

Think **"Linear/Trello, except the cards get done by a crew of AI software engineers you configured."** Runs on your own machine (self-hosted, single-user). **Bring any model**: Claude via the Claude Agent SDK, a free local model through Ollama or LM Studio, or any free hosted tier that speaks the OpenAI-compatible API — you pick per node, and nothing is chosen for you.

```
   BACKLOG        TODO           IN PROGRESS       REVIEW           DONE
  ┌─────────┐   ┌─────────┐     ┌──────────┐     ┌─────────┐     ┌─────────┐
  │ #14     │   │ #12     │     │ #11      │     │ #9      │     │ #8      │
  │ refactor│   │ fix     │ ──▶ │ ⚙ impl   │ ──▶ │ 🔗 PR   │ ──▶ │ ✓ merged│
  │         │   │ login   │     │ ▓▓▓░ 3/5 │     │  #204   │     │         │
  └─────────┘   └─────────┘     └──────────┘     └─────────┘     └─────────┘
    manual        you drag       agents run       you approve      auto
```

**A Task is the unit of work · a Pipeline is the recipe · a Run is the card in motion.**
A full day's work should be possible without ever opening the canvas. See [docs/BOARD.md](docs/BOARD.md).

> *AgentFlow is a working name — rename freely; the app reads its name from config.*

---

## 🤖 Building this with AI (the "one command")

This repo is set up so an AI agent (Claude Code) can build it end-to-end.

1. Open this folder in **Claude Code**.
2. Type:

   ```
   follow PLAN.md
   ```

The agent reads [CLAUDE.md](CLAUDE.md) (auto-loaded) for the rules, then works through [PLAN.md](PLAN.md) **one phase at a time** — writing code + tests together, running verification, and **stopping at each phase gate** to report. Say **`continue`** to advance. Resume later by opening the repo and saying `continue`.

### What the AI knows (so you don't re-explain)
| File | Purpose |
|------|---------|
| [CLAUDE.md](CLAUDE.md) | Rules, stack, guardrails, git + security policy, Claude Agent SDK orientation |
| [PLAN.md](PLAN.md) | The ordered build phases (0→12) with tests + gates; **MVP = end of Phase 7** |
| [docs/BOARD.md](docs/BOARD.md) | ⭐ The board: tasks, columns, card-driven automation, approvals, recurring work, UI spec |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layout, data model, execution engine, variable interpolation |
| [docs/NODES.md](docs/NODES.md) | Every node type: config schema, inputs/outputs, MVP vs later |
| [docs/AGENTS.md](docs/AGENTS.md) | The AI team: roles, Claude Agent SDK usage, models/effort, the PR flow |
| [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) | GitHub API + Actions, Vercel, Netlify; secrets |
| [docs/TESTING.md](docs/TESTING.md) | Test pyramid, mocking agents/GitHub, E2E flows |
| [docs/SECURITY.md](docs/SECURITY.md) | Running code-executing agents safely; secrets; gates; sandboxing |

---

## Build phases at a glance

| Phase | Focus | Gate |
|-------|-------|------|
| 0 | Bootstrap (web + worker + DB + Agent SDK + Octokit) | All boot; sanity tests + lint green |
| 1 | Domain model & persistence (board + pipelines) | Schema/validator/repo tests; secrets encrypted |
| 2 | Pipeline editor (React Flow canvas) | Build/config/save/reload a pipeline (E2E) |
| 3 | 🗂 **Task board (Kanban)** | Add/drag/edit cards; survives reload; keyboard-only works |
| 4 | Execution engine core (runner) | Echo pipeline runs end-to-end via the queue |
| 5 | Agent node (Claude Agent SDK) | Agent runs in isolated workspace; tool use gated |
| 6 | GitHub nodes (issue/branch/commit/PR) | Handlers produce correct API calls (mocked) |
| 7 | 🎯 **Golden loop: drag a card → agents → PR → card moves** | **MVP** — the board runs itself |
| 8 | Multi-agent team (triage/plan/implement/review) | Conditional routing + bounded review loop; planner creates subtask cards |
| 9 | ⏰ Recurring work, Today view, GitHub issue sync | Cards respawn exactly once per slot; Today view live |
| 10 | Deploy & Actions gate (Vercel/Netlify, HTTP node) | Merge gated on green checks; deploy returns URL |
| 11 | Observability, retries, security hardening | Retry/resume; redaction proven; cost guard |
| 12 | Packaging & self-host (docker-compose, CI) | `docker compose up` runs the golden loop |

**Phases 0–7 = the MVP** (board + canvas + one real card-driven agent loop). 8–12 expand it.

---

## Prerequisites (human, one-time)

- **Node.js LTS** + npm
- An **AI model API key entered per pipeline** in the app (Anthropic, or any provider you choose) — or a **free local model** via **Ollama** (no key, just its address). Keys are not global env vars; you add them in each pipeline's Connections panel.
- A **GitHub token** (fine-grained PAT or GitHub App) with repo + PR permissions, for the target repos
- (Later phases) **Vercel** / **Netlify** tokens for deploy nodes
- (Optional, scale-up) **Docker** for `docker compose up`, **Redis** if you adopt BullMQ

The AI flags when a step needs a credential and uses **mocks** where possible so it can make progress (and never spend tokens/hit the network) without them.

---

## What runs where

```
web/       Next.js app — the board (default surface), the visual editor, task drawer,
           run dashboard, local API + SQLite. Writes rows; never executes.
worker/    Execution engine — walks the pipeline graph, runs agents on whichever
           provider each node names (Claude SDK, Ollama, any OpenAI-compatible API),
           calls GitHub/Vercel/Netlify, moves cards, streams logs. The only executor.
           Also the scheduler: recurring cards + cron-triggered pipelines.
packages/  Shared types, Zod schemas, graph validator, variable interpolation,
core/      card ordering + board auto-advance rules (all pure, all unit-tested)
```

---

## ⚠️ Security note (read before running live)

AgentFlow runs **AI agents that execute code and hold your tokens**. Before pointing it at real repos:
- Keep it **self-hosted and single-user** (as designed) — do not expose it publicly.
- Secrets are **encrypted at rest** and never logged; agent tool use is **gated** (destructive/outward actions require passing gates); every run is an **isolated workspace**.
- Read [docs/SECURITY.md](docs/SECURITY.md) and the operator checklist before a live run.

---

## Manual dev commands (once scaffolded)

```bash
npm test              # unit tests across web/worker/core
npm run lint
npm run dev:web       # the editor + dashboard on localhost:3000
npm run dev:worker    # the execution engine
npm run e2e           # Playwright flows
```

> `web/`, `worker/`, `packages/core/`, and these scripts don't exist yet — **Phase 0 creates them.**
