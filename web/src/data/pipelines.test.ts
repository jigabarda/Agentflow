// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import type { PipelineNode } from "@agentflow/core";
import {
  InvalidPipelineError,
  createPipeline,
  deletePipeline,
  getPipeline,
  getVariables,
  listPipelines,
  savePipelineGraph,
  setVariable,
} from "./pipelines";
import { resetDatabase } from "./testing";

beforeEach(resetDatabase);

function node(id: string, type: string, config: Record<string, unknown> = {}): PipelineNode {
  return { id, type, label: id, config, x: 10, y: 20 };
}

const validGraph = {
  name: "Implement a task",
  nodes: [
    node("trigger", "task-trigger"),
    node("impl", "agent", { provider: "claude", model: "claude-opus-4-8" }),
    node("pr", "open-pr"),
  ],
  edges: [
    { id: "e1", source: "trigger", target: "impl" },
    { id: "e2", source: "impl", target: "pr", sourceHandle: "done" },
  ],
};

describe("createPipeline / getPipeline", () => {
  it("round-trips a graph with its nodes and edges", async () => {
    const created = await createPipeline(validGraph);
    const loaded = await getPipeline(created.id);

    expect(loaded?.name).toBe("Implement a task");
    expect(loaded?.nodes.map((n) => n.id).sort()).toEqual(["impl", "pr", "trigger"]);
    expect(loaded?.edges).toHaveLength(2);
  });

  it("preserves node config, position, and edge handles", async () => {
    const created = await createPipeline(validGraph);
    const loaded = await getPipeline(created.id);

    const agent = loaded?.nodes.find((n) => n.id === "impl");
    expect(agent?.config).toEqual({ provider: "claude", model: "claude-opus-4-8" });
    expect(agent?.x).toBe(10);
    expect(agent?.y).toBe(20);

    expect(loaded?.edges.find((e) => e.id === "e2")?.sourceHandle).toBe("done");
    expect(loaded?.edges.find((e) => e.id === "e1")?.sourceHandle).toBeUndefined();
  });

  it("creates an empty pipeline", async () => {
    const created = await createPipeline({ name: "Blank" });
    expect(created.nodes).toEqual([]);
    expect(created.edges).toEqual([]);
  });

  it("returns null for a pipeline that does not exist", async () => {
    expect(await getPipeline("nope")).toBeNull();
  });

  it("lists pipelines", async () => {
    await createPipeline({ name: "A" });
    await createPipeline({ name: "B" });
    expect((await listPipelines()).map((p) => p.name)).toEqual(["A", "B"]);
  });
});

describe("savePipelineGraph", () => {
  it("replaces the graph wholesale", async () => {
    const created = await createPipeline(validGraph);

    const saved = await savePipelineGraph(created.id, {
      name: "Renamed",
      nodes: [node("trigger", "manual-trigger"), node("echo", "echo", { value: "hi" })],
      edges: [{ id: "e1", source: "trigger", target: "echo" }],
    });

    expect(saved.name).toBe("Renamed");
    expect(saved.nodes.map((n) => n.id).sort()).toEqual(["echo", "trigger"]);
    expect(saved.edges).toHaveLength(1);

    // The old nodes are gone, not merged.
    expect(saved.nodes.find((n) => n.id === "impl")).toBeUndefined();
  });

  it("REFUSES to persist a graph with a cycle", async () => {
    const created = await createPipeline(validGraph);

    await expect(
      savePipelineGraph(created.id, {
        name: "Cyclic",
        nodes: [node("trigger", "task-trigger"), node("a", "echo"), node("b", "echo")],
        edges: [
          { id: "e1", source: "trigger", target: "a" },
          { id: "e2", source: "a", target: "b" },
          { id: "e3", source: "b", target: "a" },
        ],
      }),
    ).rejects.toThrow(InvalidPipelineError);

    // The stored graph is untouched.
    const loaded = await getPipeline(created.id);
    expect(loaded?.name).toBe("Implement a task");
    expect(loaded?.nodes).toHaveLength(3);
  });

  it("REFUSES to persist a graph with a dangling edge", async () => {
    const created = await createPipeline(validGraph);
    await expect(
      savePipelineGraph(created.id, {
        name: "Dangling",
        nodes: [node("trigger", "task-trigger")],
        edges: [{ id: "e1", source: "trigger", target: "ghost" }],
      }),
    ).rejects.toThrow(InvalidPipelineError);
  });

  it("REFUSES to persist an agent node with no model — no default is ever filled in", async () => {
    const created = await createPipeline(validGraph);

    let caught: unknown;
    try {
      await savePipelineGraph(created.id, {
        name: "Unconfigured",
        nodes: [node("trigger", "task-trigger"), node("impl", "agent")],
        edges: [{ id: "e1", source: "trigger", target: "impl" }],
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InvalidPipelineError);
    const codes = (caught as InvalidPipelineError).validation.issues.map((issue) => issue.code);
    expect(codes).toContain("agent-missing-model");
  });
});

describe("variables", () => {
  it("sets, overwrites, and reads pipeline variables", async () => {
    const pipeline = await createPipeline({ name: "P" });

    await setVariable(pipeline.id, "repoUrl", "acme/app");
    await setVariable(pipeline.id, "baseBranch", "main");
    expect(await getVariables(pipeline.id)).toEqual({ repoUrl: "acme/app", baseBranch: "main" });

    await setVariable(pipeline.id, "baseBranch", "develop");
    expect((await getVariables(pipeline.id)).baseBranch).toBe("develop");
  });

  it("scopes variables to their own pipeline", async () => {
    const a = await createPipeline({ name: "A" });
    const b = await createPipeline({ name: "B" });
    await setVariable(a.id, "shared", "from-a");
    expect(await getVariables(b.id)).toEqual({});
  });
});

describe("deletePipeline", () => {
  it("removes the pipeline and its graph", async () => {
    const created = await createPipeline(validGraph);
    await deletePipeline(created.id);
    expect(await getPipeline(created.id)).toBeNull();
  });
});
