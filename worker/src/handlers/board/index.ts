import type { NodeHandler } from "../types";
import type { BoardHandlerDeps } from "./nodes";
import {
  createCreateTaskHandler,
  createRequireApprovalHandler,
  createTaskTriggerHandler,
  createUpdateTaskHandler,
} from "./nodes";

/** Every board node, built against one set of injected dependencies. */
export function createBoardHandlers(deps: BoardHandlerDeps): NodeHandler[] {
  const handlers = [
    createTaskTriggerHandler(deps),
    createUpdateTaskHandler(deps),
    createCreateTaskHandler(deps),
    createRequireApprovalHandler(deps),
  ];

  return handlers as unknown as NodeHandler[];
}

export * from "./nodes";
