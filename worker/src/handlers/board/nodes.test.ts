import { beforeEach, describe, expect, it } from "vitest";
import type { RunContext } from "@agentflow/core";
import { MemoryBoardStore } from "../../board/MemoryBoardStore";
import { NodeFailure, RunPaused, type NodeInfo } from "../types";
import type { ApprovalRecord, BoardHandlerDeps } from "./nodes";
import {
  createCreateTaskHandler,
  createRequireApprovalHandler,
  createTaskTriggerHandler,
  createUpdateTaskHandler,
} from "./nodes";

/**
 * The board nodes: an agent writing back to the card that started it.
 */

let board: MemoryBoardStore;
let approvals: Map<string, ApprovalRecord>;
let opened: string[];
let logs: { level: string; message: string }[];

function deps(): BoardHandlerDeps {
  return {
    board,
    getApproval: async (runId, nodeId) => approvals.get(`${runId}:${nodeId}`) ?? null,
    openApproval: async (runId, nodeId) => {
      opened.push(`${runId}:${nodeId}`);
    },
    log: async (_runId, entry) => {
      logs.push({ level: entry.level, message: entry.message });
    },
  };
}

function context(taskId: string | null = "task_1"): RunContext {
  return {
    pipeline: { vars: {} },
    trigger: taskId ? { task: { id: taskId, title: "Fix login" } } : {},
    ...(taskId ? { task: { id: taskId, title: "Fix login" } } : {}),
    nodes: {},
    runId: "run_1",
    pipelineId: "pipe_1",
    workspaceDir: "/ws",
  };
}

const node: NodeInfo = { id: "board", type: "update-task", label: "Update card" };

beforeEach(() => {
  board = new MemoryBoardStore();
  approvals = new Map();
  opened = [];
  logs = [];

  board.addColumn({ id: "col_todo", name: "Todo", kind: "ready" });
  board.addColumn({ id: "col_doing", name: "In progress", kind: "working" });
  board.addColumn({ id: "col_wait", name: "Waiting on you", kind: "waiting" });
  board.addColumn({ id: "col_review", name: "Review", kind: "waiting" });
  board.addTask({ id: "task_1", columnId: "col_doing", title: "Fix login", labels: ["bug"] });
});

describe("task-trigger", () => {
  it("returns the card that started the run", async () => {
    const handler = createTaskTriggerHandler(deps());
    const output = await handler.run(context(), {}, node);

    expect(output.task.id).toBe("task_1");
    expect(output.task.title).toBe("Fix login");
  });

  it("says plainly when the run did not come from a card", async () => {
    const handler = createTaskTriggerHandler(deps());
    await expect(handler.run(context(null), {}, node)).rejects.toThrow(
      /needs a card to act on.*run this pipeline from the board/s,
    );
  });

  it("fails when the card has been deleted since the run was queued", async () => {
    board.tasks.delete("task_1");
    const handler = createTaskTriggerHandler(deps());
    await expect(handler.run(context(), {}, node)).rejects.toThrow(/no longer exists/);
  });
});

describe("update-task", () => {
  it("moves the card and records the move as the agent's doing", async () => {
    const handler = createUpdateTaskHandler(deps());
    const output = await handler.run(context(), { columnId: "col_review" }, node);

    expect(output.task.columnId).toBe("col_review");

    const moved = board.eventsFor("task_1").find((event) => event.kind === "moved");
    expect(moved?.actor).toBe("agent:board");
    expect(moved?.message).toBe("Moved to Review.");
  });

  it("attaches the PR to the card and posts it to the timeline", async () => {
    const handler = createUpdateTaskHandler(deps());
    const output = await handler.run(
      context(),
      { prNumber: "77", prUrl: "https://github.com/o/r/pull/77" },
      node,
    );

    expect(output.task.prNumber).toBe(77);
    expect(output.task.prUrl).toBe("https://github.com/o/r/pull/77");

    const event = board.eventsFor("task_1").find((entry) => entry.kind === "pr_opened");
    expect(event?.message).toContain("https://github.com/o/r/pull/77");
  });

  it("adds labels without dropping the ones already on the card", async () => {
    const handler = createUpdateTaskHandler(deps());
    const output = await handler.run(context(), { addLabels: ["needs-review"] }, node);

    expect(output.task.labels).toEqual(["bug", "needs-review"]);
  });

  it("posts a comment to the timeline", async () => {
    const handler = createUpdateTaskHandler(deps());
    await handler.run(context(), { comment: "  PR is ready  " }, node);

    const comment = board.eventsFor("task_1").find((event) => event.kind === "commented");
    expect(comment?.message).toBe("PR is ready");
  });

  it("writes no move event when the column did not actually change", async () => {
    const handler = createUpdateTaskHandler(deps());
    await handler.run(context(), { columnId: "col_doing" }, node);

    expect(board.eventsFor("task_1").filter((event) => event.kind === "moved")).toHaveLength(0);
  });

  it("refuses a PR number that is not a number", async () => {
    const handler = createUpdateTaskHandler(deps());
    await expect(handler.run(context(), { prNumber: "not a number" }, node)).rejects.toThrow(
      /prNumber must be a whole number/,
    );
  });

  it("can act on a card other than the run's own", async () => {
    board.addTask({ id: "task_2", columnId: "col_todo" });
    const handler = createUpdateTaskHandler(deps());

    await handler.run(context(), { taskId: "task_2", columnId: "col_review" }, node);

    expect(board.tasks.get("task_2")?.columnId).toBe("col_review");
    expect(board.tasks.get("task_1")?.columnId).toBe("col_doing");
  });
});

