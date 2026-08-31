import { beforeEach, describe, expect, it } from "vitest";
import { MemoryBoardStore } from "../board/MemoryBoardStore";
import { createBoardHandlers, type ApprovalRecord } from "../handlers/board/index";
import { echo } from "../handlers/echo";
import { manualTrigger } from "../handlers/manualTrigger";
import type { NodeHandler } from "../handlers/types";
import type { LoadedPipeline, QueuedRun } from "../store";
import { createBoardReconciler } from "./board";
import { MemoryRunStore } from "./memoryStore";
import { executeRun } from "./runner";

/**
 * The approval gate, through the real runner.
 *
 * The point of a gate is that it costs nothing to wait: no thread is held, no
 * polling happens, and resuming must not redo work that already succeeded —
 * re-running an agent node would spend the user's tokens twice.
 */

let store: MemoryRunStore;
let board: MemoryBoardStore;
let approvals: Map<string, ApprovalRecord>;
/** Counts how many times each node actually executed across both passes. */
let executions: Record<string, number>;

const RUN: QueuedRun = {
  id: "run_1",
  pipelineId: "pipe_1",
  taskId: "task_1",
  trigger: { task: { id: "task_1", title: "Ship it" } },
};

/** trigger → before (counted) → gate → after (counted). */
const PIPELINE: LoadedPipeline = {
  id: "pipe_1",
  name: "Gated pipeline",
  vars: {},
  nodes: [
    { id: "trigger", type: "manual-trigger", label: "Start", config: {}, x: 0, y: 0 },
    { id: "before", type: "counted", label: "Expensive work", config: {}, x: 1, y: 0 },
    {
      id: "gate",
      type: "require-approval",
      label: "Approve?",
      config: { message: "Ship this?" },
      x: 2,
      y: 0,
    },
    { id: "after", type: "counted", label: "Ship", config: {}, x: 3, y: 0 },
  ],
  edges: [
    { id: "e1", source: "trigger", target: "before" },
    { id: "e2", source: "before", target: "gate" },
    { id: "e3", source: "gate", target: "after" },
  ],
};

/** Stands in for an agent: records that it ran, so a resume can prove it didn't. */
const counted: NodeHandler<Record<string, unknown>, { ran: string }> = {
  type: "counted",
  async run(_context, _config, node) {
    executions[node.id] = (executions[node.id] ?? 0) + 1;
    return { ran: node.id };
  },
};

function deps() {
  const handlers = new Map<string, NodeHandler>([
    [manualTrigger.type, manualTrigger as NodeHandler],
    [echo.type, echo as NodeHandler],
    [counted.type, counted as NodeHandler],
  ]);

  for (const handler of createBoardHandlers({
    board,
    getApproval: async (runId, nodeId) => approvals.get(`${runId}:${nodeId}`) ?? null,
    openApproval: async (runId, nodeId) => {
      if (!approvals.has(`${runId}:${nodeId}`)) {
        approvals.set(`${runId}:${nodeId}`, { state: "pending", comment: null });
      }
    },
    log: async () => {},
  })) {
    handlers.set(handler.type, handler);
  }

  return { store, handlers, reconciler: createBoardReconciler(board) };
}

beforeEach(() => {
  store = new MemoryRunStore();
  store.addPipeline(PIPELINE);
  board = new MemoryBoardStore();
  approvals = new Map();
  executions = {};

  board.addColumn({ id: "col_doing", name: "In progress", kind: "working" });
  board.addColumn({ id: "col_wait", name: "Waiting on you", kind: "waiting" });
  board.addTask({ id: "task_1", columnId: "col_doing", title: "Ship it" });
});

