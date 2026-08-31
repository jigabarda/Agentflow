# AGENTS.md — The AI Team & Claude Agent SDK Usage

How AgentFlow's "virtual dev team" works: the agent roles, how they map to the **Claude Agent SDK**, which models/effort to use, and the issue→PR flow. This is the AI-specific spec (the analog of a tools catalog).

---

## ⚠️ First: the Claude Agent SDK is a distinct product — verify its API

- **Package:** `@anthropic-ai/claude-agent-sdk` (TypeScript). It is **Claude Code packaged as a library** — it ships the built-in tools (Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch), the full agent loop, context management, **hooks**, **subagents**, **permissions**, **sessions**, and **MCP** support. You give it a prompt + options and it drives everything.
- **It is NOT the Anthropic API SDK** (`@anthropic-ai/sdk`). Don't confuse the two. The API SDK is for single model calls; the **Agent SDK** is the harness we want for code-editing agents.
- **It is a harness only — you host and deploy it.** That's why it fits our self-hosted worker: agents clone repos and run git/tests locally (with test execution delegated to GitHub Actions).
- **Source of truth for exact API (options, function names, hook/subagent shapes): `code.claude.com/docs/en/agent-sdk`.** Before writing SDK code in Phase 4, **read the docs (or invoke the `claude-api` skill) and confirm signatures. Do not invent option names.** This doc describes intent + configuration; the docs give the exact surface.

**Auth:** the runner passes **the pipeline's own API key** to the SDK explicitly (resolved from that pipeline's `ProviderCredential` at call time) — it does **not** rely on a global `ANTHROPIC_API_KEY` env var or an `ant auth login` profile. Keys are per-pipeline, encrypted at rest, and injected in-memory only. Never hard-code keys. See *The API key is supplied per pipeline* below.

---

## ⭐ Configurable agents & per-node model selection (a core feature)

**The user configures which AI model/agent does each task in the pipeline.** This is first-class, not an afterthought — it's a headline capability of the product. There are two layers:

> ⚠️ **No default model — configuration is mandatory.** There is **no preconfigured/default AI model**. The user must explicitly choose a provider + model on every agent node (or assign a profile that has one) **before the node — and the pipeline — can run**. An agent node with no model set is **invalid**: the graph validator rejects it, the editor flags it ("Set a model"), and the runner refuses to execute it. This is deliberate — no AI silently runs (and no cost is silently incurred) without the user's explicit choice.

### 🔑 The API key is supplied per pipeline
For each provider a pipeline uses, **the user enters that provider's API key on the pipeline itself** (a per-pipeline **Connections / API keys** panel). This is stored as a `ProviderCredential` scoped to that pipeline ([ARCHITECTURE.md](ARCHITECTURE.md)) — **encrypted at rest, write-only, never logged**, and injected into the runner only in-memory at call time. So:
- Each pipeline carries the keys for exactly the models it uses; different pipelines can use different keys/accounts.
- A **free local model (Ollama)** needs no key — just its base URL (e.g. `http://localhost:11434`).
- **Pre-run readiness:** before a run starts, every provider used by an agent node must have a matching pipeline credential (a key for hosted providers, a base URL for local). If one is missing, the run is blocked with a clear "add your <provider> API key to this pipeline" message — the runner **never** falls back to a global/env key.

### 1. Per-node configuration (always available)
Every `agent` node exposes, in the editor's config panel:
- **Model** — a **required** dropdown of the available models across configured providers (Claude models like `claude-opus-4-8`/`claude-haiku-4-5`; free local Ollama models; free-tier models). **No default** — the node is invalid until one is picked. See the `claude-api` skill for the live Claude list.
- **Effort** — `low | medium | high | xhigh | max` (this one may default to `high`; `xhigh` for hard coding).
- **System prompt / role** — what this agent does.
- **Tool allowlist** — which built-in tools it may use (Read/Write/Edit/Grep/Glob/Bash…).
- **Input mapping** — which run-context values flow into the prompt (`{{ trigger.issue.body }}`, `{{ nodes.planner.output.tasks }}`, …).
- **`maxTokens`** — per-node cost guard.

