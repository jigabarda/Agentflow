import { describe, expect, it } from "vitest";
import { Flow, FlowLoopExceeded, branchOf, DEFAULT_MAX_ITERATIONS } from "./flow";
import type { PipelineEdge, PipelineNode } from "./types";

/**
 * The flow controller: which node runs next, and which never runs at all.
 */

function node(id: string, type = "echo"): PipelineNode {
  return { id, type, label: id, config: {}, x: 0, y: 0 };
}

function edge(
  id: string,
  source: string,
  target: string,
  extra: Partial<PipelineEdge> = {},
): PipelineEdge {
  return { id, source, target, ...extra };
}

/** Run the whole flow, returning the node ids in the order they executed. */
function drain(flow: Flow, choose: (nodeId: string) => string | null = () => null): string[] {
  const order: string[] = [];

  for (let guard = 0; guard < 100; guard++) {
    const next = flow.next();
    if (!next) break;
    order.push(next.id);
    flow.complete(next.id, choose(next.id));
  }

  return order;
}

describe("a straight line", () => {
  const pipeline = {
    nodes: [node("a"), node("b"), node("c")],
    edges: [edge("e1", "a", "b"), edge("e2", "b", "c")],
  };

  it("runs every node in order", () => {
    expect(drain(new Flow(pipeline))).toEqual(["a", "b", "c"]);
  });

  it("starts at the node with nothing upstream", () => {
    expect(new Flow(pipeline).next()?.id).toBe("a");
  });

  it("is finished once the last node is done", () => {
    const flow = new Flow(pipeline);
    drain(flow);
    expect(flow.next()).toBeNull();
  });
});

describe("waiting for every input", () => {
  // a → b, a → c, then b → d and c → d.
  const pipeline = {
    nodes: [node("a"), node("b"), node("c"), node("d")],
    edges: [edge("e1", "a", "b"), edge("e2", "a", "c"), edge("e3", "b", "d"), edge("e4", "c", "d")],
  };

  it("runs a join exactly once, after both branches", () => {
    const order = drain(new Flow(pipeline));
    expect(order).toEqual(["a", "b", "c", "d"]);
    expect(order.filter((id) => id === "d")).toHaveLength(1);
  });

  it("does not offer the join until both inputs are in", () => {
    const flow = new Flow(pipeline);
    flow.complete("a");
    flow.complete("b");
    expect(flow.ready().map((item) => item.id)).toEqual(["c"]);
  });
});

describe("branching", () => {
  // condition → (approved) → ship, (rejected) → tidy, both → finish.
  const pipeline = {
    nodes: [node("start"), node("gate", "condition"), node("ship"), node("tidy"), node("finish")],
    edges: [
      edge("e1", "start", "gate"),
      edge("e2", "gate", "ship", { sourceHandle: "approved" }),
      edge("e3", "gate", "tidy", { sourceHandle: "rejected" }),
      edge("e4", "ship", "finish"),
      edge("e5", "tidy", "finish"),
    ],
  };

  it("follows only the handle the condition chose", () => {
    const order = drain(new Flow(pipeline), (id) => (id === "gate" ? "approved" : null));
    expect(order).toEqual(["start", "gate", "ship", "finish"]);
  });

  it("marks the path not taken as skipped, not pending", () => {
    const flow = new Flow(pipeline);
    drain(flow, (id) => (id === "gate" ? "approved" : null));

    expect(flow.state("tidy")).toBe("skipped");
    expect(flow.skipped()).toEqual(["tidy"]);
  });

  it("still reaches a join that both branches feed", () => {
    const flow = new Flow(pipeline);
    drain(flow, (id) => (id === "gate" ? "rejected" : null));

    expect(flow.state("finish")).toBe("done");
    expect(flow.state("ship")).toBe("skipped");
  });

  it("skips a whole chain behind a pruned branch", () => {
    const long = {
      nodes: [node("gate", "condition"), node("x"), node("y"), node("z")],
      edges: [
        edge("e1", "gate", "x", { sourceHandle: "yes" }),
        edge("e2", "gate", "z", { sourceHandle: "no" }),
        edge("e3", "x", "y"),
      ],
    };

    const flow = new Flow(long);
    drain(flow, (id) => (id === "gate" ? "no" : null));

    expect(flow.skipped().sort()).toEqual(["x", "y"]);
  });

  it("treats an unmatched handle as no path at all", () => {
    const flow = new Flow(pipeline);
    drain(flow, (id) => (id === "gate" ? "something-else" : null));

    expect(flow.state("ship")).toBe("skipped");
    expect(flow.state("tidy")).toBe("skipped");
    expect(flow.state("finish")).toBe("skipped");
  });

  it("fires unlabelled edges regardless of the branch chosen", () => {
    const mixed = {
      nodes: [node("gate", "condition"), node("always"), node("only-yes")],
      edges: [
        edge("e1", "gate", "always"),
        edge("e2", "gate", "only-yes", { sourceHandle: "yes" }),
      ],
    };

    const flow = new Flow(mixed);
    drain(flow, (id) => (id === "gate" ? "no" : null));

    expect(flow.state("always")).toBe("done");
    expect(flow.state("only-yes")).toBe("skipped");
  });
});

