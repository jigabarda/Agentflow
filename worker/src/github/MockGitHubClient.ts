import type { CheckRun, GitHubIssue } from "@agentflow/core";
import type { GitHubClient } from "./GitHubClient";
import { GitHubError } from "./GitHubClient";
import type { CloneInput, CommitIdentity, GitOps } from "./git";

/**
 * Test doubles for everything that would otherwise touch GitHub or the disk.
 *
 * They record what was asked of them, so a handler test can assert on the calls
 * a node makes rather than on a network fixture. No token, no network, no repo.
 */

export interface RecordedCall {
  method: string;
  args: unknown[];
}

export interface MockGitHubScript {
  issues?: Record<string, GitHubIssue>;
  refs?: Record<string, string>;
  defaultBranch?: string;
  pullRequest?: { number: number; url: string };
  /** One entry per `listChecks` call, in order; the last repeats. */
  checks?: CheckRun[][];
  merge?: { merged: boolean; sha: string };
  /** Method name → error to throw instead of answering. */
  failures?: Partial<Record<keyof GitHubClient, Error>>;
}

export class MockGitHubClient implements GitHubClient {
  readonly calls: RecordedCall[] = [];
  private checkCall = 0;

  constructor(private readonly script: MockGitHubScript = {}) {}

  private record(method: keyof GitHubClient, ...args: unknown[]): void {
    this.calls.push({ method, args });
    const failure = this.script.failures?.[method];
    if (failure) throw failure;
  }

  /** Every call to `method`, for assertions. */
  callsTo(method: keyof GitHubClient): RecordedCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  /** The first call to `method`, failing the test if it never happened. */
  firstCallTo(method: keyof GitHubClient): RecordedCall {
    const call = this.callsTo(method)[0];
    if (!call) throw new Error(`expected a call to ${method}, but there was none`);
    return call;
  }

  async getIssue(repo: string, issueNumber: number): Promise<GitHubIssue> {
    this.record("getIssue", repo, issueNumber);
    const issue = this.script.issues?.[String(issueNumber)];
    if (!issue) throw new GitHubError(`No scripted issue #${issueNumber}`, 404);
    return issue;
  }

  async getRef(repo: string, ref: string): Promise<{ sha: string }> {
    this.record("getRef", repo, ref);
    return { sha: this.script.refs?.[ref] ?? "sha-for-" + ref };
  }

  async getDefaultBranch(repo: string): Promise<string> {
    this.record("getDefaultBranch", repo);
    return this.script.defaultBranch ?? "main";
  }

  async openPullRequest(
    repo: string,
    input: { head: string; base: string; title: string; body?: string | null },
  ): Promise<{ number: number; url: string }> {
    this.record("openPullRequest", repo, input);
    return this.script.pullRequest ?? { number: 1, url: `https://github.com/${repo}/pull/1` };
  }

  async listChecks(repo: string, ref: string): Promise<CheckRun[]> {
    this.record("listChecks", repo, ref);
    const scripted = this.script.checks;
    if (!scripted || scripted.length === 0) return [];
    // Walk the script, then hold on the final state.
    const index = Math.min(this.checkCall, scripted.length - 1);
    this.checkCall += 1;
    return scripted[index] ?? [];
  }

  async mergePullRequest(
    repo: string,
    prNumber: number,
    method: "merge" | "squash" | "rebase",
  ): Promise<{ merged: boolean; sha: string }> {
    this.record("mergePullRequest", repo, prNumber, method);
    return this.script.merge ?? { merged: true, sha: "merge-sha" };
  }
}

export interface MockGitScript {
  headSha?: string;
  commitSha?: string;
  hasChanges?: boolean;
  failures?: Partial<Record<keyof GitOps, Error>>;
}

export class MockGit implements GitOps {
  readonly calls: RecordedCall[] = [];

  constructor(private readonly script: MockGitScript = {}) {}

  private record(method: keyof GitOps, ...args: unknown[]): void {
    this.calls.push({ method, args });
    const failure = this.script.failures?.[method];
    if (failure) throw failure;
  }

  callsTo(method: keyof GitOps): RecordedCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  /** The first call to `method`, failing the test if it never happened. */
  firstCallTo(method: keyof GitOps): RecordedCall {
    const call = this.callsTo(method)[0];
    if (!call) throw new Error(`expected a call to ${method}, but there was none`);
    return call;
  }

  async clone(input: CloneInput): Promise<{ headSha: string }> {
    this.record("clone", input);
    return { headSha: this.script.headSha ?? "clone-sha" };
  }

  async createBranch(dir: string, branch: string): Promise<void> {
    this.record("createBranch", dir, branch);
  }

  async hasChanges(dir: string): Promise<boolean> {
    this.record("hasChanges", dir);
    return this.script.hasChanges ?? true;
  }

  async commitAll(
    dir: string,
    message: string,
    identity: CommitIdentity,
  ): Promise<{ sha: string } | null> {
    this.record("commitAll", dir, message, identity);
    if (this.script.hasChanges === false) return null;
    return { sha: this.script.commitSha ?? "commit-sha" };
  }

  async push(dir: string, branch: string): Promise<void> {
    this.record("push", dir, branch);
  }

  async headSha(dir: string): Promise<string> {
    this.record("headSha", dir);
    return this.script.headSha ?? "head-sha";
  }
}
