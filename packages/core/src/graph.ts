/**
 * Graph validation — pure. A pipeline may not be saved or run while invalid.
 *
 * A pipeline is valid iff:
 *   1. node ids are unique
 *   2. every edge references existing nodes
 *   3. there is exactly one trigger node
 *   4. the graph is acyclic (it is a DAG)
 *   5. every agent node has BOTH a provider and a model
 *
 * Rule 5 is deliberate: there is NO default model. An agent node the user has
 * not configured is invalid, so no AI ever runs (and no cost is incurred)
 * without an explicit choice. See docs/AGENTS.md.
 */
import type { AgentModelChoice, Pipeline, PipelineNode } from "./types";

/** Node types that start a run. Kept here so validation needs no registry import. */
export const TRIGGER_NODE_TYPES: readonly string[] = [
  "task-trigger",
  "manual-trigger",
  "schedule-trigger",
  "github-issue-trigger",
];

export const AGENT_NODE_TYPE = "agent";

export type GraphIssueCode =
  | "duplicate-node-id"
  | "dangling-edge"
  | "no-trigger"
  | "multiple-triggers"
  | "cycle"
  | "loop-not-backwards"
  | "agent-missing-model"
  | "unknown-agent-profile";

export interface GraphIssue {
  code: GraphIssueCode;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface GraphValidation {
  valid: boolean;
  issues: GraphIssue[];
}

/** A saved Agent Profile, as far as validation cares. */
export interface AgentProfileRef extends AgentModelChoice {
  id: string;
}

export function isTriggerNode(node: Pick<PipelineNode, "type">): boolean {
  return TRIGGER_NODE_TYPES.includes(node.type);
}

/**
 * The provider/model an agent node will actually use — from its assigned
 * profile (plus overrides) or configured inline. Returns null when either half
 * is missing, which makes the node invalid.
 */
export function resolveAgentModel(
  node: Pick<PipelineNode, "config">,
  profiles: ReadonlyMap<string, AgentModelChoice> = new Map(),
): AgentModelChoice | null {
  const config = node.config as {
    agentProfileId?: unknown;
    overrides?: { provider?: unknown; model?: unknown };
    provider?: unknown;
    model?: unknown;
  };

  const profile =
    typeof config.agentProfileId === "string" ? profiles.get(config.agentProfileId) : undefined;

  const provider = pickString(config.overrides?.provider, config.provider, profile?.provider);
  const model = pickString(config.overrides?.model, config.model, profile?.model);

  if (!provider || !model) return null;
  return { provider, model };
}

function pickString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
  }
  return undefined;
}

export function validateGraph(
  pipeline: Pick<Pipeline, "nodes" | "edges">,
  profiles: ReadonlyMap<string, AgentModelChoice> = new Map(),
): GraphValidation {
  const issues: GraphIssue[] = [];
  const { nodes, edges } = pipeline;

  // 1. unique node ids
  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.id)) {
      issues.push({
        code: "duplicate-node-id",
        message: `Duplicate node id "${node.id}".`,
        nodeId: node.id,
      });
    }
    seen.add(node.id);
  }

  // 2. edges reference existing nodes
  for (const edge of edges) {
    if (!seen.has(edge.source)) {
      issues.push({
        code: "dangling-edge",
        message: `Edge "${edge.id}" starts at unknown node "${edge.source}".`,
        edgeId: edge.id,
      });
    }
    if (!seen.has(edge.target)) {
      issues.push({
        code: "dangling-edge",
        message: `Edge "${edge.id}" ends at unknown node "${edge.target}".`,
        edgeId: edge.id,
      });
    }
  }

  // 3. exactly one trigger
  const triggers = nodes.filter(isTriggerNode);
  if (triggers.length === 0) {
    issues.push({ code: "no-trigger", message: "A pipeline needs exactly one trigger node." });
  } else if (triggers.length > 1) {
    for (const trigger of triggers.slice(1)) {
      issues.push({
        code: "multiple-triggers",
        message: `A pipeline may have only one trigger; "${trigger.id}" is extra.`,
        nodeId: trigger.id,
      });
    }
  }

  // 4. acyclic once the deliberate loops are set aside.
  //
  // A `loop` edge is how a reviewer sends work back to the implementer, and it
  // is bounded at run time. Every OTHER cycle is still an error: an accidental
  // one has no limit and would spin forever.
  const forwardEdges = edges.filter((edge) => !edge.loop);
  for (const nodeId of findCycleNodes(nodes, forwardEdges)) {
    issues.push({
      code: "cycle",
      message: `Node "${nodeId}" is part of a cycle; pipelines must be acyclic. Mark the edge that goes back as a loop if that is what you meant.`,
      nodeId,
    });
  }

  // A loop edge must actually go backwards, or it is just a mislabelled edge
  // and nothing would ever bound it.
  const reachable = forwardReachability(nodes, forwardEdges);
  for (const edge of edges) {
    if (!edge.loop) continue;
    if (!reachable.get(edge.target)?.has(edge.source)) {
      issues.push({
        code: "loop-not-backwards",
        message: `Edge "${edge.id}" is marked as a loop, but "${edge.target}" does not lead to "${edge.source}". A loop has to go back to an earlier node.`,
        edgeId: edge.id,
      });
    }
  }

  // 5. every agent node has a provider AND a model — no defaults, ever
  for (const node of nodes) {
    if (node.type !== AGENT_NODE_TYPE) continue;

    const profileId = (node.config as { agentProfileId?: unknown }).agentProfileId;
    if (typeof profileId === "string" && !profiles.has(profileId)) {
      issues.push({
        code: "unknown-agent-profile",
        message: `Agent node "${node.id}" references a missing agent profile.`,
        nodeId: node.id,
      });
      continue;
    }

    if (!resolveAgentModel(node, profiles)) {
      issues.push({
        code: "agent-missing-model",
        message: `Agent node "${node.id}" has no model set. Pick a provider and model before running.`,
        nodeId: node.id,
      });
    }
  }

  return { valid: issues.length === 0, issues };
}

