/**
 * Pure GitHub payload mappers.
 *
 * Everything here is a total function over plain data: no Octokit, no network,
 * no clock. That is deliberate — the shape of an issue in `{{ trigger.issue }}`
 * and the rules for what counts as "checks are green" are decisions worth
 * testing exhaustively, and they should not require a GitHub token to test.
 */

export class GitHubMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubMappingError";
  }
}

// ────────────────────────────────── repo ────────────────────────────────────

export interface RepoRef {
  owner: string;
  repo: string;
}

/** GitHub allows these in an owner or repository name. */
const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * `owner/name` → `{ owner, repo }`.
 *
 * Also accepts a pasted browser or clone URL, because that is what people
 * actually have on the clipboard.
 */
export function parseRepo(input: string): RepoRef {
  const trimmed = (input ?? "").trim();
  if (!trimmed) throw new GitHubMappingError("No repository given. Expected owner/name.");

  const withoutUrl = trimmed
    .replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");

  const parts = withoutUrl.split("/");
  if (parts.length !== 2) {
    throw new GitHubMappingError(`"${input}" is not a repository. Expected owner/name.`);
  }

  const [owner, repo] = parts;
  if (!owner || !repo || !NAME_PATTERN.test(owner) || !NAME_PATTERN.test(repo)) {
    throw new GitHubMappingError(`"${input}" is not a repository. Expected owner/name.`);
  }

  return { owner, repo };
}

/** The canonical `owner/name` string, for logs and error messages. */
export function formatRepo(ref: RepoRef): string {
  return `${ref.owner}/${ref.repo}`;
}

// ────────────────────────────────── issues ──────────────────────────────────

/**
 * An issue as the run context sees it: `{{ trigger.issue.title }}`.
 * Every field is present and non-null, so a template never renders "null".
 */
export interface GitHubIssue {
  number: number;
  title: string;
  /** "" when the issue has no description — GitHub sends null. */
  body: string;
  labels: string[];
  /** "" when the account was deleted; GitHub sends a null user. */
  author: string;
  state: "open" | "closed";
  url: string;
}

/** The subset of GitHub's issue JSON we depend on. Everything may be missing. */
export interface RawIssue {
  number?: number | null;
  title?: string | null;
  body?: string | null;
  state?: string | null;
  html_url?: string | null;
  user?: { login?: string | null } | null;
  labels?: (string | { name?: string | null } | null)[] | null;
}

export function mapIssue(raw: RawIssue): GitHubIssue {
  if (typeof raw?.number !== "number") {
    throw new GitHubMappingError("GitHub returned an issue with no number.");
  }

  return {
    number: raw.number,
    title: raw.title ?? "",
    body: raw.body ?? "",
    // Labels arrive either as strings or as objects, depending on the endpoint.
    labels: (raw.labels ?? [])
      .map((label) => (typeof label === "string" ? label : (label?.name ?? "")))
      .filter((name): name is string => name.length > 0),
    author: raw.user?.login ?? "",
    state: raw.state === "closed" ? "closed" : "open",
    url: raw.html_url ?? "",
  };
}

// ──────────────────────────────── branches ──────────────────────────────────

/**
 * A safe branch name from free text (usually a card title or issue title).
 *
 * Git's ref rules are stricter than they look: no `..`, no `~^:?*[\`, no
 * leading/trailing dot or slash, no `.lock` suffix, no `@{`. Rather than
 * validate and reject, we normalise — an agent should not fail a run because
 * someone titled a card "fix: the ~thing~".
 */
export function branchNameFrom(text: string, options: { prefix?: string; max?: number } = {}) {
  const max = options.max ?? 60;

  const slug = (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/^[-._/]+|[-._/]+$/g, "")
    .slice(0, max)
    .replace(/[-._/]+$/, "");

  const body = slug || "work";
  const name = options.prefix ? `${options.prefix.replace(/\/+$/, "")}/${body}` : body;

  // `.lock` is rejected by git itself, and only ever arrives by accident.
  return name.endsWith(".lock") ? `${name.slice(0, -5)}-lock` : name;
}

// ────────────────────────────── pull requests ───────────────────────────────

export interface PullRequestInput {
  head: string;
  base: string;
  title: string;
  body?: string | null;
}

export interface PullRequestParams extends RepoRef {
  head: string;
  base: string;
  title: string;
  body: string;
}

/** Node config → the params Octokit's `pulls.create` wants. */
export function toPullRequestParams(repo: string, input: PullRequestInput): PullRequestParams {
  const ref = parseRepo(repo);

  const head = (input.head ?? "").trim();
  if (!head) throw new GitHubMappingError("A pull request needs a head branch.");

  const base = (input.base ?? "").trim();
  if (!base) throw new GitHubMappingError("A pull request needs a base branch.");

  if (head === base) {
    throw new GitHubMappingError(
      `Head and base are both "${head}". A pull request needs two different branches.`,
    );
  }

  const title = (input.title ?? "").trim();
  if (!title) throw new GitHubMappingError("A pull request needs a title.");

  return { ...ref, head, base, title, body: input.body ?? "" };
}

// ──────────────────────────────── checks ────────────────────────────────────

export interface CheckRun {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
}

/**
 * `no_checks` is not padding. A repo with no CI workflow produces zero check
 * runs, and reporting that as success would tell the user their tests passed
 * when nothing ran (docs/INTEGRATIONS.md).
 */
export type ChecksState = "pending" | "success" | "failure" | "no_checks";

export interface ChecksSummary {
  state: ChecksState;
  checks: CheckRun[];
  /** Named required checks that GitHub has not reported at all yet. */
  missing: string[];
}

/** GitHub conclusions that do not block a merge. */
const PASSING = new Set(["success", "neutral", "skipped"]);

/**
 * Decide where a set of check runs stands.
 *
 * With `requiredChecks`, only those count — and a required check that has not
 * appeared yet keeps the state `pending`, because "not started" must never
 * read as "passed".
 */
export function summarizeChecks(
  checks: readonly CheckRun[],
  requiredChecks?: readonly string[],
): ChecksSummary {
  const required = (requiredChecks ?? []).filter((name) => name.trim().length > 0);

  const relevant =
    required.length > 0 ? checks.filter((c) => required.includes(c.name)) : [...checks];

  const missing = required.filter((name) => !checks.some((check) => check.name === name));

  if (relevant.length === 0 && missing.length === 0) {
    return { state: "no_checks", checks: [], missing: [] };
  }

  // Fail fast: one conclusive failure is the answer, whatever else is running.
  const failed = relevant.filter(
    (check) => check.status === "completed" && !PASSING.has(check.conclusion ?? ""),
  );
  if (failed.length > 0) return { state: "failure", checks: relevant, missing };

  const unfinished = relevant.some((check) => check.status !== "completed");
  if (unfinished || missing.length > 0) {
    return { state: "pending", checks: relevant, missing };
  }

  return { state: "success", checks: relevant, missing };
}
