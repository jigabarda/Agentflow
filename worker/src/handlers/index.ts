import { createAgentHandler, type AgentHandlerDeps } from "./agent";
import { echo } from "./echo";
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
}

export function createHandlerRegistry(deps: HandlerDeps = {}): Map<string, NodeHandler> {
  const handlers: NodeHandler[] = [manualTrigger as NodeHandler, echo as NodeHandler];

  if (deps.agent) {
    handlers.push(createAgentHandler(deps.agent) as NodeHandler);
  }

  return new Map(handlers.map((handler) => [handler.type, handler]));
}

export type { NodeHandler, NodeInfo } from "./types";
export { NodeFailure } from "./types";
export type { AgentHandlerDeps } from "./agent";