describe("the reviewer loop", () => {
  // implement → review → verdict; "changes" loops back to implement.
  const pipeline = {
    nodes: [node("implement"), node("review"), node("verdict", "condition"), node("ship")],
    edges: [
      edge("e1", "implement", "review"),
      edge("e2", "review", "verdict"),
      edge("e3", "verdict", "ship", { sourceHandle: "approved" }),
      edge("e4", "verdict", "implement", { sourceHandle: "changes", loop: true }),
    ],
  };

  it("goes back and genuinely re-runs the work", () => {
    let reviews = 0;
    const flow = new Flow(pipeline);

    const order = drain(flow, (id) => {
      if (id !== "verdict") return null;
      reviews += 1;
      // Ask for changes once, then approve.
      return reviews === 1 ? "changes" : "approved";
    });

    expect(order).toEqual([
      "implement",
      "review",
      "verdict",
      "implement",
      "review",
      "verdict",
      "ship",
    ]);
  });

  it("counts the times it went round", () => {
    let reviews = 0;
    const flow = new Flow(pipeline);
    drain(flow, (id) => {
      if (id !== "verdict") return null;
      reviews += 1;
      return reviews === 1 ? "changes" : "approved";
    });

    expect(flow.iterationsOf("implement")).toBe(1);
  });

  it("takes the straight path when the reviewer approves first time", () => {
    const flow = new Flow(pipeline);
    const order = drain(flow, (id) => (id === "verdict" ? "approved" : null));

    expect(order).toEqual(["implement", "review", "verdict", "ship"]);
    expect(flow.iterationsOf("implement")).toBe(0);
  });

  it("gives up loudly rather than looping forever", () => {
    const flow = new Flow(pipeline);

    expect(() => drain(flow, (id) => (id === "verdict" ? "changes" : null))).toThrow(
      FlowLoopExceeded,
    );
  });

  it("names the node and the limit when it gives up", () => {
    const flow = new Flow(pipeline);
    const error = (() => {
      try {
        drain(flow, (id) => (id === "verdict" ? "changes" : null));
      } catch (thrown) {
        return thrown as FlowLoopExceeded;
      }
    })();

    expect(error?.nodeId).toBe("implement");
    expect(error?.limit).toBe(DEFAULT_MAX_ITERATIONS);
    expect(error?.message).toMatch(/raise the limit on the loop edge/);
  });

  it("honours a limit set on the loop edge", () => {
    const once = {
      nodes: [node("implement"), node("verdict", "condition")],
      edges: [
        edge("e1", "implement", "verdict"),
        edge("e2", "verdict", "implement", {
          sourceHandle: "changes",
          loop: true,
          maxIterations: 1,
        }),
      ],
    };

    const flow = new Flow(once);
    let rounds = 0;

    expect(() =>
      drain(flow, (id) => {
        if (id !== "verdict") return null;
        rounds += 1;
        return "changes";
      }),
    ).toThrow(FlowLoopExceeded);

    // One trip round the loop was allowed; the second was refused.
    expect(rounds).toBe(2);
  });
});

