import { describe, expect, it } from "vitest";
import type { PipelineEdge, PipelineNode } from "@agentflow/core";
import { echo } from "../handlers/echo";
import { manualTrigger } from "../handlers/manualTrigger";
import { NodeFailure, type NodeHandler } from "../handlers/types";
import type { LoadedPipeline, QueuedRun } from "../store";
import { MemoryRunStore } from "./memoryStore";
import { executeRun, runNextQueued } from "./runner";

function node(id: string, type: string, config: Record<string, unknown> = {}): PipelineNode {
  return { id, type, label: id, config, x: 0, y: 0 };
}

function edge(source: string, target: string): PipelineEdge {
  return { id: `${source}->${target}`, source, target };
}

function pipeline(
  nodes: PipelineNode[],
  edges: PipelineEdge[] = [],
  vars: Record<string, string> = {},
): LoadedPipeline {
  return { id: "pipe_1", name: "Test pipeline", nodes, edges, vars };
}

const run: QueuedRun = { id: "run_1", pipelineId: "pipe_1", taskId: null, trigger: {} };

const baseHandlers = new Map<string, NodeHandler>([
  ["manual-trigger", manualTrigger as NodeHandler],
  ["echo", echo as NodeHandler],
]);

/** A fixed clock: the engine must never depend on wall time. */
const now = () => new Date("2026-08-19T09:00:00.000Z");

function setup(loaded: LoadedPipeline, handlers = baseHandlers) {
  const store = new MemoryRunStore();
  store.addPipeline(loaded);
  return { store, deps: { store, handlers, now } };
}

describe("executing a pipeline", () => {
  it("runs a linear graph in topological order", async () => {
    const { store, deps } = setup(
      pipeline(
        [node("c", "echo"), node("a", "manual-trigger"), node("b", "echo")],
        [edge("a", "b"), edge("b", "c")],
      ),
    );

    const outcome = await executeRun(deps, run);

    expect(outcome.status).toBe("succeeded");
    // Declaration order is a→b→c only once the edges are honoured; `c` is
    // declared first but must run last.
    expect(store.executionOrder()).toEqual(["a", "b", "c"]);
  });

  it("threads one node's output into the next node's config", async () => {
    const { store, deps } = setup(
      pipeline(
        [
          node("a", "echo", { value: "hello" }),
          node("b", "echo", { value: "{{ nodes.a.output.value }} world" }),
        ],
        [edge("a", "b")],
      ),
    );

    const outcome = await executeRun(deps, run);

    expect(outcome.status).toBe("succeeded");
    expect(outcome.outputs.b).toEqual({ value: "hello world" });
    expect(store.steps.at(-1)?.output).toEqual({ value: "hello world" });
  });

  it("resolves pipeline variables and the trigger payload", async () => {
    const { deps } = setup(
      pipeline(
        [node("a", "echo", { value: "{{ pipeline.vars.repo }}#{{ trigger.task.title }}" })],
        [],
        { repo: "acme/app" },
      ),
    );

    const outcome = await executeRun(deps, {
      ...run,
      trigger: { task: { title: "Fix login" } },
    });

    expect(outcome.outputs.a).toEqual({ value: "acme/app#Fix login" });
  });

  it("marks the run succeeded and records a step per node", async () => {
    const { store, deps } = setup(pipeline([node("a", "manual-trigger"), node("b", "echo")]));

    await executeRun(deps, run);

    expect(store.finalStatus()).toBe("succeeded");
    expect(store.steps).toHaveLength(2);
    expect(store.steps.every((step) => step.status === "succeeded")).toBe(true);
  });

  it("writes logs a human can follow", async () => {
    const { store, deps } = setup(pipeline([node("a", "echo", { value: "x" })]));

    await executeRun(deps, run);

    const messages = store.logs.map((entry) => entry.message);
    expect(messages[0]).toContain("Test pipeline");
    expect(messages.at(-1)).toBe("Run succeeded.");
  });

  it("runs both branches of a diamond exactly once", async () => {
    const { store, deps } = setup(
      pipeline(
        [node("t", "manual-trigger"), node("l", "echo"), node("r", "echo"), node("j", "echo")],
        [edge("t", "l"), edge("t", "r"), edge("l", "j"), edge("r", "j")],
      ),
    );

    await executeRun(deps, run);

    const order = store.executionOrder();
    expect(order).toHaveLength(4);
    expect(order[0]).toBe("t");
    expect(order.at(-1)).toBe("j");
  });
});

