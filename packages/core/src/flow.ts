import type { Pipeline, PipelineEdge, PipelineNode } from "./types";

/**
 * Flow control — which node runs next, and which never runs at all.
 *
 * Up to Phase 7 the runner walked every node in topological order, which is
 * right for a straight line. A crew needs two more things:
 *
 *   · **branches** — a `condition` chooses one outgoing handle, and the nodes
 *     down the paths it did not choose must be SKIPPED, not run;
 *   · **loops** — a reviewer that asks for changes sends the run back to the
 *     implementer, bounded, and says so in the log when it gives up.
 *
 * All of that is decided here, as a pure state machine over the graph: no I/O,
 * no clock, no handlers. The runner asks what is ready, runs it, and reports
 * what happened. That keeps the interesting rules unit-testable.
 */

export const DEFAULT_MAX_ITERATIONS = 3;

export type FlowNodeState = "pending" | "done" | "skipped";
type EdgeState = "pending" | "fired" | "pruned";

/** A loop that never settled. The run fails with this, never silently. */
export class FlowLoopExceeded extends Error {
  constructor(
    readonly nodeId: string,
    readonly limit: number,
  ) {
    super(
      `"${nodeId}" was sent back for another attempt more than ${limit} time(s). Stopping so it cannot loop forever — raise the limit on the loop edge if it genuinely needs more.`,
    );
    this.name = "FlowLoopExceeded";
  }
}

export class Flow {
  private readonly nodes = new Map<string, PipelineNode>();
  private readonly outgoing = new Map<string, PipelineEdge[]>();
  private readonly incoming = new Map<string, PipelineEdge[]>();

  private readonly nodeState = new Map<string, FlowNodeState>();
  private readonly edgeState = new Map<string, EdgeState>();
  /** How many times each node has been sent back around a loop. */
  private readonly iterations = new Map<string, number>();

  constructor(pipeline: Pick<Pipeline, "nodes" | "edges">) {
    for (const node of pipeline.nodes) {
      this.nodes.set(node.id, node);
      this.nodeState.set(node.id, "pending");
      this.outgoing.set(node.id, []);
      this.incoming.set(node.id, []);
    }

    for (const edge of pipeline.edges) {
      // An edge to nowhere is a validation problem, not a runtime one.
      if (!this.nodes.has(edge.source) || !this.nodes.has(edge.target)) continue;
      this.outgoing.get(edge.source)!.push(edge);
      this.incoming.get(edge.target)!.push(edge);
      this.edgeState.set(edge.id, "pending");
    }
  }

  /** Nodes that can run right now, in stable graph order. */
  ready(): PipelineNode[] {
    const ready: PipelineNode[] = [];

    for (const [id, node] of this.nodes) {
      if (this.nodeState.get(id) !== "pending") continue;

      // A loop edge re-arms a node; it is not a prerequisite for it. Counting
      // it as one would deadlock the very first pass — the implementer would
      // be waiting on a reviewer that has not run yet.
      const incoming = this.dependencies(id);

      // A trigger has nothing upstream, so it is ready from the start.
      if (incoming.length === 0) {
        ready.push(node);
        continue;
      }

      const settled = incoming.every((edge) => this.edgeState.get(edge.id) !== "pending");
      const anyFired = incoming.some((edge) => this.edgeState.get(edge.id) === "fired");
      if (settled && anyFired) ready.push(node);
    }

    return ready;
  }

  /** The single next node to run, or null when the run is finished. */
  next(): PipelineNode | null {
    return this.ready()[0] ?? null;
  }

  state(nodeId: string): FlowNodeState | undefined {
    return this.nodeState.get(nodeId);
  }

  /**
   * Nodes still waiting on something that will never come.
   *
   * A graph that stalls must not be mistaken for one that finished: the runner
   * checks this and fails the run rather than reporting success.
   */
  stalled(): string[] {
    return [...this.nodeState.entries()]
      .filter(([, state]) => state === "pending")
      .map(([id]) => id);
  }

  /** Nodes that will never run because a branch went the other way. */
  skipped(): string[] {
    return [...this.nodeState.entries()]
      .filter(([, state]) => state === "skipped")
      .map(([id]) => id);
  }