describe("a failed node", () => {
  it("stops everything downstream from running", () => {
    const flow = new Flow({
      nodes: [node("a"), node("b"), node("c")],
      edges: [edge("e1", "a", "b"), edge("e2", "b", "c")],
    });

    flow.complete("a");
    flow.fail("b");

    expect(flow.next()).toBeNull();
    expect(flow.state("c")).toBe("skipped");
  });
});

describe("branchOf", () => {
  it("reads the branch a node chose", () => {
    expect(branchOf({ branch: "approved" })).toBe("approved");
  });

  it("returns null for anything that did not choose one", () => {
    expect(branchOf({ result: "done" })).toBeNull();
    expect(branchOf({ branch: "" })).toBeNull();
    expect(branchOf({ branch: 3 })).toBeNull();
    expect(branchOf(null)).toBeNull();
    expect(branchOf("approved")).toBeNull();
  });
});

describe("edges that point at nothing", () => {
  it("are ignored rather than crashing the walk", () => {
    const flow = new Flow({
      nodes: [node("a")],
      edges: [edge("e1", "a", "gone"), edge("e2", "missing", "a")],
    });

    expect(drain(flow)).toEqual(["a"]);
  });
});

describe("a loop keeps what came before it", () => {
  // The bug this guards: rewinding used to reset the edge feeding INTO the
  // loop, so the implementer waited forever on work that was already done.
  const pipeline = {
    nodes: [node("setup"), node("implement"), node("verdict", "condition"), node("ship")],
    edges: [
      edge("e1", "setup", "implement"),
      edge("e2", "implement", "verdict"),
      edge("e3", "verdict", "ship", { sourceHandle: "approved" }),
      edge("e4", "verdict", "implement", { sourceHandle: "changes", loop: true }),
    ],
  };

  it("re-runs only the looped region, not the work before it", () => {
    let rounds = 0;
    const flow = new Flow(pipeline);

    const order = drain(flow, (id) => {
      if (id !== "verdict") return null;
      rounds += 1;
      return rounds === 1 ? "changes" : "approved";
    });

    expect(order).toEqual(["setup", "implement", "verdict", "implement", "verdict", "ship"]);
    // setup ran once and was never rewound.
    expect(order.filter((id) => id === "setup")).toHaveLength(1);
  });

  it("does not stall after going round", () => {
    let rounds = 0;
    const flow = new Flow(pipeline);
    drain(flow, (id) => {
      if (id !== "verdict") return null;
      rounds += 1;
      return rounds === 1 ? "changes" : "approved";
    });

    expect(flow.stalled()).toEqual([]);
  });
});

describe("stalled", () => {
  it("is empty for a graph that ran to the end", () => {
    const flow = new Flow({
      nodes: [node("a"), node("b")],
      edges: [edge("e1", "a", "b")],
    });
    drain(flow);
    expect(flow.stalled()).toEqual([]);
  });

  it("names a node left waiting on an input that never arrives", () => {
    // "join" needs both, but nothing ever runs "b".
    const flow = new Flow({
      nodes: [node("a"), node("b"), node("join")],
      edges: [edge("e1", "a", "join"), edge("e2", "b", "join")],
    });

    flow.complete("a");
    // Pretend b is unreachable by never completing it, and stop the walk.
    expect(flow.ready().map((item) => item.id)).toEqual(["b"]);
    expect(flow.stalled()).toContain("join");
  });

  it("does not count a skipped branch as stalled", () => {
    const flow = new Flow({
      nodes: [node("gate", "condition"), node("yes"), node("no")],
      edges: [
        edge("e1", "gate", "yes", { sourceHandle: "y" }),
        edge("e2", "gate", "no", { sourceHandle: "n" }),
      ],
    });

    drain(flow, (id) => (id === "gate" ? "y" : null));

    expect(flow.stalled()).toEqual([]);
    expect(flow.skipped()).toEqual(["no"]);
  });
});