describe("failure paths", () => {
  const exploding: NodeHandler = {
    type: "explode",
    async run() {
      throw new NodeFailure("the remote said no");
    },
  };

  const handlersWithExplode = new Map(baseHandlers).set("explode", exploding);

  it("fails the run when a handler throws, and records the reason", async () => {
    const { store, deps } = setup(
      pipeline([node("a", "echo", { value: "x" }), node("boom", "explode")], [edge("a", "boom")]),
      handlersWithExplode,
    );

    const outcome = await executeRun(deps, run);

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("the remote said no");
    expect(store.finalStatus()).toBe("failed");
    expect(store.runStatuses.at(-1)?.error).toContain("boom");
  });

  it("stops at the failure — later nodes never run", async () => {
    const { store, deps } = setup(
      pipeline(
        [node("a", "echo"), node("boom", "explode"), node("after", "echo")],
        [edge("a", "boom"), edge("boom", "after")],
      ),
      handlersWithExplode,
    );

    await executeRun(deps, run);

    expect(store.executionOrder()).toEqual(["a", "boom"]);
    expect(store.steps.find((step) => step.nodeId === "boom")?.status).toBe("failed");
  });

  it("keeps the outputs produced before the failure", async () => {
    const { deps } = setup(
      pipeline(
        [node("a", "echo", { value: "kept" }), node("boom", "explode")],
        [edge("a", "boom")],
      ),
      handlersWithExplode,
    );

    const outcome = await executeRun(deps, run);
    expect(outcome.outputs.a).toEqual({ value: "kept" });
  });

  it("fails cleanly when a node type has no handler", async () => {
    const { store, deps } = setup(pipeline([node("a", "no-such-node")]));

    const outcome = await executeRun(deps, run);

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain('No handler for node type "no-such-node"');
    expect(store.steps[0]?.status).toBe("failed");
  });

  it("fails cleanly when a template refers to something that does not exist", async () => {
    const { store, deps } = setup(pipeline([node("a", "echo", { value: "{{ nodes.ghost.x }}" })]));

    const outcome = await executeRun(deps, run);

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("ghost");
    // The error reaches the log, not just the return value.
    expect(store.logs.some((entry) => entry.level === "error")).toBe(true);
  });

  it("fails when the pipeline has vanished", async () => {
    const store = new MemoryRunStore();
    const outcome = await executeRun({ store, handlers: baseHandlers, now }, run);

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("no longer exists");
  });

  it("fails on a cyclic graph instead of looping forever", async () => {
    const { deps } = setup(
      pipeline([node("a", "echo"), node("b", "echo")], [edge("a", "b"), edge("b", "a")]),
    );

    const outcome = await executeRun(deps, run);
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("cycle");
  });
});

describe("the queue", () => {
  it("claims and runs the next queued run", async () => {
    const { store, deps } = setup(pipeline([node("a", "echo", { value: "x" })]));
    store.enqueue(run);

    const outcome = await runNextQueued(deps);

    expect(outcome?.status).toBe("succeeded");
  });

  it("returns null when there is nothing to do", async () => {
    const { deps } = setup(pipeline([node("a", "echo")]));
    expect(await runNextQueued(deps)).toBeNull();
  });
});

describe("the run context", () => {
  it("gives each node the run id and its workspace directory", async () => {
    const seen: { runId?: string; workspaceDir?: string } = {};
    const spy: NodeHandler = {
      type: "spy",
      async run(context) {
        seen.runId = context.runId;
        seen.workspaceDir = context.workspaceDir;
        return {};
      },
    };

    const { deps } = setup(pipeline([node("a", "spy")]), new Map([["spy", spy]]));
    await executeRun({ ...deps, workspaceDir: (id) => `/tmp/${id}` }, run);

    expect(seen.runId).toBe("run_1");
    expect(seen.workspaceDir).toBe("/tmp/run_1");
  });

  it("hands the handler config that is already interpolated", async () => {
    let received: unknown;
    const spy: NodeHandler = {
      type: "spy",
      async run(_context, config) {
        received = config;
        return {};
      },
    };

    const { deps } = setup(
      pipeline([node("a", "spy", { repo: "{{ pipeline.vars.repo }}" })], [], { repo: "acme/app" }),
      new Map([["spy", spy]]),
    );
    await executeRun(deps, run);

    expect(received).toEqual({ repo: "acme/app" });
  });
});
