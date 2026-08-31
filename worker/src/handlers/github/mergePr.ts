import { summarizeChecks } from "@agentflow/core";
import type { NodeHandler } from "../types";
import { NodeFailure } from "../types";
import { requireNumber, requireText, type GitHubHandlerDeps } from "./deps";

/**
 * `merge-pr` — the most outward thing AgentFlow does, and the only node that
 * refuses to act on its own judgement.
 *
 * The gate is not advisory. Before merging, this reads the check runs on the
 * PR's head commit and merges ONLY when they have actually passed. Every other
 * state — a failure, something still running, or a repo with no CI at all —
 * stops the run and says which.
 *
 * "No checks" is refused deliberately. A repo with no workflow produces zero
 * check runs, and treating that as permission to merge would mean the gate is
 * strictest on repos that test and absent on repos that do not
 * (docs/SECURITY.md, docs/INTEGRATIONS.md). Set `allowNoChecks` to merge such a
 * repo anyway — explicitly, and on purpose.
 */

export interface MergePrConfig {
  repo: string;
  prNumber: string | number;
  method?: "merge" | "squash" | "rebase";
  /** Only these checks gate the merge. Blank = every check must pass. */
  requiredChecks?: string[];
  /** Merge a repo that reports no checks at all. Off by default. */
  allowNoChecks?: boolean;
}

export interface MergePrOutput {
  merged: boolean;
  mergeSha: string;
}

export function createMergePrHandler(
  deps: GitHubHandlerDeps,
): NodeHandler<MergePrConfig, MergePrOutput> {
  return {
    type: "merge-pr",
    async run(context, config, node) {
      const repo = requireText(config.repo, "repo", node.id);
      const prNumber = requireNumber(config.prNumber, "prNumber", node.id);
      const method = config.method ?? "squash";

      // The checks live on the PR's head commit, not on its branch name.
      const head = await deps.client.getRef(repo, `refs/pull/${prNumber}/head`);
      const summary = summarizeChecks(
        await deps.client.listChecks(repo, head.sha),
        config.requiredChecks ?? [],
      );

      if (summary.state === "no_checks") {
        if (!config.allowNoChecks) {
          throw new NodeFailure(
            `Node "${node.id}": ${repo} reported no checks for PR #${prNumber}, so nothing has been verified. Refusing to merge. Turn on "allow no checks" if this repo genuinely has no CI.`,
          );
        }

        await deps.log(context.runId, {
          level: "warn",
          nodeId: node.id,
          message: `Merging PR #${prNumber} with no checks at all — nothing was verified.`,
        });
      }

      if (summary.state === "failure") {
        const failed = summary.checks
          .filter((check) => check.status === "completed" && check.conclusion !== "success")
          .map((check) => check.name);

        throw new NodeFailure(
          `Node "${node.id}": ${failed.join(", ") || "a check"} did not pass on PR #${prNumber}. Refusing to merge.`,
        );
      }

      if (summary.state === "pending") {
        const waiting = [
          ...summary.checks.filter((check) => check.status !== "completed").map((c) => c.name),
          ...summary.missing,
        ];

        throw new NodeFailure(
          `Node "${node.id}": PR #${prNumber} is still waiting on ${waiting.join(", ") || "its checks"}. Put a wait-for-checks node before this one.`,
        );
      }

      const result = await deps.client.mergePullRequest(repo, prNumber, method);

      if (!result.merged) {
        throw new NodeFailure(
          `Node "${node.id}": GitHub declined to merge PR #${prNumber}. It may have conflicts, or a branch rule may forbid it.`,
        );
      }

      await deps.log(context.runId, {
        level: "info",
        nodeId: node.id,
        message: `Merged PR #${prNumber} (${method}) as ${result.sha.slice(0, 7)}.`,
      });

      return { merged: true, mergeSha: result.sha };
    },
  };
}
