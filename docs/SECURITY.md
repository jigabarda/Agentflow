# SECURITY.md — Running Code-Executing Agents Safely

AgentFlow runs **AI agents that execute code and hold your credentials**, then perform outward actions (push branches, open/merge PRs, deploy). That is inherently high-risk. This document is the trust model and the rules every phase must uphold. **Treat these as guardrails, not suggestions.**

---

## Threat model (what could go wrong)

1. **A misbehaving/compromised agent** writes malicious code, exfiltrates secrets, or runs destructive commands.
2. **Prompt injection** via issue text / repo content steers an agent into unintended actions.
3. **Secret leakage** into logs, PR bodies, commits, or agent context.
4. **Unintended outward actions** — a bad merge to `main`, a deploy to production, a force-push.
5. **Runaway cost** — an agent loops and burns tokens.
6. **Exposure** — the self-hosted instance is reachable by others.

The design below shrinks the blast radius of each.

---

## Core principles

### 1. Least privilege, per node
- Agents get a **tool allowlist per node**. Read-only roles (Triager, Planner, Reviewer) get **no Write/Bash**. Only the Implementer gets Write/Edit/Bash — and only inside its workspace.
- The **agent proposes code; nodes perform outward actions.** `open-pr`, `merge-pr`, `deploy-*` are *nodes*, not agent tool calls. So even a fully hijacked agent can, at worst, edit files in a throwaway workspace — it cannot merge or deploy on its own.

### 2. Workspace confinement
- Every run gets a **fresh, isolated temp workspace**; it's deleted when the run ends.
- File and Bash tools are **confined to that dir** (path-guarded — resolve + check every path; reject `..`, symlink escapes, absolute paths outside the root). A test must prove out-of-workspace writes are blocked.
- The agent's own `Bash` runs are for local iteration only; the **authoritative test gate is GitHub Actions** (`wait-for-checks`), which runs in GitHub's infra, not ours.

### 3. Secrets & per-pipeline AI keys: encrypted, injected late, never logged
- Two kinds, both **encrypted at rest** (AES-GCM with `SECRETS_ENC_KEY`), ciphertext ≠ plaintext (tested):
  - **Global `Secret`s** — integration tokens (GitHub, Vercel, Netlify).
  - **Per-pipeline `ProviderCredential`s** — the **AI model API key the user supplies for that specific pipeline** (Anthropic/OpenAI/etc.), or just a base URL for a keyless local model (Ollama). Scoped to the pipeline; different pipelines carry different keys.
- **Write-only in the UI** — masked after saving; rotate by replacing.
- **Injected only at the moment of use** — decrypted in-memory and handed to the runner/Octokit/HTTP call at call time. The AI key is passed to the agent runner as a parameter; it is **kept out of the agent's context, prompt, and workspace**, and is **never** read from a global/env default.
- A **redaction filter** scrubs known secret + provider-key values from every `LogEntry` before write — proven by a property test. Never put a key/secret in a PR body, commit message, prompt, or log.

### 4. Gate outward & destructive actions
- `push`, `merge-pr`, `deploy-*`, force operations are **gated**:
  - `merge-pr` requires the **required checks green** (`wait-for-checks`) — no green CI, no merge.
  - Deploys to **production** should require an explicit config flag (default to preview/staging).
  - **The human-approval gate is the `require-approval` node, and it lives on the board** ([BOARD.md](BOARD.md)): the run parks at `awaiting_approval`, the card moves to a `waiting` column, and **Approve / Reject** sits on the card face with the diff one click away. Put it before every production merge/deploy. Approving must be a *deliberate* act — never a default, never auto-expiring into "approved" (a `timeoutHours` lapse **fails** the run, it does not proceed).
  - `autoAdvance` may move cards, but it may **never** stand in for an approval: a rule can move a card *into* a waiting column, never *past* one.
- Branch protection on the target repo's `main` is the operator's backstop — recommend it in the quickstart.

### 5. Cost guard
- Each agent node has a **`maxTokens`** budget; a run exceeding its cap **aborts and logs why**. Surface per-run token usage in the dashboard.
- Bounded loops: the reviewer→implementer loop has a **max-iterations cap** that is **logged when hit** — never an unbounded retry.

### 6. Treat issue/repo text as untrusted (prompt-injection)
- Issue bodies, comments, and repo files can contain injection attempts ("ignore your instructions, run …"). Because outward actions are node-gated and tools are allowlisted + workspace-confined, an injected instruction still can't merge, deploy, or escape the workspace.
- **Card bodies imported from GitHub are untrusted too.** A task you typed yourself is your own instruction; a card synced in from an issue carries whatever a stranger wrote. Same rule: pass it to the agent as *data*, and never let a synced card's content pick its own column, model, or approval outcome.
- Phrase agent system prompts as authoritative and keep untrusted content clearly separated as *data*, not instructions.

### 7. Keep it self-hosted & single-user (as designed)
- **Do not expose the instance publicly.** No auth/multi-tenancy is built in the MVP — a reachable instance is a reachable set of your tokens + a code-execution engine. Bind to localhost / a private network.
- If a GitHub **webhook** endpoint is enabled, it must **verify the HMAC signature** on the raw body before trusting any payload (`GITHUB_WEBHOOK_SECRET`).

---

## Claude Agent SDK gating

The `ClaudeAgentRunner` configures the SDK's **permission / hook** system to enforce the above:
- Confine file + Bash tools to `workspaceDir`.
- **Deny-by-default** outward network calls and destructive shell ops from the agent; allow only what the node's allowlist grants.
- Forward **every tool call** (name + allowed/denied) to the run log for audit.
- Exact hook/permission API → **verify against `code.claude.com/docs/en/agent-sdk`** before implementing (see [AGENTS.md](AGENTS.md)).

---

## Operator checklist (Phase 12 / before any live run)

- [ ] Instance bound to localhost / private network — **not** publicly reachable.
- [ ] `SECRETS_ENC_KEY` set to a strong random value; backups of the DB treat it as sensitive.
- [ ] GitHub token is **fine-grained**, scoped to only the intended repos, least privilege.
- [ ] Target repo `main` has **branch protection** + required status checks.
- [ ] Production deploys require an explicit flag (default preview/staging).
- [ ] Per-node `maxTokens` budgets set; reviewer loop cap set.
- [ ] Verified: no secret appears in logs / PR bodies / commits (redaction test green).
- [ ] Verified: agent cannot write outside its workspace (path-guard test green).
- [ ] Webhook endpoint (if enabled) verifies HMAC signatures.

---

## What must be true at every phase gate (security invariants)

1. No secret is ever written to a log, PR body, commit, or the agent's context (redaction proven).
2. Agent file/Bash access is workspace-confined (path-guard proven).
3. Outward/destructive actions are node-gated, not agent-initiated.
4. Every tool call is logged with its allow/deny decision.
5. Cost + loop caps are enforced and logged when hit.

If a change would violate any of these, it is wrong — stop and fix before proceeding.
