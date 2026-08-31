import type { NodeHandler } from "../types";
import type { GitHubHandlerDeps } from "./deps";
import { createMergePrHandler } from "./mergePr";
import {
  createCloneRepoHandler,
  createCommitChangesHandler,
  createCreateBranchHandler,
  createOpenPrHandler,
  createReadIssueHandler,
  createWaitForChecksHandler,
} from "./nodes";

/**
 * Every GitHub node, built against one set of injected dependencies.
 *
 * The registry is heterogeneous by design — each handler declares the config
 * shape its own node type validates — so each is widened to the registry's
 * erased type on the way in. The runner passes config that the node's Zod
 * schema has already validated.
 */
export function createGitHubHandlers(deps: GitHubHandlerDeps): NodeHandler[] {
  const handlers = [
    createReadIssueHandler(deps),
    createCloneRepoHandler(deps),
    createCreateBranchHandler(deps),
    createCommitChangesHandler(deps),
    createOpenPrHandler(deps),
    createWaitForChecksHandler(deps),
    createMergePrHandler(deps),
  ];

  return handlers as unknown as NodeHandler[];
}

export type { GitHubHandlerDeps } from "./deps";
export * from "./nodes";
export * from "./mergePr";