/** Every node that sits on a cycle, found by iterative DFS (no recursion limits). */
function findCycleNodes(
  nodes: readonly PipelineNode[],
  edges: readonly { source: string; target: string }[],
): string[] {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node.id, []);
  for (const edge of edges) adjacency.get(edge.source)?.push(edge.target);

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(nodes.map((n) => [n.id, WHITE]));
  const onCycle = new Set<string>();

  for (const node of nodes) {
    if (color.get(node.id) !== WHITE) continue;

    const stack: { id: string; nextChild: number }[] = [{ id: node.id, nextChild: 0 }];
    color.set(node.id, GREY);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const children = adjacency.get(frame.id) ?? [];

      if (frame.nextChild >= children.length) {
        color.set(frame.id, BLACK);
        stack.pop();
        continue;
      }

      const child = children[frame.nextChild++]!;
      const childColor = color.get(child);
      if (childColor === GREY) {
        // Everything from `child` up the stack is on the cycle.
        const start = stack.findIndex((f) => f.id === child);
        if (start >= 0) for (const f of stack.slice(start)) onCycle.add(f.id);
      } else if (childColor === WHITE) {
        color.set(child, GREY);
        stack.push({ id: child, nextChild: 0 });
      }
    }
  }

  return [...onCycle];
}

/**
 * Execution order for a valid pipeline: parents always before children.
 *
 * Kahn's algorithm with a deterministic tie-break — two runs of the same
 * pipeline must execute in the same order, or debugging becomes guesswork.
 * Throws on a cycle; callers should have validated the graph first.
 */
export function topologicalOrder(pipeline: Pick<Pipeline, "nodes" | "edges">): PipelineNode[] {
  const { nodes, edges } = pipeline;
  const byId = new Map(nodes.map((node) => [node.id, node]));

  const indegree = new Map<string, number>(nodes.map((node) => [node.id, 0]));
  const children = new Map<string, string[]>(nodes.map((node) => [node.id, []]));

  for (const edge of edges) {
    // Ignore edges to or from nodes that are not in the graph; validateGraph
    // reports those, and ordering should not also explode on them.
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    children.get(edge.source)!.push(edge.target);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }

  // Ready nodes are taken in the order they appear in `nodes`, so the result is
  // stable for a given pipeline rather than dependent on Map iteration quirks.
  const position = new Map(nodes.map((node, index) => [node.id, index]));
  const ready = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);

  const order: PipelineNode[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => position.get(a)! - position.get(b)!);
    const id = ready.shift()!;
    order.push(byId.get(id)!);

    for (const child of children.get(id) ?? []) {
      const remaining = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, remaining);
      if (remaining === 0) ready.push(child);
    }
  }

  if (order.length !== nodes.length) {
    const stuck = nodes.filter((node) => !order.includes(node)).map((node) => node.id);
    throw new Error(`Pipeline has a cycle; cannot order nodes: ${stuck.join(", ")}`);
  }

  return order;
}

/**
 * For each node, everything reachable from it. Used to check that a loop edge
 * genuinely points back at an ancestor.
 */
function forwardReachability(
  nodes: readonly PipelineNode[],
  edges: readonly { source: string; target: string }[],
): Map<string, Set<string>> {
  const outgoing = new Map<string, string[]>();
  for (const node of nodes) outgoing.set(node.id, []);
  for (const edge of edges) outgoing.get(edge.source)?.push(edge.target);

  const result = new Map<string, Set<string>>();

  for (const node of nodes) {
    const seen = new Set<string>();
    const queue = [...(outgoing.get(node.id) ?? [])];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      queue.push(...(outgoing.get(current) ?? []));
    }

    result.set(node.id, seen);
  }

  return result;
}
