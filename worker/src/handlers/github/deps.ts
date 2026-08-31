import path from "node:path";
import { parseRepo, type RunContext } from "@agentflow/core";
import { isInsideWorkspace } from "../../workspace/index";
import type { GitHubClient } from "../../github/GitHubClient";
import type { CommitIdentity, GitOps } from "../../github/git";
import { NodeFailure } from "../types";

/** What every GitHub node needs. All injected, so tests use mocks. */
export interface GitHubHandlerDeps {
  client: GitHubClient;
  git: GitOps;
  /** Who the agent's commits are attributed to. */
  identity: CommitIdentity;
  log: (
    runId: string,
    entry: { level: "debug" | "info" | "warn" | "error"; message: string; nodeId: string },
  ) => Promise<void>;
  /** Injected for `wait-for-checks`, so its tests need no real time. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Where a repo lives inside the run workspace.
 *
 * One clone per repo, in a directory named after it, so every later node can
 * find it from its own `repo` config with no wiring between nodes.
 */
export function repoDirFor(context: RunContext, repo: string, nodeId: string): string {
  const { repo: name } = parseRepo(repo);
  const dir = path.resolve(context.workspaceDir, name);

  // parseRepo permits dots, so ".." reaches here. Nothing may escape the
  // workspace, whatever the user typed (docs/SECURITY.md).
  if (!isInsideWorkspace(context.workspaceDir, dir)) {
    throw new NodeFailure(
      `Node "${nodeId}": "${repo}" does not resolve to a path in the workspace.`,
    );
  }

  return dir;
}

/**
 * Read a number from config that may have arrived as an interpolated string —
 * `{{ trigger.task.issueNumber }}` renders to text.
 */
export function requireNumber(value: unknown, field: string, nodeId: string): number {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new NodeFailure(
      `Node "${nodeId}": ${field} must be a positive whole number, but it is "${String(value)}".`,
    );
  }
  return parsed;
}

/** Trim a required string config value, failing with the node named. */
export function requireText(value: unknown, field: string, nodeId: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new NodeFailure(`Node "${nodeId}": ${field} is required.`);
  return text;
}