describe("a run that reaches a gate", () => {
  it("parks instead of succeeding or failing", async () => {
    const outcome = await executeRun(deps(), RUN);

    expect(outcome.status).toBe("awaiting_approval");
    expect(outcome.awaitingNodeId).toBe("gate");
    expect(store.finalStatus()).toBe("awaiting_approval");
  });

  it("ran everything up to the gate, and nothing after it", async () => {
    await executeRun(deps(), RUN);

    expect(executions).toEqual({ before: 1 });
  });

  it("leaves the gate's step pending, not failed", async () => {
    await executeRun(deps(), RUN);

    const gateStep = store.steps.find((step) => step.nodeId === "gate");
    expect(gateStep?.status).toBe("pending");
    expect(gateStep?.error).toBeUndefined();
  });

  it("moves the card to the waiting column with the question on its timeline", async () => {
    await executeRun(deps(), RUN);

    expect(board.tasks.get("task_1")?.columnId).toBe("col_wait");
    expect(board.eventsFor("task_1").some((event) => event.message === "Ship this?")).toBe(true);
  });

  it("records no terminal outcome on the card — the run has not ended", async () => {
    await executeRun(deps(), RUN);

    const kinds = board.eventsFor("task_1").map((event) => event.kind);
    expect(kinds).not.toContain("run_succeeded");
    expect(kinds).not.toContain("run_failed");
  });
});

describe("resuming after approval", () => {
  it("finishes the run without redoing the work before the gate", async () => {
    await executeRun(deps(), RUN);
    approvals.set("run_1:gate", { state: "approved", comment: "Go ahead" });

    const outcome = await executeRun(deps(), RUN);

    expect(outcome.status).toBe("succeeded");
    // `before` ran once, on the first pass. Re-running it would have spent
    // an agent's tokens a second time.
    expect(executions).toEqual({ before: 1, after: 1 });
  });

  it("reuses the gate's step rather than creating a second one", async () => {
    await executeRun(deps(), RUN);
    approvals.set("run_1:gate", { state: "approved", comment: null });
    await executeRun(deps(), RUN);

    expect(store.steps.filter((step) => step.nodeId === "gate")).toHaveLength(1);
  });

  it("keeps the earlier nodes' outputs available to later ones", async () => {
    await executeRun(deps(), RUN);
    approvals.set("run_1:gate", { state: "approved", comment: null });

    const outcome = await executeRun(deps(), RUN);

    expect(outcome.outputs.before).toEqual({ ran: "before" });
    expect(outcome.outputs.after).toEqual({ ran: "after" });
  });

  it("says it is resuming, so the log explains the gap", async () => {
    await executeRun(deps(), RUN);
    approvals.set("run_1:gate", { state: "approved", comment: null });
    await executeRun(deps(), RUN);

    expect(store.logs.some((log) => /Resuming .* 2 of 4 step/.test(log.message))).toBe(true);
  });

  it("does not announce the run starting a second time on the card", async () => {
    await executeRun(deps(), RUN);
    approvals.set("run_1:gate", { state: "approved", comment: null });
    await executeRun(deps(), RUN);

    const started = board.eventsFor("task_1").filter((event) => event.kind === "run_started");
    expect(started).toHaveLength(1);
  });
});

describe("resuming after rejection", () => {
  it("fails the run with the user's comment as the reason", async () => {
    await executeRun(deps(), RUN);
    approvals.set("run_1:gate", { state: "rejected", comment: "Not this way" });

    const outcome = await executeRun(deps(), RUN);

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("Not this way");
  });

  it("never runs the nodes after the gate", async () => {
    await executeRun(deps(), RUN);
    approvals.set("run_1:gate", { state: "rejected", comment: "No" });
    await executeRun(deps(), RUN);

    expect(executions.after).toBeUndefined();
  });

  it("puts the rejection on the card", async () => {
    await executeRun(deps(), RUN);
    approvals.set("run_1:gate", { state: "rejected", comment: "No" });
    await executeRun(deps(), RUN);

    expect(board.eventsFor("task_1").some((event) => event.kind === "rejected")).toBe(true);
    expect(board.eventsFor("task_1").some((event) => event.kind === "run_failed")).toBe(true);
  });
});

describe("the workspace across a gate", () => {
  it("is kept while parked, and removed only when the run ends", async () => {
    const removed: string[] = [];
    const withCleanup = () => ({
      ...deps(),
      cleanupWorkspace: (runId: string) => removed.push(runId),
    });

    await executeRun(withCleanup(), RUN);
    // Still parked: deleting the workspace now would lose the agent's edits.
    expect(removed).toEqual([]);

    approvals.set("run_1:gate", { state: "approved", comment: null });
    await executeRun(withCleanup(), RUN);

    expect(removed).toEqual(["run_1"]);
  });
});
