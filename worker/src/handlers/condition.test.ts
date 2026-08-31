import { describe, expect, it } from "vitest";
import type { RunContext } from "@agentflow/core";
import { createConditionHandler, evaluateCondition } from "./condition";
import { NodeFailure, type NodeInfo } from "./types";

/**
 * `condition` — the node that chooses a path.
 *
 * The values it routes on come from agents, so the matching has to survive a
 * reviewer that answers in a sentence rather than a keyword.
 */

const node: NodeInfo = { id: "verdict", type: "condition", label: "Verdict" };

function context(): RunContext {
  return {
    pipeline: { vars: {} },
    trigger: {},
    nodes: {},
    runId: "run_1",
    pipelineId: "pipe_1",
    workspaceDir: "/ws",
  };
}

function handler(logs: { level: string; message: string }[] = []) {
  return createConditionHandler({
    log: async (_runId, entry) => {
      logs.push({ level: entry.level, message: entry.message });
    },
  });
}

describe("evaluateCondition", () => {
  it("matches a listed case", () => {
    expect(evaluateCondition({ expression: "APPROVED", cases: ["CHANGES", "APPROVED"] })).toEqual({
      branch: "APPROVED",
      matched: true,
      value: "APPROVED",
    });
  });

  it("finds the case inside a sentence, which is how agents actually answer", () => {
    const result = evaluateCondition({
      expression: "CHANGES — the test for the redirect is missing.",
      cases: ["CHANGES", "APPROVED"],
    });
    expect(result.branch).toBe("CHANGES");
  });

  it("ignores case and surrounding whitespace", () => {
    expect(evaluateCondition({ expression: "  approved  ", cases: ["APPROVED"] }).branch).toBe(
      "APPROVED",
    );
  });

  it("takes the first case listed when both appear", () => {
    // "CHANGES" is listed first because it is the more specific verdict.
    const result = evaluateCondition({
      expression: "CHANGES requested; not APPROVED yet",
      cases: ["CHANGES", "APPROVED"],
    });
    expect(result.branch).toBe("CHANGES");
  });

  it("falls back to the default when nothing matches", () => {
    const result = evaluateCondition({
      expression: "I could not tell",
      cases: ["APPROVED"],
      default: "CHANGES",
    });
    expect(result).toMatchObject({ branch: "CHANGES", matched: false });
  });

  it("uses a built-in default when none is configured", () => {
    expect(evaluateCondition({ expression: "nope", cases: ["yes"] }).branch).toBe("false");
  });

  it("treats the value itself as the handle when no cases are listed", () => {
    // For an agent asked to answer with exactly one word.
    expect(evaluateCondition({ expression: "approved" }).branch).toBe("approved");
  });

  it("falls back rather than routing on an empty value", () => {
    expect(evaluateCondition({ expression: "   ", default: "no" })).toMatchObject({
      branch: "no",
      matched: false,
    });
  });

  it("ignores blank entries in the case list", () => {
    expect(
      evaluateCondition({ expression: "APPROVED", cases: ["", "  ", "APPROVED"] }).branch,
    ).toBe("APPROVED");
  });
});

describe("the handler", () => {
  it("returns the branch for the runner to follow", async () => {
    const output = await handler().run(
      context(),
      { expression: "APPROVED", cases: ["CHANGES", "APPROVED"] },
      node,
    );
    expect(output.branch).toBe("APPROVED");
  });

  it("says which way it went", async () => {
    const logs: { level: string; message: string }[] = [];
    await handler(logs).run(context(), { expression: "APPROVED", cases: ["APPROVED"] }, node);

    expect(logs[0]).toMatchObject({ level: "info", message: 'Routing to "APPROVED".' });
  });

  it("warns when it had to fall through to the default", async () => {
    const logs: { level: string; message: string }[] = [];
    await handler(logs).run(
      context(),
      { expression: "who knows", cases: ["APPROVED"], default: "CHANGES" },
      node,
    );

    expect(logs[0]?.level).toBe("warn");
    expect(logs[0]?.message).toMatch(/Nothing matched/);
  });

  it("fails when there is nothing to route on at all", async () => {
    await expect(handler().run(context(), {}, node)).rejects.toThrow(NodeFailure);
  });
});
