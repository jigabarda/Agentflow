import type { CheckRun, GitHubIssue } from "@agentflow/core";

/**
 * The GitHub API, behind an interface so tests never touch the network.
 *
 * Note the split: this is the *API* client. Cloning, branching, committing and
 * pushing are local git operations on the run workspace and live in `git.ts` —
 * doing them through the API would mean uploading blobs we already have on
 * disk, and would lose the agent's actual working tree.
 */
export interface GitHubClient {
  getIssue(repo: string, issueNumber: number): Promise<GitHubIssue>;
  /** The SHA a ref currently points at. `ref` is a branch name or a SHA. */
  getRef(repo: string, ref: string): Promise<{ sha: string }>;
  openPullRequest(
    repo: string,
    input: { head: string; base: string; title: string; body?: string | null },
  ): Promise<{ number: number; url: string }>;
  listChecks(repo: string, ref: string): Promise<CheckRun[]>;
  mergePullRequest(
    repo: string,
    prNumber: number,
    method: "merge" | "squash" | "rebase",
  ): Promise<{ merged: boolean; sha: string }>;
  /** Default branch of the repo — the base for a PR when none is configured. */
  getDefaultBranch(repo: string): Promise<string>;
}

/** A GitHub call that failed for a reason worth showing the user. */
export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}
