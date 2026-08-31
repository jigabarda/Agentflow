import {
  summarizeChecks,
  toPullRequestParams,
  type CheckRun,
  type GitHubIssue,
  type RunContext,
} from "@agentflow/core";
import type { NodeHandler, NodeInfo } from "../types";
import { NodeFailure } from "../types";
import { repoDirFor, requireNumber, requireText, type GitHubHandlerDeps } from "./deps";

/**
 * The GitHub nodes.
 *
 * Each one is thin on purpose: the decisions worth testing live in the pure
 * mappers in core, and everything external arrives through `deps`, so these
 * handlers are exercised end-to-end with no token and no network.
 */

// ─────────────────────────────── read-issue ─────────────────────────────────

export interface ReadIssueConfig {
  repo: string;
  issueNumber: string | number;
}

export function createReadIssueHandler(
  deps: GitHubHandlerDeps,
): NodeHandler<ReadIssueConfig, { issue: GitHubIssue }> {
  return {
    type: "read-issue",
    async run(context, config, node) {
      const repo = requireText(config.repo, "repo", node.id);
      const number = requireNumber(config.issueNumber, "issueNumber", node.id);

      const issue = await deps.client.getIssue(repo, number);
      await deps.log(context.runId, {
        level: "info",
        nodeId: node.id,
        message: `Read ${repo}#${number}: ${issue.title}`,
      });

      return { issue };
    },
  };
}

// ─────────────────────────────── clone-repo ─────────────────────────────────

export interface CloneRepoConfig {
  repo: string;
  ref?: string;
}

export function createCloneRepoHandler(
  deps: GitHubHandlerDeps,
): NodeHandler<CloneRepoConfig, { path: string; headSha: string }> {
  return {
    type: "clone-repo",
    async run(context, config, node) {
      const repo = requireText(config.repo, "repo", node.id);
      const dir = repoDirFor(context, repo, node.id);
      const ref =
        typeof config.ref === "string" && config.ref.trim() ? config.ref.trim() : undefined;

      await deps.log(context.runId, {
        level: "info",
        nodeId: node.id,
        message: `Cloning ${repo}${ref ? `@${ref}` : ""} into the run workspace.`,
      });

      const { headSha } = await deps.git.clone({ repo, dir, ...(ref ? { ref } : {}) });

      await deps.log(context.runId, {
        level: "info",
        nodeId: node.id,
        message: `Cloned at ${headSha.slice(0, 7)}.`,
      });

      return { path: dir, headSha };
    },
  };
}

// ────────────────────────────── create-branch ───────────────────────────────

export interface CreateBranchConfig {
  repo: string;
  branchName: string;
  fromRef?: string;
}

export function createCreateBranchHandler(
  deps: GitHubHandlerDeps,
): NodeHandler<CreateBranchConfig, { branch: string }> {
  return {
    type: "create-branch",
    async run(context, config, node) {
      const repo = requireText(config.repo, "repo", node.id);
      const branch = requireText(config.branchName, "branchName", node.id);
      const dir = repoDirFor(context, repo, node.id);

      // Local, not via the API: the branch has to exist in the working tree the
      // agent is about to edit, and an API-created branch would not.
      await deps.git.createBranch(dir, branch);

      await deps.log(context.runId, {
        level: "info",
        nodeId: node.id,
        message: `On branch ${branch}.`,
      });

      return { branch };
    },
  };
}

// ───────────────────────────── commit-changes ───────────────────────────────

export interface CommitChangesConfig {
  repo: string;
  branch: string;
  message: string;
}

export function createCommitChangesHandler(
  deps: GitHubHandlerDeps,
): NodeHandler<CommitChangesConfig, { commitSha: string; pushed: boolean }> {
  return {
    type: "commit-changes",
    async run(context, config, node) {
      const repo = requireText(config.repo, "repo", node.id);
      const branch = requireText(config.branch, "branch", node.id);
      const message = requireText(config.message, "message", node.id);
      const dir = repoDirFor(context, repo, node.id);

      const commit = await deps.git.commitAll(dir, message, deps.identity);
      if (!commit) {
        // Better to stop here than to push an empty branch and open a PR with
        // no diff in it.
        throw new NodeFailure(
          `Node "${node.id}": there is nothing to commit — the agent did not change any files.`,
        );
      }

      await deps.log(context.runId, {
        level: "info",
        nodeId: node.id,
        message: `Committed ${commit.sha.slice(0, 7)}; pushing ${branch}.`,
      });

      await deps.git.push(dir, branch);

      return { commitSha: commit.sha, pushed: true };
    },
  };
}

