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

### Two interfaces, not one

The API and the working tree are separate concerns, so they are separate interfaces (`worker/src/github/`). Committing through the API would mean uploading blobs we already have on disk and would lose the agent's actual working tree — so anything touching files is local git.

```ts
// The API. Real impl = Octokit; test impl = MockGitHubClient.
export interface GitHubClient {
  getIssue(repo: string, issueNumber: number): Promise<GitHubIssue>;
  getRef(repo: string, ref: string): Promise<{ sha: string }>;
  getDefaultBranch(repo: string): Promise<string>;
  openPullRequest(repo: string, p: { head; base; title; body? }): Promise<{ number; url }>;
  listChecks(repo: string, ref: string): Promise<CheckRun[]>;
  mergePullRequest(repo: string, prNumber: number, method): Promise<{ merged; sha }>;
}

// The working tree. Real impl = LocalGit (git via execFile); test impl = MockGit.
export interface GitOps {
  clone(input: { repo; dir; ref?; depth? }): Promise<{ headSha: string }>;
  createBranch(dir: string, branch: string): Promise<void>;
  hasChanges(dir: string): Promise<boolean>;
  commitAll(dir, message, identity): Promise<{ sha: string } | null>;  // null = nothing to commit
  push(dir: string, branch: string): Promise<void>;
  headSha(dir: string): Promise<string>;
}
```

- **Payload mappers are pure + unit-tested** (`packages/core/src/github/mappers.ts`): GitHub issue JSON → `{{ trigger.issue }}` shape; node config → Octokit params; check runs → a verdict. Edge cases covered: missing body, no labels, deleted author, unicode titles, pasted clone URLs.
- The token is resolved **per call** (`createLazyGitHub`), not held at startup — so adding it in the UI works without restarting the worker.

### Where the token goes (and does not go)

The agent can read every file in the run workspace, so the token must never land there:

- the remote is a plain `https://github.com/owner/name.git` — **nothing secret in `.git/config`**;
- auth is an `http.<url>.extraheader` passed through **`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0` environment variables** — so it is not in `argv` either, where `ps` could read it, and never written to disk;
- the commit identity goes through `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env vars, so no config is written into the workspace;
- every git command line and every git error is passed through `redact()` before it can reach a log, scrubbing both the raw token and its base64 Basic form;
- `GIT_TERMINAL_PROMPT=0` and an empty `GIT_ASKPASS`, so a missing credential fails fast instead of hanging a run on a prompt no one can answer.

Repo names are also path input: `clone-repo` resolves `<workspace>/<name>` and re-checks containment, because `owner/..` is a legal-looking repo string.

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
