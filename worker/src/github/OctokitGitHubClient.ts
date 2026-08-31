import { Octokit } from "@octokit/rest";
import { mapIssue, parseRepo, type CheckRun, type GitHubIssue } from "@agentflow/core";
import { GitHubError, type GitHubClient } from "./GitHubClient";

/**
 * The real client.
 *
 * It is deliberately thin: every decision worth testing (what an issue looks
 * like in the run context, what "checks are green" means) lives in the pure
 * mappers in core, so this file has almost nothing to get wrong.
 */
export class OctokitGitHubClient implements GitHubClient {
  private readonly octokit: Octokit;

  constructor(token: string, octokit?: Octokit) {
    this.octokit = octokit ?? new Octokit({ auth: token, userAgent: "agentflow" });
  }

  async getIssue(repo: string, issueNumber: number): Promise<GitHubIssue> {
    const { owner, repo: name } = parseRepo(repo);
    const response = await this.call(() =>
      this.octokit.issues.get({ owner, repo: name, issue_number: issueNumber }),
    );
    return mapIssue(response.data);
  }

  async getRef(repo: string, ref: string): Promise<{ sha: string }> {
    const { owner, repo: name } = parseRepo(repo);
    // `commits.get` resolves a branch, tag or SHA alike, so one call covers all.
    const response = await this.call(() =>
      this.octokit.repos.getCommit({ owner, repo: name, ref }),
    );
    return { sha: response.data.sha };
  }

  async getDefaultBranch(repo: string): Promise<string> {
    const { owner, repo: name } = parseRepo(repo);
    const response = await this.call(() => this.octokit.repos.get({ owner, repo: name }));
    return response.data.default_branch;
  }

  async openPullRequest(
    repo: string,
    input: { head: string; base: string; title: string; body?: string | null },
  ): Promise<{ number: number; url: string }> {
    const { owner, repo: name } = parseRepo(repo);
    const response = await this.call(() =>
      this.octokit.pulls.create({
        owner,
        repo: name,
        head: input.head,
        base: input.base,
        title: input.title,
        body: input.body ?? "",
      }),
    );
    return { number: response.data.number, url: response.data.html_url };
  }

  async listChecks(repo: string, ref: string): Promise<CheckRun[]> {
    const { owner, repo: name } = parseRepo(repo);
    const response = await this.call(() =>
      this.octokit.checks.listForRef({ owner, repo: name, ref, per_page: 100 }),
    );
    return response.data.check_runs.map((run) => ({
      name: run.name,
      status: run.status as CheckRun["status"],
      conclusion: run.conclusion ?? null,
    }));
  }

  async mergePullRequest(
    repo: string,
    prNumber: number,
    method: "merge" | "squash" | "rebase",
  ): Promise<{ merged: boolean; sha: string }> {
    const { owner, repo: name } = parseRepo(repo);
    const response = await this.call(() =>
      this.octokit.pulls.merge({
        owner,
        repo: name,
        pull_number: prNumber,
        merge_method: method,
      }),
    );
    return { merged: response.data.merged, sha: response.data.sha };
  }

  /**
   * Turn Octokit's errors into something a user can act on.
   * The token itself never appears in an Octokit error, and we do not add it.
   */
  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const status = (error as { status?: number }).status;
      const message = (error as { message?: string }).message ?? String(error);

      if (status === 401) {
        throw new GitHubError("GitHub rejected the token (401). Check GITHUB_TOKEN.", status);
      }
      if (status === 403) {
        throw new GitHubError(
          `GitHub refused the request (403). The token is probably missing a permission, or you are rate limited. ${message}`,
          status,
        );
      }
      if (status === 404) {
        throw new GitHubError(
          `GitHub returned 404. The repository or item does not exist, or the token cannot see it.`,
          status,
        );
      }
      throw new GitHubError(
        `GitHub request failed${status ? ` (${status})` : ""}: ${message}`,
        status,
      );
    }
  }
}
