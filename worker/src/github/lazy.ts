import type { CheckRun, GitHubIssue } from "@agentflow/core";
import type { GitHubClient } from "./GitHubClient";
import { OctokitGitHubClient } from "./OctokitGitHubClient";
import { LocalGit, type CloneInput, type CommitIdentity, type GitOps } from "./git";

/**
 * GitHub access that resolves its token at the moment of use.
 *
 * Two reasons this is not just `new OctokitGitHubClient(token)` at startup:
 *   · the token is decrypted only when a call actually needs it, never held
 *     for the process lifetime (docs/SECURITY.md);
 *   · adding the token in the UI takes effect on the next run, with no worker
 *     restart — which is what a self-hosted single user expects.
 */

export interface LazyGitHubOptions {
  /** Decrypts the stored GITHUB_TOKEN. Returns null when none is configured. */
  loadToken: () => Promise<string | null>;
  log?: (message: string) => void;
  /** Injected by tests, so no test can reach the network or run git. */
  createClient?: (token: string) => GitHubClient;
  createGit?: (token: string) => GitOps;
}

export class MissingGitHubTokenError extends Error {
  constructor() {
    super(
      "No GitHub token is configured. Add GITHUB_TOKEN in Secrets (or in .env) — GitHub nodes cannot run without it.",
    );
    this.name = "MissingGitHubTokenError";
  }
}

export function createLazyGitHub(options: LazyGitHubOptions): {
  client: GitHubClient;
  git: GitOps;
} {
  const makeClient = options.createClient ?? ((token: string) => new OctokitGitHubClient(token));
  const makeGit =
    options.createGit ??
    ((token: string) => new LocalGit(token, options.log ? { log: options.log } : {}));

  let cachedToken: string | null = null;
  let cachedClient: GitHubClient | null = null;
  let cachedGit: GitOps | null = null;

  /** Resolve the token, rebuilding both clients whenever it has changed. */
  async function resolve(): Promise<void> {
    const value = await options.loadToken();
    if (!value) throw new MissingGitHubTokenError();

    if (value !== cachedToken) {
      cachedToken = value;
      cachedClient = makeClient(value);
      cachedGit = makeGit(value);
    }
  }

  async function api(): Promise<GitHubClient> {
    await resolve();
    return cachedClient as GitHubClient;
  }

  async function git(): Promise<GitOps> {
    await resolve();
    return cachedGit as GitOps;
  }

  const client: GitHubClient = {
    async getIssue(repo: string, issueNumber: number): Promise<GitHubIssue> {
      return (await api()).getIssue(repo, issueNumber);
    },
    async getRef(repo: string, ref: string): Promise<{ sha: string }> {
      return (await api()).getRef(repo, ref);
    },
    async getDefaultBranch(repo: string): Promise<string> {
      return (await api()).getDefaultBranch(repo);
    },
    async openPullRequest(repo, input): Promise<{ number: number; url: string }> {
      return (await api()).openPullRequest(repo, input);
    },
    async listChecks(repo: string, ref: string): Promise<CheckRun[]> {
      return (await api()).listChecks(repo, ref);
    },
    async mergePullRequest(repo, prNumber, method): Promise<{ merged: boolean; sha: string }> {
      return (await api()).mergePullRequest(repo, prNumber, method);
    },
  };

  const ops: GitOps = {
    async clone(input: CloneInput): Promise<{ headSha: string }> {
      return (await git()).clone(input);
    },
    async createBranch(dir: string, branch: string): Promise<void> {
      return (await git()).createBranch(dir, branch);
    },
    async hasChanges(dir: string): Promise<boolean> {
      return (await git()).hasChanges(dir);
    },
    async commitAll(
      dir: string,
      message: string,
      identity: CommitIdentity,
    ): Promise<{ sha: string } | null> {
      return (await git()).commitAll(dir, message, identity);
    },
    async push(dir: string, branch: string): Promise<void> {
      return (await git()).push(dir, branch);
    },
    async headSha(dir: string): Promise<string> {
      return (await git()).headSha(dir);
    },
  };

  return { client, git: ops };
}
