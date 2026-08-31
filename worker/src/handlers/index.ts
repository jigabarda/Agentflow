import { createAgentHandler, type AgentHandlerDeps } from "./agent";
import { createBoardHandlers, type BoardHandlerDeps } from "./board/index";
import { createConditionHandler, type ConditionDeps } from "./condition";
import { createDeployNetlifyHandler, createDeployVercelHandler, type DeployDeps } from "./deploy";
import { createHttpRequestHandler, type HttpRequestDeps } from "./httpRequest";
import { echo } from "./echo";
import { createGitHubHandlers, type GitHubHandlerDeps } from "./github/index";
import { manualTrigger } from "./manualTrigger";
import { scheduleTrigger } from "./scheduleTrigger";
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
  /** Routing between branches. Omit and a pipeline cannot use `condition`. */
  condition?: ConditionDeps;
  /** The generic HTTP escape hatch. */
  http?: HttpRequestDeps;
  /** Deploy targets. Same deps for both providers. */
  deploy?: DeployDeps;
}

export function createHandlerRegistry(deps: HandlerDeps = {}): Map<string, NodeHandler> {
  const handlers: NodeHandler[] = [
    manualTrigger as NodeHandler,
    scheduleTrigger as NodeHandler,
    echo as NodeHandler,
  ];

  if (deps.agent) {
    handlers.push(createAgentHandler(deps.agent) as NodeHandler);
  }

  if (deps.github) {
    handlers.push(...createGitHubHandlers(deps.github));
  }

  if (deps.board) {
    handlers.push(...createBoardHandlers(deps.board));
  }

  if (deps.condition) {
    handlers.push(createConditionHandler(deps.condition) as NodeHandler);
  }

  if (deps.http) {
    handlers.push(createHttpRequestHandler(deps.http) as unknown as NodeHandler);
  }

  if (deps.deploy) {
    handlers.push(
      createDeployVercelHandler(deps.deploy) as unknown as NodeHandler,
      createDeployNetlifyHandler(deps.deploy) as unknown as NodeHandler,
    );
  }

  return new Map(handlers.map((handler) => [handler.type, handler]));
}

export type { NodeHandler, NodeInfo } from "./types";
export { NodeFailure, RunPaused } from "./types";
export type { AgentHandlerDeps } from "./agent";
export type { GitHubHandlerDeps } from "./github/index";
export type { BoardHandlerDeps } from "./board/index";
export type { ConditionDeps } from "./condition";
export type { HttpRequestDeps } from "./httpRequest";
export type { DeployDeps } from "./deploy";
