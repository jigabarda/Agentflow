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
 * By default: the workspace root itself, so **the agent's working directory IS
 * the checkout**. That is not a detail — an agent is told it works in the run
 * workspace, so if the repo sat in a subdirectory beside it, the agent would
 * write its changes next to the repo rather than into it, and the commit would
 * find nothing. (It did. That is why this is the default.)
 *
 * A pipeline that clones more than one repo gives each node an explicit `dir`,
 * and then the agent has to be told which one to work in.
 */
export function repoDirFor(
  context: RunContext,
  repo: string,
  nodeId: string,
  dir?: unknown,
): string {
  const configured = typeof dir === "string" ? dir.trim() : "";
  if (!configured) return context.workspaceDir;

  const resolved = path.resolve(context.workspaceDir, configured);

  // Nothing may escape the workspace, whatever was typed (docs/SECURITY.md).
  if (!isInsideWorkspace(context.workspaceDir, resolved)) {
    throw new NodeFailure(
      `Node "${nodeId}": "${configured}" is not a path inside the run workspace.`,
    );
  }

  return resolved;
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

/**
 * A required `owner/name`, validated.
 *
 * Checked here rather than left to git: a malformed slug becomes a nonsense
 * URL, and "repository not found" is a far worse message than "that is not a
 * repository".
 */
export function requireRepo(value: unknown, nodeId: string): string {
  const repo = requireText(value, "repo", nodeId);
  parseRepo(repo);
  return repo;
}

/** Trim a required string config value, failing with the node named. */
export function requireText(value: unknown, field: string, nodeId: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new NodeFailure(`Node "${nodeId}": ${field} is required.`);
  return text;
}
