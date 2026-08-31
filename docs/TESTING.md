# TESTING.md — Test Strategy, Commands & E2E Flows

How AgentFlow proves it works — from pure functions up to full pipeline runs — **without spending tokens or hitting the network** in the fast tests. Every phase in [PLAN.md](../PLAN.md) references this.

---

## Test pyramid

```
         ▲  few, slow, high-confidence
        /E2E \      Playwright — build a pipeline, drive a run (mocked agents/GitHub)
       /-------\
      /Integr.  \   Runner + handlers wired with MOCK AgentRunner + MOCK GitHubClient
     /-----------\
    /   Unit /     \  MOST tests: core (graph, interpolation, mappers, schemas),
   /  component     \ handlers in isolation, repositories, components
   ──────────────────  many, fast, run on every save
```

**Golden rule:** the graph validator, variable interpolation, payload mappers, and node config schemas are **pure** and get thorough unit coverage. Everything external (Claude Agent SDK, GitHub, HTTP, deploys) is reached through an **injected interface** so tests use mocks. **No unit/integration test spends tokens or makes a network call.**

---

## What each layer tests

| Layer | Tooling | Targets | Runs |
|-------|---------|---------|------|
| Unit (pure) | Vitest | `core/{graph,interpolate,schemas,github/mappers,integrations}` | every save / CI |
| Unit (handlers) | Vitest | each `worker/src/handlers/*` with mock `AgentRunner`/`GitHubClient` | every save / CI |
| Repository | Vitest | `web/src/data/*` against a temp SQLite DB | every save / CI |
| Component | Vitest + Testing Library | editor config forms, node registry | every save / CI |
| Integration | Vitest | the Runner executing whole pipelines with mocks | CI |
| E2E | Playwright | board flows (add/drag/approve) + build-a-pipeline + drive-a-run, mocked backend | CI |
| Live smoke (opt-in) | manual | one real agent run / real PR, only when creds are set | pre-release / manual |

---

## The two critical mocks

Everything expensive or external hides behind these — inject them in tests, use the real impl in prod.

- **`MockAgentRunner`** (for the Claude Agent SDK): returns scripted `{ result, filesChanged, usage, toolCalls }`; can simulate a tool being denied and a token-cap abort. No SDK, no tokens.
- **`MockGitHubClient`** (for Octokit): in-memory; records calls and returns scripted issues/branches/PRs/checks. No network.

If a test needs the network or a token to pass, it's wrong — refactor to inject a mock.

---

## Commands

```bash
# Unit + component (all workspaces)
npm test
npm run test:core                 # pure logic only — fastest
npm run test:web -- src/data      # repositories
npm run test:worker -- handlers   # node handlers with mocks
npm run test:worker -- engine     # the runner
npx vitest --watch                # TDD mode

# Lint
npm run lint

# E2E
npm run e2e                       # all Playwright specs
npm run e2e -- golden-loop.spec.ts # one flow

# Build sanity
npm --workspace web run build
```

> **Windows note:** all are npm scripts, identical in PowerShell or Bash. Playwright needs its browsers (`npx playwright install`).

---

## Coverage gates

- **`core` (graph, interpolate, mappers, schemas): 100% of the documented cases** — happy + every error/edge path.
- **Handlers: every handler** has a mock-driven test for its success path + at least one failure path.
- **Repositories: round-trip + the secrets-redaction test** are mandatory.
- Don't chase a global % on UI screens — assert **behavior** (form renders required fields, invalid graph blocks save, run shows the PR link).

A phase gate is green only when the phase's listed tests **actually run and pass** (paste output).

---

## Interpolation — required cases (`core/interpolate.ts`)

- `{{ pipeline.vars.x }}`, `{{ trigger.issue.title }}`, `{{ nodes.<id>.output.y }}` resolve.
- Nested/dotted paths; array/object values stringify predictably.
- **Missing path → a friendly, catchable error** (never a crash, never silent `undefined`).
- Escaped literal `{{ }}`; empty template; adjacent templates in one string.

---

## Graph validator — required cases (`core/graph.ts`)

Unique node ids · dangling edge (source/target missing) · zero triggers · multiple triggers · a cycle (must be rejected — pipelines are DAGs) · a valid linear + a valid branching graph (must pass).

---

## Golden E2E journeys

### `editor.spec.ts` — build & persist (Phase 2)
Open editor → add trigger + agent node → connect → configure both → save → reload → the graph (nodes/edges/config) is intact.

### `board.spec.ts` — the daily driver (Phase 3)
Quick-add a card → drag it two columns right → reload → still in the right column and order. Open the drawer, edit the brief, reload → persisted. Assert a rejected move (blocked card into a `working` column) **rolls back** to its original column with a visible reason. Drive one whole pass by keyboard only (`n`, `j/k`, `Enter`, `1`–`9`).

### `golden-loop.spec.ts` — the MVP run (Phase 7)
With **mock agent + mock GitHub** wired into the worker: drag a card into the automated column → its live badge advances step by step → the card **auto-moves to Review** carrying a PR chip, and the drawer timeline shows every agent step. Also assert the failure path: a mid-run error surfaces `✗ failed at <node>` on the card face, applies `onRunFailed`, and gives a clear reason.

### `approval.spec.ts` — the human gate (Phase 7)
A run hits `require-approval` → card lands in the waiting column with Approve/Reject on its face → **Approve** resumes at the correct next node; **Reject** fails the run with the typed comment as the recorded reason. Assert the run never advances past the gate on its own.

### `team-run.spec.ts` — multi-agent (Phase 8)
Triage → plan → implement → review → PR runs; a "request-changes" verdict loops back to the implementer once (bounded), then proceeds. Assert the loop cap is logged, and that the planner's breakdown appears as linked subtask cards.

### `today.spec.ts` — recurring work (Phase 9)
Set a card to recur → advance the **injected** clock → exactly one child card appears in the right column (and still exactly one after a second tick in the same slot) → Today view lists it as due with a working ▶ Run.

### `dashboard.spec.ts` — observability (Phase 11)
Run history lists runs; drilling in shows steps, logs (secrets redacted), token usage; a failed run can be retried from the failed step.

---

## Live smoke tests (opt-in, never in the fast suite)

Only when the operator has set real creds:
- **Agent smoke** (`ANTHROPIC_API_KEY`): run a trivial Implementer task in a scratch workspace; confirm it edits a file.
- **GitHub smoke** (`GITHUB_TOKEN` + a throwaway repo with a simple open issue): run the golden pipeline; confirm a **real PR** opens — paste the URL.

If creds are absent, the phase is verified **via mocks** and the report must say so explicitly and name what a live run needs. **Never imply a live run happened when it didn't.**

---

## CI (Phase 12)

`.github/workflows/ci.yml` on every PR: `npm ci` → `lint` → `test:core` + `test:web` + `test:worker` → `web build` → `e2e` (Playwright headless, mocked backend). Live agent/GitHub smoke tests are **manual/nightly** (they need secrets + spend tokens) — document that they are not part of PR CI; do not imply they ran.

---

## Determinism rules

- No `Date.now()` / `Math.random()` inside tested pure logic — inject a clock/id generator.
- Mock the `AgentRunner` and `GitHubClient` — never the real SDK/Octokit in fast tests.
- Seed any fixture data explicitly; don't depend on wall-clock or ordering of parallel writes.