describe("create-task", () => {
  const planner: NodeInfo = { id: "planner", type: "create-task", label: "Split it" };

  it("turns a list into cards, inheriting the parent's repo", async () => {
    board.addTask({ id: "task_1", columnId: "col_doing", title: "Fix login", repo: "o/r" });

    const handler = createCreateTaskHandler(deps());
    const output = await handler.run(
      context(),
      {
        columnId: "col_todo",
        tasks: [{ title: "Write the test" }, { title: "Fix the redirect", priority: "high" }],
      },
      planner,
    );

    expect(output.createdTaskIds).toHaveLength(2);

    const created = output.createdTaskIds.map((id) => board.tasks.get(id)!);
    expect(created.map((task) => task.title)).toEqual(["Write the test", "Fix the redirect"]);
    expect(created[0]!.columnId).toBe("col_todo");
    expect(created[0]!.repo).toBe("o/r");
    expect(created[1]!.priority).toBe("high");
  });

  it("accepts a JSON string, because that is what an agent often produces", async () => {
    const handler = createCreateTaskHandler(deps());
    const output = await handler.run(
      context(),
      { columnId: "col_todo", tasks: '[{"title":"From JSON"}]' },
      planner,
    );

    expect(board.tasks.get(output.createdTaskIds[0]!)?.title).toBe("From JSON");
  });

  it("records the decomposition on the parent's timeline", async () => {
    const handler = createCreateTaskHandler(deps());
    await handler.run(context(), { columnId: "col_todo", tasks: [{ title: "A" }] }, planner);

    const event = board.eventsFor("task_1").at(-1);
    expect(event?.message).toBe("Split into 1 card.");
  });

  it("treats an empty list as nothing to do, not an error", async () => {
    const handler = createCreateTaskHandler(deps());
    const output = await handler.run(context(), { columnId: "col_todo", tasks: [] }, planner);

    expect(output.createdTaskIds).toEqual([]);
    expect(logs.some((entry) => entry.level === "warn")).toBe(true);
  });

  it("refuses to create blank cards from an untitled entry", async () => {
    const handler = createCreateTaskHandler(deps());
    await expect(
      handler.run(context(), { columnId: "col_todo", tasks: [{ body: "no title" }] }, planner),
    ).rejects.toThrow(/has no title/);
  });

  it("says so when the agent's output is not a list at all", async () => {
    const handler = createCreateTaskHandler(deps());
    await expect(
      handler.run(context(), { columnId: "col_todo", tasks: "I could not do this" }, planner),
    ).rejects.toThrow(/not JSON/);
  });

  it("fails when the destination column does not exist", async () => {
    const handler = createCreateTaskHandler(deps());
    await expect(
      handler.run(context(), { columnId: "col_gone", tasks: [{ title: "A" }] }, planner),
    ).rejects.toThrow(/does not exist/);
  });
});

describe("require-approval", () => {
  const gate: NodeInfo = { id: "gate", type: "require-approval", label: "Approve?" };

  it("parks the run rather than blocking or failing", async () => {
    const handler = createRequireApprovalHandler(deps());

    const error = await handler
      .run(context(), { message: "Merge this?" }, gate)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RunPaused);
    expect((error as RunPaused).nodeId).toBe("gate");
    // It is explicitly not a failure.
    expect(error).not.toBeInstanceOf(NodeFailure);
  });

  it("opens the gate so the UI has something to offer a decision on", async () => {
    const handler = createRequireApprovalHandler(deps());
    await handler.run(context(), {}, gate).catch(() => undefined);

    expect(opened).toEqual(["run_1:gate"]);
  });

  it("moves the card to the board's waiting column and says why", async () => {
    const handler = createRequireApprovalHandler(deps());
    await handler.run(context(), { message: "Merge this?" }, gate).catch(() => undefined);

    expect(board.tasks.get("task_1")?.columnId).toBe("col_wait");
    expect(board.eventsFor("task_1").at(-1)?.message).toBe("Merge this?");
  });

  it("honours an explicitly configured waiting column", async () => {
    const handler = createRequireApprovalHandler(deps());
    await handler.run(context(), { columnId: "col_review" }, gate).catch(() => undefined);

    expect(board.tasks.get("task_1")?.columnId).toBe("col_review");
  });

  it("returns the verdict and resumes once approved", async () => {
    approvals.set("run_1:gate", { state: "approved", comment: "Looks right" });
    const handler = createRequireApprovalHandler(deps());

    const output = await handler.run(context(), {}, gate);

    expect(output).toEqual({ approved: true, comment: "Looks right" });
    expect(board.eventsFor("task_1").some((event) => event.kind === "approved")).toBe(true);
  });

  it("fails the run with the user's own words when rejected", async () => {
    approvals.set("run_1:gate", { state: "rejected", comment: "Wrong approach entirely" });
    const handler = createRequireApprovalHandler(deps());

    await expect(handler.run(context(), {}, gate)).rejects.toThrow("Wrong approach entirely");
    expect(board.eventsFor("task_1").some((event) => event.kind === "rejected")).toBe(true);
  });

  it("never auto-approves: a still-pending decision parks again", async () => {
    approvals.set("run_1:gate", { state: "pending", comment: null });
    const handler = createRequireApprovalHandler(deps());

    await expect(handler.run(context(), {}, gate)).rejects.toThrow(RunPaused);
  });

  it("parks a run that has no card at all", async () => {
    const handler = createRequireApprovalHandler(deps());
    await expect(handler.run(context(null), { message: "Deploy?" }, gate)).rejects.toThrow(
      RunPaused,
    );
    expect(opened).toEqual(["run_1:gate"]);
  });
});
