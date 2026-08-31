import { describe, expect, it } from "vitest";
import { checkColumnEntry, nextColumn, pipelineForColumnEntry, taskMatchesTrigger } from "./board";

const rules = {
  autoAdvance: {
    onRunSucceeded: "col_review",
    onRunFailed: "col_todo",
    onPrMerged: "col_done",
  },
};

describe("nextColumn", () => {
  it("routes each terminal outcome to its configured column", () => {
    expect(nextColumn("run_succeeded", rules)).toBe("col_review");
    expect(nextColumn("run_failed", rules)).toBe("col_todo");
    expect(nextColumn("pr_merged", rules)).toBe("col_done");
  });

  it("leaves the card put when the column has no rules at all", () => {
    expect(nextColumn("run_succeeded", {})).toBeNull();
    expect(nextColumn("run_succeeded", { autoAdvance: null })).toBeNull();
  });

  it("leaves the card put when the column has no rule for THIS outcome", () => {
    const partial = { autoAdvance: { onRunFailed: "col_todo" } };
    expect(nextColumn("run_succeeded", partial)).toBeNull();
    expect(nextColumn("pr_merged", partial)).toBeNull();
  });

  it("never throws on an unknown outcome", () => {
    expect(nextColumn("something_new", rules)).toBeNull();
    expect(nextColumn("", rules)).toBeNull();
  });

  it("has no rule that can move a card past an approval gate", () => {
    // Non-terminal states are not outcomes, so they can never auto-advance.
    // A parked run must wait for a human — see docs/SECURITY.md.
    expect(nextColumn("awaiting_approval", rules)).toBeNull();
    expect(nextColumn("running", rules)).toBeNull();
    expect(nextColumn("queued", rules)).toBeNull();
  });
});

describe("checkColumnEntry", () => {
  it("allows an unblocked card into a working column", () => {
    const verdict = checkColumnEntry({ column: { kind: "working" }, unresolvedBlockers: [] });
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toBeUndefined();
  });

  it("blocks a card with unfinished blockers from entering a working column", () => {
    const verdict = checkColumnEntry({
      column: { kind: "working" },
      unresolvedBlockers: ["task_1", "task_2"],
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("Blocked by 2 unfinished tasks.");
  });

  it("says 'task' not 'tasks' for a single blocker", () => {
    const verdict = checkColumnEntry({
      column: { kind: "working" },
      unresolvedBlockers: ["task_1"],
    });
    expect(verdict.reason).toBe("Blocked by 1 unfinished task.");
  });

  it("lets a blocked card sit anywhere that is not a working column", () => {
    for (const kind of ["backlog", "ready", "waiting", "done"] as const) {
      const verdict = checkColumnEntry({ column: { kind }, unresolvedBlockers: ["task_1"] });
      expect(verdict.allowed).toBe(true);
    }
  });

  it("treats a WIP limit as a warning, not a wall", () => {
    const verdict = checkColumnEntry({
      column: { kind: "working", wipLimit: 2, name: "In progress" },
      currentCount: 2,
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.warning).toBe("In progress is over its WIP limit (3/2).");
  });

  it("stays quiet while a column is within its WIP limit", () => {
    const verdict = checkColumnEntry({
      column: { kind: "working", wipLimit: 3 },
      currentCount: 1,
    });
    expect(verdict.warning).toBeUndefined();
  });
});

describe("pipelineForColumnEntry", () => {
  it("reports the pipeline bound to the column", () => {
    expect(pipelineForColumnEntry({ pipelineId: "pipe_1" })).toBe("pipe_1");
  });

  it("reports null for a manual column", () => {
    expect(pipelineForColumnEntry({})).toBeNull();
    expect(pipelineForColumnEntry({ pipelineId: null })).toBeNull();
  });
});

describe("taskMatchesTrigger", () => {
  it("accepts every card when no labels are required", () => {
    expect(taskMatchesTrigger({ labels: [] })).toBe(true);
    expect(taskMatchesTrigger({ labels: ["bug"] }, [])).toBe(true);
    expect(taskMatchesTrigger({ labels: ["bug"] }, null)).toBe(true);
  });

  it("requires every named label, not just one of them", () => {
    expect(taskMatchesTrigger({ labels: ["bug", "ui"] }, ["bug", "ui"])).toBe(true);
    expect(taskMatchesTrigger({ labels: ["bug"] }, ["bug", "ui"])).toBe(false);
  });

  it("rejects a card that carries none of them", () => {
    expect(taskMatchesTrigger({ labels: ["chore"] }, ["bug"])).toBe(false);
  });

  it("ignores blank entries rather than blocking every card", () => {
    expect(taskMatchesTrigger({ labels: ["bug"] }, ["", "  "])).toBe(true);
  });
});