So a single pipeline can mix models: a **Haiku** triager, an **Opus/xhigh** implementer, an **Opus/high** reviewer — the user chooses each.

### 2. Reusable Agent Profiles (define once, drop onto many nodes)
An **Agent Profile** is a saved, named agent definition (model + effort + system prompt + tool allowlist). The user builds a small **library** of agents (e.g. "Senior Implementer", "Cheap Triager", "Strict Reviewer") in an **Agents** panel, then an `agent` node just **references a profile by id** — or overrides any field inline for that one node.

- Editing a profile updates every node that references it (with versioning so in-flight runs are stable — mirror the pattern in [ARCHITECTURE.md](ARCHITECTURE.md)).
- A node's effective config = `profile fields` merged with any inline `overrides`.
- Data model: `AgentProfile` table; `agent` node config carries `{ agentProfileId?, overrides? }` **or** a fully inline config. See [ARCHITECTURE.md](ARCHITECTURE.md) → Data model and [NODES.md](NODES.md) → `agent`.

### Any model — including free & local ones (provider-agnostic by design)
**The model is never hard-coded — `claude-opus-4-8` is only a *default*. The user can change every agent node's model, including to a free or local one.** `provider`/`model` are plain data on the `AgentRunner` interface (below), and the worker picks the runner implementation by `provider`. Two runner implementations are planned:

- **`ClaudeAgentRunner`** — wraps the **Claude Agent SDK** (Claude family). Paid, best coding quality, built-in tools.
- **`OpenAICompatibleRunner`** — any `POST {baseUrl}/chat/completions` endpoint: free local models (Ollama, LM Studio) and free hosted tiers (Groq, OpenRouter, Together, DeepSeek). Ships with its own agent loop and workspace-confined file tools.
- **`GenericToolAgentRunner`** — a provider-agnostic tool-use agent loop that drives **OpenAI-compatible endpoints**, so it covers:
  - **Local / open-source models via Ollama** (Llama, Qwen2.5-Coder, DeepSeek-Coder, …) → **$0 tokens**, runs on the user's machine.
  - **Free API tiers** (e.g. Gemini free tier, Groq, OpenRouter free models).
  - Other paid providers (OpenAI, etc.) if the user wants them.

So the editor's model dropdown is populated from whatever providers are configured — Claude, a local Ollama model, a free-tier model — and the user picks per node.