// ──────────────────────────────── open-pr ───────────────────────────────────

export interface OpenPrConfig {
  repo: string;
  head: string;
  base?: string;
  title: string;
  body?: string;
}

export function createOpenPrHandler(
  deps: GitHubHandlerDeps,
): NodeHandler<OpenPrConfig, { prNumber: number; prUrl: string }> {
  return {
    type: "open-pr",
    async run(context, config, node) {
      const repo = requireText(config.repo, "repo", node.id);

      // An unset base means "wherever this repo merges to", not "main".
      const base =
        typeof config.base === "string" && config.base.trim()
          ? config.base.trim()
          : await deps.client.getDefaultBranch(repo);

      const params = toPullRequestParams(repo, {
        head: requireText(config.head, "head", node.id),
        base,
        title: requireText(config.title, "title", node.id),
        body: config.body ?? "",
      });

      const pr = await deps.client.openPullRequest(repo, {
        head: params.head,
        base: params.base,
        title: params.title,
        body: params.body,
      });

      await deps.log(context.runId, {
        level: "info",
        nodeId: node.id,
        message: `Opened PR #${pr.number} — ${pr.url}`,
      });

      return { prNumber: pr.number, prUrl: pr.url };
    },
  };
}

// ──────────────────────────── wait-for-checks ───────────────────────────────

export interface WaitForChecksConfig {
  repo: string;
  ref: string;
  timeoutSec?: number;
  requiredChecks?: string[];
}

export type ChecksConclusion = "success" | "failure" | "timed_out" | "no_checks";

export interface WaitForChecksOutput {
  conclusion: ChecksConclusion;
  checks: CheckRun[];
}

const POLL_INTERVAL_MS = 15_000;

export function createWaitForChecksHandler(
  deps: GitHubHandlerDeps,
): NodeHandler<WaitForChecksConfig, WaitForChecksOutput> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());

  return {
    type: "wait-for-checks",
    async run(context: RunContext, config, node: NodeInfo): Promise<WaitForChecksOutput> {
      const repo = requireText(config.repo, "repo", node.id);
      const ref = requireText(config.ref, "ref", node.id);
      const timeoutMs = (config.timeoutSec ?? 1800) * 1000;
      const required = config.requiredChecks ?? [];
      const deadline = now() + timeoutMs;

      for (;;) {
        const summary = summarizeChecks(await deps.client.listChecks(repo, ref), required);

        if (summary.state === "no_checks") {
          // Saying "success" here would tell the user their tests passed when
          // the repo has no CI at all (docs/INTEGRATIONS.md).
          await deps.log(context.runId, {
            level: "warn",
            nodeId: node.id,
            message: `${repo} reported no checks for ${ref}. Nothing ran — this gate proves nothing.`,
          });
          return { conclusion: "no_checks", checks: [] };
        }

        if (summary.state === "success" || summary.state === "failure") {
          await deps.log(context.runId, {
            level: summary.state === "success" ? "info" : "warn",
            nodeId: node.id,
            message: `Checks ${summary.state}: ${summary.checks.map((c) => c.name).join(", ")}`,
          });
          return { conclusion: summary.state, checks: summary.checks };
        }

        if (now() >= deadline) {
          await deps.log(context.runId, {
            level: "warn",
            nodeId: node.id,
            message: `Gave up waiting for checks on ${ref} after ${config.timeoutSec ?? 1800}s.`,
          });
          return { conclusion: "timed_out", checks: summary.checks };
        }

        const waiting =
          summary.missing.length > 0 ? ` (waiting on ${summary.missing.join(", ")})` : "";
        await deps.log(context.runId, {
          level: "debug",
          nodeId: node.id,
          message: `Checks still running${waiting}.`,
        });

        await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - now())));
      }
    },
  };
}
