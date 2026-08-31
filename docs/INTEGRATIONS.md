# INTEGRATIONS.md — GitHub, Actions, Vercel, Netlify

External systems AgentFlow talks to, and the contracts for each. All access goes through an **interface** (mockable) and uses **encrypted secrets** ([SECURITY.md](SECURITY.md)) — never hard-coded tokens.

---

## GitHub (core integration)

Access via **Octokit** (`@octokit/rest`) behind a `GitHubClient` interface. Auth with a **fine-grained PAT** or **GitHub App** token stored as an encrypted `Secret` (`GITHUB_TOKEN`).

### Token permissions needed
- **Contents: read/write** — clone, push branches.
- **Pull requests: read/write** — open/merge PRs.
- **Issues: read** (write if the Triager sets labels).
- **Checks/Actions: read** — poll check-runs for the test gate.

### `GitHubClient` interface (mockable)

```ts
export interface GitHubClient {
  getIssue(repo: string, number: number): Promise<Issue>;
  createBranch(repo: string, name: string, fromSha: string): Promise<{ ref: string }>;
  getRef(repo: string, ref: string): Promise<{ sha: string }>;
  commitAndPush(repo: string, branch: string, dir: string, message: string): Promise<{ sha: string }>;
  openPr(repo: string, p: { head: string; base: string; title: string; body: string }): Promise<{ number: number; url: string }>;
  listChecks(repo: string, ref: string): Promise<CheckRun[]>;
  mergePr(repo: string, number: number, method: "merge"|"squash"|"rebase"): Promise<{ sha: string }>;
}
```

- Real impl = Octokit. Test impl = an in-memory mock recording calls + returning scripted responses.
- **Payload mappers are pure + unit-tested** (`core/github/mappers.ts`): GitHub issue JSON → `{{ trigger.issue }}` shape; node config → Octokit params. Test edge cases: missing body, no labels, unicode titles.

### Git operations
`clone-repo` / `commit-changes` do the actual git in the workspace via **simple-git** or the agent's Bash tool. Push authenticates with the same token (via an Anthropic-side... no — via a credential helper or an authenticated remote URL; keep the token out of the workspace filesystem where possible, inject at push time).

### Tests = GitHub Actions (not our sandbox)
We do **not** host a code-execution sandbox. After the agent pushes a branch, the **target repo's own GitHub Actions** run its tests. The `wait-for-checks` node polls `listChecks(repo, headSha)` until all `requiredChecks` conclude, then returns `success` / `failure` / `timed_out`. The `merge-pr` node refuses to merge unless the required checks are green.

> If a target repo has **no** CI workflow, `wait-for-checks` has nothing to gate on — document this; either skip the gate for that pipeline or have a setup step add a workflow. Never imply tests ran when no checks exist.

---

## GitHub webhooks (issue trigger, later)

For `github-issue-trigger` to fire automatically, the self-hosted instance needs a reachable webhook endpoint (`/api/webhooks/github`) with **HMAC signature verification** (`GITHUB_WEBHOOK_SECRET`). For the MVP, a **manual "run on issue #N"** action is enough and avoids exposing an endpoint — prefer that until Phase 9+ (where board-side GitHub sync lands). If webhooks are added, verify the signature on the raw body before trusting any payload.

---

## Vercel (deploy — Phase 10)

Two options; pick per pipeline:
- **Deploy Hook (simplest):** a `POST` to a project's deploy-hook URL (stored as a secret). No token scope to manage. Returns a job; poll the deployment for its URL/state.
- **REST API:** `POST /v13/deployments` with a `VERCEL_TOKEN` secret; response includes the deployment URL + `readyState`.

`deploy-vercel` node → `{ deploymentUrl, state }`. Contract lives in `core/integrations/vercel.ts`; tested against a mock.

---

## Netlify (deploy — Phase 10)

- **Build Hook:** `POST` to a build-hook URL (secret) → triggers a build.
- **REST API:** `POST /api/v1/sites/{site_id}/builds` (or deploys) with a `NETLIFY_TOKEN` secret; poll for the deploy URL + `state`.

`deploy-netlify` node → `{ deployUrl, state }`. Contract in `core/integrations/netlify.ts`; mocked in tests.

---

## Generic HTTP (`http-request` node)

For **any** other API/endpoint/backend (a custom deploy target, a Slack notify, a status webhook, provisioning a domain, etc.). Config: `method`, `url`, `headers`, `body`, `secretRefs` — all `{{interpolatable}}`. `secretRefs` inject decrypted secrets into headers/body at call time and are **never logged**. Output: `{ status, headers, body }`. This is the escape hatch that keeps the node set small while covering "set an API/endpoint/variables on a node" for arbitrary services.

---

## Secrets used by integrations

**Global `Secret` store** (integration tokens, encrypted — set via the secrets UI or `.env`):

| Secret | Used by |
|--------|---------|
| `GITHUB_TOKEN` | all GitHub nodes |
| `GITHUB_WEBHOOK_SECRET` | webhook verification (if enabled) |
| `VERCEL_TOKEN` / deploy-hook URL | `deploy-vercel` |
| `NETLIFY_TOKEN` / build-hook URL | `deploy-netlify` |
| arbitrary | `http-request` via `secretRefs` |

**Per-pipeline `ProviderCredential`** (the AI model API keys — entered in each pipeline's **Connections / API keys** panel, encrypted, scoped to the pipeline, **not** global env vars):

| Credential | Used by |
|------------|---------|
| provider API key (Anthropic / OpenAI / Gemini / Groq / OpenRouter …) | `agent` nodes using that provider |
| base URL only, no key (e.g. Ollama `http://localhost:11434`) | `agent` nodes using a local/free model |

All keys are encrypted at rest (AES-GCM with `SECRETS_ENC_KEY`), write-only in the UI, and injected in-memory at call time. AI keys are resolved from the run's pipeline — never from a global env default. See [SECURITY.md](SECURITY.md) and [AGENTS.md](AGENTS.md) → *The API key is supplied per pipeline*.