**Honest capability tradeoff (surface this in the UI, don't hide it):** cheap/free/local models are fine for **triage, classification, labeling, summarizing, and simple edits**, but **autonomous multi-file code implementation is hard** — small free models produce noticeably worse PRs and often can't get tests to pass. The right pattern is **mix models by difficulty**: a free/local model for the easy nodes, a strong (paid) model only for the hard implementation step — or accept lower quality everywhere to run fully free. The point of per-node model selection is to let the user make exactly that cost-vs-quality tradeoff.

> **Scope note:** the MVP ships the `ClaudeAgentRunner` only; `GenericToolAgentRunner` (free/local model support) is a first-class follow-on. Keep the graph/engine/handlers provider-neutral from day one so it slots in without rework — never write "Claude" into anything except the default config value.

---

## Models & effort (suggestions the user may pick — NOT defaults)

The table below is **guidance shown to help the user choose** — the app does **not** preset any of it. The user must pick a model on each node.

| Use | Suggested model | Effort | Why |
|-----|-------|--------|-----|
| Implementer, Reviewer (coding/agentic) | a strong model, e.g. `claude-opus-4-8` | `xhigh` (Implementer) / `high` (Reviewer) | Best coding + long-horizon agentic quality; `xhigh` is the sweet spot for hard coding |
| Planner (task breakdown) | a strong model, e.g. `claude-opus-4-8` | `high` | Strong reasoning; not as token-hungry as `xhigh` |
| Triager (classify/label/route) | a cheap/free model, e.g. `claude-haiku-4-5` or a local Ollama model | `low` | Simple classification — great candidate to run free |

- **No node has a preset model.** These are only recommendations surfaced in the UI; the user must actively choose (see the mandatory-configuration note above).
- **The model is always node config, never hard-coded.** Don't bake a model or provider into the graph/engine/handlers — and don't fall back to one when unset (fail validation instead).
- **Never silently pick or downgrade a model** — surface the cost/quality tradeoff and let the user choose. A per-node `maxTokens` cost guard is the right lever ([SECURITY.md](SECURITY.md)); for $0 runs, the lever is choosing a free/local model.
- For the authoritative, up-to-date Claude model list, see the `claude-api` skill.

---

## The team (agent roles)

Each role is an `agent` node preset (Phase 8 formalizes presets; Phase 7 ships just the Implementer).

### 🧭 Triager — 🔵
- **Job:** read the issue, classify it (bug / feature / chore), decide if it's actionable, optionally set labels, and route (via a `condition` node).
- **Tools:** read-only (no file writes, no Bash). Cheapest model.
- **Output:** `{ type, actionable: boolean, suggestedLabels, routeHandle }`.

### 🗺️ Planner — 🔵
- **Job:** turn the issue into a concrete, ordered task list + acceptance criteria for the implementer; draft the PR description.
- **Tools:** Read/Grep/Glob over the cloned repo (understand the code); no writes.
- **Output:** `{ tasks: string[], acceptance: string[], prBody: string }`.

### 🛠️ Implementer — 🟢 (the MVP agent)
- **Job:** implement the issue in the cloned repo — edit files, add tests, make it work.
- **Tools:** Read, Write, Edit, Grep, Glob, **Bash** (for git + running the project's checks locally). **Workspace-scoped** — cannot touch anything outside the run's dir.
- **System prompt (starting point):**
  > You are a senior software engineer. Implement the following issue in this repository. Read the relevant code first, make the smallest correct change that fully satisfies the issue, add or update tests, and keep the diff focused. Do not refactor unrelated code. When done, summarize what you changed and why.
- **Output:** `{ result, filesChanged, usage }`. The diff is committed by the `commit-changes` node.

### 🔍 Reviewer — 🔵
- **Job:** review the implementer's diff against the plan/acceptance criteria; approve or request changes.
- **Tools:** Read/Grep/Glob + read the diff; no writes.
- **Output:** `{ verdict: "approve"|"request-changes", comments: string[] }`.
- **Loop:** on `request-changes`, a `condition` node routes back to the Implementer with the comments — **bounded** by a max-iterations cap that is **logged** when hit (never silent).

---

## The golden flow (Phase 7 MVP)

```
github-issue-trigger → read-issue → clone-repo → agent(Implementer)
   → create-branch → commit-changes(push) → open-pr
```

1. Issue triggers the run; `read-issue` loads it into `{{ trigger.issue }}`.
2. `clone-repo` clones the target repo into the isolated workspace.
3. The **Implementer** agent runs `query()` in that workspace, editing files to satisfy the issue.
4. `create-branch` + `commit-changes` push the diff; `open-pr` opens the PR (body can come from the plan).
5. Run detail shows live logs, step status, and the PR link.

## The full flow (Phases 7–8)

```
issue → Triager → [condition: actionable?] → Planner → Implementer
      → commit → open-pr → wait-for-checks (GitHub Actions)
      → Reviewer → [condition: approve?] ──approve──▶ merge-pr → deploy-vercel/netlify
                                          └─request-changes─▶ back to Implementer (bounded)
```

Tests are executed by **GitHub Actions** (the `wait-for-checks` node polls the result) — AgentFlow does not host a code sandbox; the agent's own local `Bash` runs are for iterating, the authoritative gate is Actions.

---

## Wrapping the SDK: the `AgentRunner` interface

The worker never calls the SDK directly from a handler. It goes through an interface so tests inject a mock (no tokens, no network):

```ts
export interface AgentRunResult {
  result: string;
  filesChanged: string[];
  usage: { tokens: number };
  toolCalls: { name: string; allowed: boolean }[];  // for logging + gating audit
}

export interface AgentRunner {
  run(opts: {
    workspaceDir: string;
    systemPrompt: string;
    userPrompt: string;
    provider: string;        // "claude" for the MVP — data, so other providers slot in later
    model: string;           // user-selected per node/profile, e.g. "claude-opus-4-8"
    apiKey?: string;         // resolved from THIS pipeline's ProviderCredential, decrypted in-memory at call time
    baseUrl?: string;        // for local/compatible endpoints (e.g. Ollama http://localhost:11434)
    effort: string;
    allowedTools: string[];
    maxTokens?: number;
    onEvent?: (e: AgentEvent) => void;   // stream to LogEntry
  }): Promise<AgentRunResult>;
}
```

`provider`/`model` are inputs, not hard-coded — the worker picks the runner by `provider`, and an unknown one fails with the list of available runners rather than defaulting to Claude. The **`apiKey` comes from the pipeline the run belongs to** (its `ProviderCredential` for this provider), decrypted only in-memory and passed at call time — never read from a global env default, never written to the workspace, never logged. Keyless local providers pass only `baseUrl`.

- **Real impl** (`ClaudeAgentRunner`) wraps `@anthropic-ai/claude-agent-sdk` `query()` with **permission/hook** config that: confines file/Bash to `workspaceDir`, denies-by-default outward network + destructive ops, and forwards every tool call to `onEvent` for logging. Exact hook/permission API → verify in the SDK docs.
- **Mock impl** (`MockAgentRunner`) returns scripted results for tests and simulates tool-allow/deny + a `filesChanged` set.

---

## Gating & safety (summary — full detail in [SECURITY.md](SECURITY.md))

- **Workspace confinement:** agents operate only inside the per-run dir; writes/paths outside are denied.
- **Tool allowlist per node:** e.g. Triager/Planner/Reviewer get read-only tools; only the Implementer gets Write/Edit/Bash.
- **Outward/destructive actions are node-level, not agent-level:** the agent proposes code; *nodes* (`open-pr`, `merge-pr`, `deploy-*`) perform outward actions, each gated. This keeps the blast radius of a misbehaving agent to "edited files in a throwaway workspace."
- **Cost guard:** per-node `maxTokens`; a run that exceeds its budget aborts and logs why.
- **Every tool call is logged** (name + allowed/denied) for audit.

---

## The crew (Phase 8)

Four roles, as presets in `web/src/nodes/presets.ts`. A preset seeds the prompt,
the tools and a suggested effort — and **never a provider or a model**, because
that choice is the user's on every node.

| Role | Tools | Suggested effort | Why |
|------|-------|------------------|-----|
| **Triager** | none | `low` | Runs on every card; the one to keep cheap. |
| **Planner** | read-only | `medium` | Reads the repo to plan realistically, writes nothing. |
| **Implementer** | read + write | `xhigh` | The work itself. Not the place to economise. |
| **Reviewer** | read-only | `high` | A reviewer that can edit is not a reviewer. |

The reviewer is asked to begin its reply with one word — `APPROVED` or
`CHANGES` — and a `condition` node routes on it. `CHANGES` is listed first
because the first match wins, and an answer nobody can parse falls through to
`CHANGES`: the safe default is more work, never a merge.

Seed the whole crew with `POST /api/boards/{id}/crew`. The canvas has no control
for marking an edge as a loop yet, so that seed is currently the only way to
build one — a gap worth closing.
