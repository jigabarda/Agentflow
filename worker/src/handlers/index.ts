import { createAgentHandler, type AgentHandlerDeps } from "./agent";
import { createBoardHandlers, type BoardHandlerDeps } from "./board/index";
import { echo } from "./echo";
import { createGitHubHandlers, type GitHubHandlerDeps } from "./github/index";
import { manualTrigger } from "./manualTrigger";
import type { NodeHandler } from "./types";

/**
 * The worker's handler registry.
 *
 * Keyed by node-type id, exactly as the editor's registry is. Adding a node
 * type = adding it here and in `web/src/nodes/registry.ts`.
 */

export interface HandlerDeps {
  /** Omit to build a registry with no agent node — used by engine tests. */
  agent?: AgentHandlerDeps;
  /** Omit to build a registry with no GitHub nodes — used by engine tests. */
  github?: GitHubHandlerDeps;
  /** Omit to build a registry with no board nodes — used by engine tests. */
  board?: BoardHandlerDeps;
}

export function createHandlerRegistry(deps: HandlerDeps = {}): Map<string, NodeHandler> {
  const handlers: NodeHandler[] = [manualTrigger as NodeHandler, echo as NodeHandler];

  if (deps.agent) {
    handlers.push(createAgentHandler(deps.agent) as NodeHandler);
  }

  if (deps.github) {
    handlers.push(...createGitHubHandlers(deps.github));
  }

  if (deps.board) {
    handlers.push(...createBoardHandlers(deps.board));
  }

  return new Map(handlers.map((handler) => [handler.type, handler]));
}

export type { NodeHandler, NodeInfo } from "./types";
export { NodeFailure, RunPaused } from "./types";
export type { AgentHandlerDeps } from "./agent";
export type { GitHubHandlerDeps } from "./github/index";
export type { BoardHandlerDeps } from "./board/index";