  /** How many times a node has been re-entered by a loop edge. */
  iterationsOf(nodeId: string): number {
    return this.iterations.get(nodeId) ?? 0;
  }

  /**
   * Record that a node finished.
   *
   * `handle` is the branch it chose. A node that does not branch passes null,
   * and every outgoing edge fires — including handled ones, so a `condition`
   * is the only thing that can prune a path.
   */
  complete(nodeId: string, handle: string | null = null): void {
    this.nodeState.set(nodeId, "done");

    const loopsToFollow: PipelineEdge[] = [];

    for (const edge of this.outgoing.get(nodeId) ?? []) {
      const matches = handle === null || !edge.sourceHandle || edge.sourceHandle === handle;

      if (!matches) {
        this.pruneEdge(edge);
        continue;
      }

      if (edge.loop) {
        loopsToFollow.push(edge);
        continue;
      }

      this.edgeState.set(edge.id, "fired");
    }

    // Loops are applied last: rewinding resets state that the straight edges
    // above have just written.
    for (const edge of loopsToFollow) this.rewind(edge);
  }

  /** Record that a node failed. Everything downstream is now unreachable. */
  fail(nodeId: string): void {
    this.nodeState.set(nodeId, "done");
    for (const edge of this.outgoing.get(nodeId) ?? []) this.pruneEdge(edge);
  }

  private pruneEdge(edge: PipelineEdge): void {
    if (this.edgeState.get(edge.id) === "pruned") return;
    this.edgeState.set(edge.id, "pruned");

    // If that was the target's last hope, the target never runs — and neither
    // does anything that depended only on it.
    const incoming = this.dependencies(edge.target);
    const allPruned =
      incoming.length > 0 && incoming.every((item) => this.edgeState.get(item.id) === "pruned");

    if (allPruned && this.nodeState.get(edge.target) === "pending") {
      this.nodeState.set(edge.target, "skipped");
      for (const next of this.outgoing.get(edge.target) ?? []) this.pruneEdge(next);
    }
  }

  /**
   * Send the run back to an earlier node.
   *
   * Everything from the target forwards is set back to pending, so the second
   * pass genuinely re-runs it — a reviewer asking for changes must see the
   * implementer's NEW work, not its old output.
   */
  private rewind(edge: PipelineEdge): void {
    const limit = edge.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const count = (this.iterations.get(edge.target) ?? 0) + 1;

    if (count > limit) throw new FlowLoopExceeded(edge.target, limit);
    this.iterations.set(edge.target, count);

    const closure = this.forwardClosure(edge.target);

    for (const id of closure) {
      this.nodeState.set(id, "pending");

      // Only edges INSIDE the rewound region are reset. An edge coming in from
      // before the loop has already fired and will never fire again — resetting
      // it would leave the target waiting forever on work that is long done.
      for (const outgoing of this.outgoing.get(id) ?? []) {
        if (outgoing.id === edge.id) continue;
        if (closure.has(outgoing.target)) this.edgeState.set(outgoing.id, "pending");
      }
    }

    this.edgeState.set(edge.id, "fired");
  }

  /** The incoming edges a node genuinely waits on — loop edges excluded. */
  private dependencies(nodeId: string): PipelineEdge[] {
    return (this.incoming.get(nodeId) ?? []).filter((edge) => !edge.loop);
  }

  /** `from` and everything reachable from it, ignoring loop edges. */
  private forwardClosure(from: string): Set<string> {
    const seen = new Set<string>([from]);
    const queue = [from];

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const edge of this.outgoing.get(current) ?? []) {
        if (edge.loop) continue;
        if (seen.has(edge.target)) continue;
        seen.add(edge.target);
        queue.push(edge.target);
      }
    }

    return seen;
  }
}

/**
 * The branch a finished node chose, if it chose one.
 *
 * By convention a node routes by returning a `branch` string — that is what
 * `condition` emits. Everything else fires all of its outgoing edges.
 */
export function branchOf(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const branch = (output as { branch?: unknown }).branch;
  return typeof branch === "string" && branch.length > 0 ? branch : null;
}
