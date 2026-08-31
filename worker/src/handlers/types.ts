import type { RunContext } from "@agentflow/core";

/**
 * A node handler is the whole extension point.
 *
 * A node type = an id + a handler. The worker's registry and the editor's node
 * registry are keyed by the SAME id (docs/NODES.md), so adding a node type
 * means registering it in both — and editing nothing else.
 */

/** Who is running: handlers that report problems need to name the node. */
export interface NodeInfo {
  id: string;
  type: string;
  label: string;
}

export interface NodeHandler<Config = Record<string, unknown>, Output = unknown> {
  /** Node-type id, kebab-case. Matches `web/src/nodes/registry.ts`. */
  type: string;
  /**
   * Config arrives already interpolated against the run context, so a handler
   * never sees a raw `{{ template }}`.
   */
  run(context: RunContext, config: Config, node: NodeInfo): Promise<Output>;
}

/**
 * A failure a handler raises deliberately, with a message worth showing the
 * user. Anything else that throws is a bug and is reported as one.
 */
export class NodeFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeFailure";
  }
}

/**
 * Not a failure — a deliberate stop.
 *
 * `require-approval` throws this to park the run until a human decides. The
 * runner records `awaiting_approval` and returns; the step stays pending, its
 * node has not run, and everything already computed is on disk. Approving puts
 * the run back in the queue and it resumes from exactly here.
 */
export class RunPaused extends Error {
  constructor(
    readonly nodeId: string,
    message: string,
  ) {
    super(message);
    this.name = "RunPaused";
  }
}
