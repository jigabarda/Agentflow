import { describe, expect, it } from "vitest";
import { resolveAgentModel, topologicalOrder, validateGraph } from "./graph";
import type { AgentModelChoice, PipelineNode } from "./types";

function node(id: string, type: string, config: Record<string, unknown> = {}): PipelineNode {
  return { id, type, label: id, config, x: 0, y: 0 };
}

const configuredAgent = node("impl", "agent", { provider: "claude", model: "claude-opus-4-8" });

function codes(result: ReturnType<typeof validateGraph>): string[] {
  return result.issues.map((i) => i.code);
}

describe("validateGraph", () => {
  it("accepts a valid linear pipeline", () => {
    const result = validateGraph({
      nodes: [node("t", "task-trigger"), configuredAgent, node("pr", "open-pr")],
      edges: [
        { id: "e1", source: "t", target: "impl" },
        { id: "e2", source: "impl", target: "pr" },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("accepts a valid branching pipeline", () => {
    const result = validateGraph({
      nodes: [
        node("t", "manual-trigger"),
        node("c", "condition"),
        node("a", "echo"),
        node("b", "echo"),
      ],
      edges: [
        { id: "e1", source: "t", target: "c" },
        { id: "e2", source: "c", target: "a", sourceHandle: "true" },
        { id: "e3", source: "c", target: "b", sourceHandle: "false" },
      ],
    });
    expect(result.valid).toBe(true);
  });

  it("rejects duplicate node ids", () => {
    const result = validateGraph({
      nodes: [node("t", "task-trigger"), node("dup", "echo"), node("dup", "echo")],
      edges: [],
    });
    expect(codes(result)).toContain("duplicate-node-id");
  });

  it("rejects an edge pointing at a node that does not exist", () => {
    const result = validateGraph({
      nodes: [node("t", "task-trigger")],
      edges: [{ id: "e1", source: "t", target: "ghost" }],
    });
    expect(codes(result)).toContain("dangling-edge");
    expect(result.issues.find((i) => i.code === "dangling-edge")?.edgeId).toBe("e1");
  });

  it("rejects an edge starting from a node that does not exist", () => {
    const result = validateGraph({
      nodes: [node("t", "task-trigger")],
      edges: [{ id: "e1", source: "ghost", target: "t" }],
    });
    expect(codes(result)).toContain("dangling-edge");
  });

  it("rejects a pipeline with no trigger", () => {
    const result = validateGraph({ nodes: [node("a", "echo")], edges: [] });
    expect(codes(result)).toContain("no-trigger");
  });

  it("rejects a pipeline with two triggers", () => {
    const result = validateGraph({
      nodes: [node("t1", "task-trigger"), node("t2", "manual-trigger")],
      edges: [],
    });
    expect(codes(result)).toContain("multiple-triggers");
  });

  it("rejects a cycle", () => {
    const result = validateGraph({
      nodes: [node("t", "task-trigger"), node("a", "echo"), node("b", "echo")],
      edges: [
        { id: "e1", source: "t", target: "a" },
        { id: "e2", source: "a", target: "b" },
        { id: "e3", source: "b", target: "a" },
      ],
    });
    expect(codes(result)).toContain("cycle");
    const onCycle = result.issues.filter((i) => i.code === "cycle").map((i) => i.nodeId);
    expect(onCycle).toEqual(expect.arrayContaining(["a", "b"]));
    expect(onCycle).not.toContain("t");
  });

  it("rejects a self-loop", () => {
    const result = validateGraph({
      nodes: [node("t", "task-trigger"), node("a", "echo")],
      edges: [
        { id: "e1", source: "t", target: "a" },
        { id: "e2", source: "a", target: "a" },
      ],
    });
    expect(codes(result)).toContain("cycle");
  });

  it("accepts a diamond — shared descendants are not a cycle", () => {
    const result = validateGraph({
      nodes: [
        node("t", "task-trigger"),
        node("a", "echo"),
        node("b", "echo"),
        node("join", "echo"),
      ],
      edges: [
        { id: "e1", source: "t", target: "a" },
        { id: "e2", source: "t", target: "b" },
        { id: "e3", source: "a", target: "join" },
        { id: "e4", source: "b", target: "join" },
      ],
    });
    expect(result.valid).toBe(true);
  });
});

describe("agent nodes must name a model — there is no default", () => {
  it("rejects an agent node with no provider or model", () => {
    const result = validateGraph({
      nodes: [node("t", "task-trigger"), node("impl", "agent")],
      edges: [{ id: "e1", source: "t", target: "impl" }],
    });
    expect(codes(result)).toContain("agent-missing-model");
    expect(result.valid).toBe(false);
  });

  it("rejects an agent node with a provider but no model", () => {
    const result = validateGraph({
      nodes: [node("t", "task-trigger"), node("impl", "agent", { provider: "claude" })],
      edges: [],
    });
    expect(codes(result)).toContain("agent-missing-model");
  });

  it("rejects an empty-string model rather than filling one in", () => {
    const result = validateGraph({
      nodes: [
        node("t", "task-trigger"),
        node("impl", "agent", { provider: "claude", model: "  " }),
      ],
      edges: [],
    });
    expect(codes(result)).toContain("agent-missing-model");
  });

  it("accepts an agent node that references a saved profile", () => {
    const profiles = new Map<string, AgentModelChoice>([
      ["prof_1", { provider: "ollama", model: "qwen2.5-coder" }],
    ]);
    const result = validateGraph(
      {
        nodes: [node("t", "task-trigger"), node("impl", "agent", { agentProfileId: "prof_1" })],
        edges: [],
      },
      profiles,
    );
    expect(result.valid).toBe(true);
  });

  it("rejects an agent node pointing at a profile that no longer exists", () => {
    const result = validateGraph({
      nodes: [node("t", "task-trigger"), node("impl", "agent", { agentProfileId: "gone" })],
      edges: [],
    });
    expect(codes(result)).toContain("unknown-agent-profile");
  });

  it("ignores config on non-agent nodes", () => {
    const result = validateGraph({
      nodes: [node("t", "task-trigger"), node("http", "http-request", { url: "https://x.test" })],
      edges: [],
    });
    expect(result.valid).toBe(true);
  });
});

describe("resolveAgentModel", () => {
  const profiles = new Map<string, AgentModelChoice>([
    ["prof_1", { provider: "claude", model: "claude-haiku-4-5" }],
  ]);

  it("reads an inline config", () => {
    expect(resolveAgentModel({ config: { provider: "claude", model: "claude-opus-4-8" } })).toEqual(
      {
        provider: "claude",
        model: "claude-opus-4-8",
      },
    );
  });

  it("reads a referenced profile", () => {
    expect(resolveAgentModel({ config: { agentProfileId: "prof_1" } }, profiles)).toEqual({
      provider: "claude",
      model: "claude-haiku-4-5",
    });
  });

  it("lets a per-node override win over the profile", () => {
    expect(
      resolveAgentModel(
        { config: { agentProfileId: "prof_1", overrides: { model: "claude-opus-4-8" } } },
        profiles,
      ),
    ).toEqual({ provider: "claude", model: "claude-opus-4-8" });
  });

  it("returns null when either half is missing", () => {
    expect(resolveAgentModel({ config: {} })).toBeNull();
    expect(resolveAgentModel({ config: { provider: "claude" } })).toBeNull();
    expect(resolveAgentModel({ config: { model: "claude-opus-4-8" } })).toBeNull();
  });
});

describe("topologicalOrder", () => {
  it("puts parents before children", () => {
    const order = topologicalOrder({
      nodes: [node("c", "echo"), node("a", "task-trigger"), node("b", "echo")],
      edges: [
        { id: "e1", source: "a", target: "b" },
        { id: "e2", source: "b", target: "c" },
      ],
    });
    expect(order.map((n) => n.id)).toEqual(["a", "b", "c"]);
  });

  it("is deterministic: the same pipeline always orders the same way", () => {
    const graph = {
      nodes: [node("t", "task-trigger"), node("x", "echo"), node("y", "echo")],
      edges: [
        { id: "e1", source: "t", target: "x" },
        { id: "e2", source: "t", target: "y" },
      ],
    };
    const first = topologicalOrder(graph).map((n) => n.id);
    expect(topologicalOrder(graph).map((n) => n.id)).toEqual(first);
    // Ties break on declaration order, so `x` precedes `y`.
    expect(first).toEqual(["t", "x", "y"]);
  });

  it("orders a diamond with the join last", () => {
    const order = topologicalOrder({
      nodes: [node("t", "task-trigger"), node("l", "echo"), node("r", "echo"), node("j", "echo")],
      edges: [
        { id: "e1", source: "t", target: "l" },
        { id: "e2", source: "t", target: "r" },
        { id: "e3", source: "l", target: "j" },
        { id: "e4", source: "r", target: "j" },
      ],
    });
    expect(order[0]!.id).toBe("t");
    expect(order.at(-1)!.id).toBe("j");
    expect(order).toHaveLength(4);
  });

  it("includes disconnected nodes", () => {
    const order = topologicalOrder({
      nodes: [node("t", "task-trigger"), node("lonely", "echo")],
      edges: [],
    });
    expect(order.map((n) => n.id)).toEqual(["t", "lonely"]);
  });

  it("ignores edges pointing at nodes that are not in the graph", () => {
    const order = topologicalOrder({
      nodes: [node("a", "task-trigger")],
      edges: [{ id: "e1", source: "a", target: "ghost" }],
    });
    expect(order.map((n) => n.id)).toEqual(["a"]);
  });

  it("throws on a cycle rather than looping", () => {
    expect(() =>
      topologicalOrder({
        nodes: [node("a", "echo"), node("b", "echo")],
        edges: [
          { id: "e1", source: "a", target: "b" },
          { id: "e2", source: "b", target: "a" },
        ],
      }),
    ).toThrow(/cycle/);
  });

  it("handles an empty pipeline", () => {
    expect(topologicalOrder({ nodes: [], edges: [] })).toEqual([]);
  });
});

describe("loop edges", () => {
  const loopingTeam = {
    id: "p1",
    name: "Team",
    nodes: [
      { id: "trigger", type: "task-trigger", label: "Start", config: {}, x: 0, y: 0 },
      { id: "implement", type: "echo", label: "Implement", config: {}, x: 1, y: 0 },
      { id: "review", type: "echo", label: "Review", config: {}, x: 2, y: 0 },
    ],
    edges: [
      { id: "e1", source: "trigger", target: "implement" },
      { id: "e2", source: "implement", target: "review" },
      { id: "e3", source: "review", target: "implement", loop: true },
    ],
  };

  it("accepts a cycle that is explicitly marked as a loop", () => {
    expect(validateGraph(loopingTeam).valid).toBe(true);
  });

  it("still rejects the same cycle when it is not marked", () => {
    const unmarked = {
      ...loopingTeam,
      edges: loopingTeam.edges.map((edge) => (edge.id === "e3" ? { ...edge, loop: false } : edge)),
    };

    const result = validateGraph(unmarked);
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === "cycle")).toBe(true);
  });

  it("tells the user a loop is what they may have meant", () => {
    const unmarked = {
      ...loopingTeam,
      edges: loopingTeam.edges.map((edge) => (edge.id === "e3" ? { ...edge, loop: false } : edge)),
    };

    expect(validateGraph(unmarked).issues[0]?.message).toMatch(/Mark the edge that goes back/);
  });

  it("rejects a loop edge that does not actually go backwards", () => {
    const sideways = {
      ...loopingTeam,
      nodes: [
        ...loopingTeam.nodes,
        { id: "other", type: "echo", label: "O", config: {}, x: 3, y: 0 },
      ],
      edges: [
        { id: "e1", source: "trigger", target: "implement" },
        { id: "e2", source: "implement", target: "review" },
        // "other" leads nowhere, so this is not a way back to anything.
        { id: "e3", source: "review", target: "other", loop: true },
      ],
    };

    const result = validateGraph(sideways);
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === "loop-not-backwards")).toBe(true);
  });
});
