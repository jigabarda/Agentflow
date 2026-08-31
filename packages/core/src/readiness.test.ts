import { describe, expect, it } from "vitest";
import { checkRunReadiness, providersUsedBy } from "./readiness";
import type { PipelineNode } from "./types";

function node(id: string, type: string, config: Record<string, unknown> = {}): PipelineNode {
  return { id, type, label: id, config, x: 0, y: 0 };
}

const pipeline = {
  nodes: [
    node("t", "task-trigger"),
    node("triage", "agent", { provider: "ollama", model: "qwen2.5-coder" }),
    node("impl", "agent", { provider: "claude", model: "claude-opus-4-8" }),
  ],
  edges: [
    { id: "e1", source: "t", target: "triage" },
    { id: "e2", source: "triage", target: "impl" },
  ],
};

describe("providersUsedBy", () => {
  it("lists each distinct provider the agent nodes name", () => {
    expect(providersUsedBy(pipeline).sort()).toEqual(["claude", "ollama"]);
  });

  it("does not count non-agent nodes", () => {
    expect(providersUsedBy({ nodes: [node("t", "task-trigger")] })).toEqual([]);
  });
});

describe("checkRunReadiness", () => {
  it("is ready when every provider has what it needs", () => {
    const readiness = checkRunReadiness(pipeline, [
      { provider: "claude", hasKey: true },
      { provider: "ollama", hasKey: false, baseUrl: "http://localhost:11434" },
    ]);
    expect(readiness.ready).toBe(true);
    expect(readiness.problems).toEqual([]);
  });

  it("flags a hosted provider with no API key", () => {
    const readiness = checkRunReadiness(pipeline, [
      { provider: "ollama", hasKey: false, baseUrl: "http://localhost:11434" },
    ]);
    expect(readiness.ready).toBe(false);
    expect(readiness.problems).toContainEqual({
      code: "missing-provider-key",
      message: 'Add an API key for "claude" on this pipeline before running.',
      provider: "claude",
    });
  });

  it("flags a local provider with no base URL", () => {
    const readiness = checkRunReadiness(pipeline, [{ provider: "claude", hasKey: true }]);
    expect(readiness.ready).toBe(false);
    expect(readiness.problems.map((p) => p.code)).toContain("missing-provider-base-url");
  });

  it("does not demand an API key for a keyless local provider", () => {
    const local = {
      nodes: [
        node("t", "task-trigger"),
        node("a", "agent", { provider: "ollama", model: "llama3" }),
      ],
      edges: [],
    };
    const readiness = checkRunReadiness(local, [
      { provider: "ollama", hasKey: false, baseUrl: "http://localhost:11434" },
    ]);
    expect(readiness.ready).toBe(true);
  });

  it("refuses to run an invalid graph even when every key is present", () => {
    const broken = { nodes: [node("a", "agent", { provider: "claude", model: "m" })], edges: [] };
    const readiness = checkRunReadiness(broken, [{ provider: "claude", hasKey: true }]);
    expect(readiness.ready).toBe(false);
    expect(readiness.problems.map((p) => p.code)).toContain("invalid-graph");
  });

  it("reports a pipeline with no credentials at all as un-runnable", () => {
    const readiness = checkRunReadiness(pipeline, []);
    expect(readiness.ready).toBe(false);
    expect(readiness.problems).toHaveLength(2);
  });
});
