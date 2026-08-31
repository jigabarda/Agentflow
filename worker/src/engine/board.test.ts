import { beforeEach, describe, expect, it } from "vitest";
import { MemoryBoardStore } from "../board/MemoryBoardStore";
import { createBoardReconciler, type RunReconciler } from "./board";

/**
 * The reconciler: what the *card* does while a run happens to it.
 *
 * The rule that matters most here is that it never decides anything on its own
 * — a card moves only where the column's own `autoAdvance` rule sends it.
 */

let board: MemoryBoardStore;
let reconciler: RunReconciler;

const run = { id: "run_1", taskId: "task_1" };
const step = { nodeId: "impl", label: "Implement", index: 3, total: 7 };

beforeEach(() => {
  board = new MemoryBoardStore();
  reconciler = createBoardReconciler(board);

  board.addColumn({ id: "col_todo", name: "Todo", kind: "ready" });
  board.addColumn({
    id: "col_doing",
    name: "In progress",
    kind: "working",
    autoAdvance: { onRunSucceeded: "col_review", onRunFailed: "col_todo" },
  });
  board.addColumn({ id: "col_review", name: "Review", kind: "waiting" });
  board.addTask({ id: "task_1", columnId: "col_doing" });
});

describe("progress on the card", () => {
  it("records the run starting, with the step count", async () => {
    await reconciler.onRunStarted(run, "Issue to PR", 7);

    const event = board.eventsFor("task_1").at(-1);
    expect(event?.kind).toBe("run_started");
    expect(event?.message).toBe('Started "Issue to PR" — 7 steps.');
  });

  it("records each step as x of y, attributed to the node", async () => {
    await reconciler.onStepSucceeded(run, step);

    const event = board.eventsFor("task_1").at(-1);
    expect(event?.actor).toBe("agent:impl");
    expect(event?.message).toBe("Implement finished (3/7).");
  });

  it("puts the failing step and its reason on the card, not in a log", async () => {
    await reconciler.onStepFailed(run, step, "the repo has no tests");

    const event = board.eventsFor("task_1").at(-1);
    expect(event?.message).toBe("Implement failed — the repo has no tests");
  });
});

describe("auto-advance", () => {
  it("moves the card where the column's success rule says", async () => {
    await reconciler.onRunSucceeded(run);

    expect(board.tasks.get("task_1")?.columnId).toBe("col_review");
    const moved = board.eventsFor("task_1").at(-1);
    expect(moved?.actor).toBe("system");
    expect(moved?.message).toBe("Moved to Review.");
  });

  it("sends a failure back where the failure rule says, naming the step", async () => {
    await reconciler.onRunFailed(run, "no changes to commit", "commit");

    expect(board.tasks.get("task_1")?.columnId).toBe("col_todo");
    const failure = board.eventsFor("task_1").find((event) => event.kind === "run_failed");
    expect(failure?.message).toBe("Failed at commit — no changes to commit");
  });

  it("leaves the card alone when the column has no rule", async () => {
    board.addColumn({ id: "col_doing", name: "In progress", kind: "working", autoAdvance: null });

    await reconciler.onRunSucceeded(run);

    expect(board.tasks.get("task_1")?.columnId).toBe("col_doing");
    expect(board.eventsFor("task_1").some((event) => event.kind === "moved")).toBe(false);
  });

  it("leaves the card alone when only the other outcome has a rule", async () => {
    board.addColumn({
      id: "col_doing",
      name: "In progress",
      kind: "working",
      autoAdvance: { onPrMerged: "col_review" },
    });

    await reconciler.onRunSucceeded(run);

    expect(board.tasks.get("task_1")?.columnId).toBe("col_doing");
  });

  it("does not move a card to the column it is already in", async () => {
    board.addColumn({
      id: "col_doing",
      name: "In progress",
      kind: "working",
      autoAdvance: { onRunSucceeded: "col_doing" },
    });

    await reconciler.onRunSucceeded(run);

    expect(board.eventsFor("task_1").some((event) => event.kind === "moved")).toBe(false);
  });

  it("does not move a card into a column that no longer exists", async () => {
    board.addColumn({
      id: "col_doing",
      name: "In progress",
      kind: "working",
      autoAdvance: { onRunSucceeded: "col_deleted" },
    });

    await reconciler.onRunSucceeded(run);

    expect(board.tasks.get("task_1")?.columnId).toBe("col_doing");
  });
});

describe("runs with no card", () => {
  const canvasRun = { id: "run_2", taskId: null };

  it("writes nothing at all — a canvas test-run touches no board", async () => {
    await reconciler.onRunStarted(canvasRun, "Echo", 2);
    await reconciler.onStepSucceeded(canvasRun, step);
    await reconciler.onStepFailed(canvasRun, step, "nope");
    await reconciler.onRunSucceeded(canvasRun);
    await reconciler.onRunFailed(canvasRun, "nope");

    expect(board.events).toHaveLength(0);
  });

  it("survives a card that was deleted mid-run", async () => {
    board.tasks.delete("task_1");

    await expect(reconciler.onRunSucceeded(run)).resolves.toBeUndefined();
  });
});
