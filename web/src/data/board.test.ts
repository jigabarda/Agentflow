// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_COLUMNS, createBoard, getBoard, getColumn, updateColumn } from "./boards";
import { createPipeline } from "./pipelines";
import {
  ColumnEntryRejected,
  appendTaskEvent,
  archiveTask,
  createTask,
  getTask,
  listTaskEvents,
  listTasks,
  moveTask,
  unresolvedBlockersOf,
  updateTask,
} from "./tasks";
import { resetDatabase } from "./testing";

beforeEach(resetDatabase);

async function seedBoard() {
  const board = await createBoard("My work");
  const byKind = Object.fromEntries(board.columns.map((c) => [c.kind, c])) as Record<
    string,
    (typeof board.columns)[number]
  >;
  return { board, byKind };
}

describe("createBoard", () => {
  it("creates the five default columns in order", async () => {
    const board = await createBoard("My work");
    expect(board.columns.map((c) => c.name)).toEqual(DEFAULT_COLUMNS.map((c) => c.name));
    expect(board.columns.map((c) => c.kind)).toEqual([
      "backlog",
      "ready",
      "working",
      "waiting",
      "done",
    ]);
    expect(board.columns.map((c) => c.order)).toEqual([100, 200, 300, 400, 500]);
  });

  it("reads back with its columns", async () => {
    const created = await createBoard("My work");
    const loaded = await getBoard(created.id);
    expect(loaded?.columns).toHaveLength(5);
  });

  it("returns null for a board that does not exist", async () => {
    expect(await getBoard("nope")).toBeNull();
  });

  it("starts every column unautomated", async () => {
    const board = await createBoard("My work");
    expect(board.columns.every((c) => c.pipelineId === null)).toBe(true);
    expect(board.columns.every((c) => c.autoAdvance === null)).toBe(true);
  });
});

describe("updateColumn", () => {
  it("binds a pipeline and auto-advance rules to a column", async () => {
    const { byKind } = await seedBoard();
    const pipeline = await createPipeline({ name: "Implement a task" });

    const updated = await updateColumn(byKind.working!.id, {
      pipelineId: pipeline.id,
      autoAdvance: { onRunSucceeded: byKind.waiting!.id, onRunFailed: byKind.ready!.id },
      wipLimit: 3,
    });

    expect(updated.pipelineId).toBe(pipeline.id);
    expect(updated.autoAdvance).toEqual({
      onRunSucceeded: byKind.waiting!.id,
      onRunFailed: byKind.ready!.id,
    });
    expect(updated.wipLimit).toBe(3);

    const reloaded = await getColumn(byKind.working!.id);
    expect(reloaded?.autoAdvance?.onRunSucceeded).toBe(byKind.waiting!.id);
  });

  it("can unbind automation again", async () => {
    const { byKind } = await seedBoard();
    const pipeline = await createPipeline({ name: "Implement a task" });
    await updateColumn(byKind.working!.id, { pipelineId: pipeline.id });
    const cleared = await updateColumn(byKind.working!.id, {
      pipelineId: null,
      autoAdvance: null,
    });
    expect(cleared.pipelineId).toBeNull();
    expect(cleared.autoAdvance).toBeNull();
  });
});

describe("createTask", () => {
  it("creates a card from a title alone", async () => {
    const { board, byKind } = await seedBoard();
    const task = await createTask({
      boardId: board.id,
      columnId: byKind.backlog!.id,
      title: "Fix login redirect",
    });

    expect(task.title).toBe("Fix login redirect");
    expect(task.priority).toBe("normal");
    expect(task.labels).toEqual([]);
    expect(task.blockedBy).toEqual([]);
  });

  it("puts each new card at the TOP, where the quick-add box is", async () => {
    const { board, byKind } = await seedBoard();
    const first = await createTask({ boardId: board.id, columnId: byKind.backlog!.id, title: "1" });
    const second = await createTask({
      boardId: board.id,
      columnId: byKind.backlog!.id,
      title: "2",
    });

    // You always see what you just typed, even in a column of hundreds.
    expect(second.order).toBeLessThan(first.order);
    const column = (await listTasks(board.id)).filter((t) => t.columnId === byKind.backlog!.id);
    expect(column.map((t) => t.title)).toEqual(["2", "1"]);
  });

  it("records a created event on the timeline", async () => {
    const { board, byKind } = await seedBoard();
    const task = await createTask({ boardId: board.id, columnId: byKind.backlog!.id, title: "x" });
    const events = await listTaskEvents(task.id);
    expect(events.map((e) => e.kind)).toEqual(["created"]);
    expect(events[0]!.actor).toBe("user");
  });

  it("rejects a card with no title", async () => {
    const { board, byKind } = await seedBoard();
    await expect(
      createTask({ boardId: board.id, columnId: byKind.backlog!.id, title: "" }),
    ).rejects.toThrow();
  });

  it("round-trips labels and blockers through the Json columns", async () => {
    const { board, byKind } = await seedBoard();
    const blocker = await createTask({
      boardId: board.id,
      columnId: byKind.backlog!.id,
      title: "first",
    });
    const task = await createTask({
      boardId: board.id,
      columnId: byKind.backlog!.id,
      title: "second",
      labels: ["bug", "auth"],
      blockedBy: [blocker.id],
      repo: "acme/app",
      priority: "high",
    });

    const loaded = await getTask(task.id);
    expect(loaded?.labels).toEqual(["bug", "auth"]);
    expect(loaded?.blockedBy).toEqual([blocker.id]);
    expect(loaded?.repo).toBe("acme/app");
    expect(loaded?.priority).toBe("high");
  });
});

describe("updateTask", () => {
  it("edits the brief and logs what changed", async () => {
    const { board, byKind } = await seedBoard();
    const task = await createTask({ boardId: board.id, columnId: byKind.backlog!.id, title: "x" });

    const updated = await updateTask(task.id, {
      body: "## Steps\n1. reproduce",
      priority: "urgent",
    });
    expect(updated.body).toContain("reproduce");
    expect(updated.priority).toBe("urgent");

    const events = await listTaskEvents(task.id);
    expect(events.map((e) => e.kind)).toEqual(["created", "updated"]);
    expect(events[1]!.meta?.fields).toEqual(["body", "priority"]);
  });

  it("writes no event when nothing was passed", async () => {
    const { board, byKind } = await seedBoard();
    const task = await createTask({ boardId: board.id, columnId: byKind.backlog!.id, title: "x" });
    await updateTask(task.id, {});
    expect(await listTaskEvents(task.id)).toHaveLength(1);
  });
});

describe("moveTask", () => {
  it("moves a card between columns and records it", async () => {
    const { board, byKind } = await seedBoard();
    const task = await createTask({ boardId: board.id, columnId: byKind.backlog!.id, title: "x" });

    const { task: moved } = await moveTask(task.id, { columnId: byKind.working!.id });
    expect(moved.columnId).toBe(byKind.working!.id);

    const events = await listTaskEvents(task.id);
    expect(events.map((e) => e.kind)).toEqual(["created", "moved"]);
    expect(events[1]!.message).toBe("Moved from Backlog to In progress.");
  });

  it("orders a card between the two neighbours it was dropped between", async () => {
    const { board, byKind } = await seedBoard();
    // Cards prepend, so creating a then b leaves the column reading [b, a].
    const a = await createTask({ boardId: board.id, columnId: byKind.ready!.id, title: "a" });
    const b = await createTask({ boardId: board.id, columnId: byKind.ready!.id, title: "b" });
    const c = await createTask({ boardId: board.id, columnId: byKind.backlog!.id, title: "c" });

    const { task: moved } = await moveTask(c.id, {
      columnId: byKind.ready!.id,
      afterTaskId: b.id,
      beforeTaskId: a.id,
    });

    expect(moved.order).toBeGreaterThan(b.order);
    expect(moved.order).toBeLessThan(a.order);

    const inColumn = (await listTasks(board.id)).filter((t) => t.columnId === byKind.ready!.id);
    expect(inColumn.map((t) => t.title)).toEqual(["b", "c", "a"]);
  });

  it("writes no move event when the card only changes position within a column", async () => {
    const { board, byKind } = await seedBoard();
    const a = await createTask({ boardId: board.id, columnId: byKind.ready!.id, title: "a" });
    const b = await createTask({ boardId: board.id, columnId: byKind.ready!.id, title: "b" });

    await moveTask(b.id, { columnId: byKind.ready!.id, beforeTaskId: a.id });
    const events = await listTaskEvents(b.id);
    expect(events.map((e) => e.kind)).toEqual(["created"]);
  });

  it("REJECTS a blocked card entering a working column", async () => {
    const { board, byKind } = await seedBoard();
    const blocker = await createTask({
      boardId: board.id,
      columnId: byKind.ready!.id,
      title: "do first",
    });
    const blocked = await createTask({
      boardId: board.id,
      columnId: byKind.backlog!.id,
      title: "blocked",
      blockedBy: [blocker.id],
    });

    await expect(moveTask(blocked.id, { columnId: byKind.working!.id })).rejects.toThrow(
      ColumnEntryRejected,
    );

    // The card did not move.
    expect((await getTask(blocked.id))?.columnId).toBe(byKind.backlog!.id);
  });

  it("allows the blocked card through once its blocker is done", async () => {
    const { board, byKind } = await seedBoard();
    const blocker = await createTask({
      boardId: board.id,
      columnId: byKind.ready!.id,
      title: "do first",
    });
    const blocked = await createTask({
      boardId: board.id,
      columnId: byKind.backlog!.id,
      title: "blocked",
      blockedBy: [blocker.id],
    });

    await moveTask(blocker.id, { columnId: byKind.done!.id });
    const { task } = await moveTask(blocked.id, { columnId: byKind.working!.id });
    expect(task.columnId).toBe(byKind.working!.id);
  });

  it("still lets a blocked card sit in a non-working column", async () => {
    const { board, byKind } = await seedBoard();
    const blocker = await createTask({ boardId: board.id, columnId: byKind.ready!.id, title: "b" });
    const blocked = await createTask({
      boardId: board.id,
      columnId: byKind.backlog!.id,
      title: "x",
      blockedBy: [blocker.id],
    });

    const { task } = await moveTask(blocked.id, { columnId: byKind.ready!.id });
    expect(task.columnId).toBe(byKind.ready!.id);
  });

  it("warns but still moves when a column is over its WIP limit", async () => {
    const { board, byKind } = await seedBoard();
    await updateColumn(byKind.working!.id, { wipLimit: 1 });
    await createTask({ boardId: board.id, columnId: byKind.working!.id, title: "already here" });
    const task = await createTask({ boardId: board.id, columnId: byKind.backlog!.id, title: "x" });

    const result = await moveTask(task.id, { columnId: byKind.working!.id });
    expect(result.task.columnId).toBe(byKind.working!.id);
    expect(result.warning).toContain("WIP limit");
  });

  it("survives repeated drops into the same slot by renormalizing the column", async () => {
    const { board, byKind } = await seedBoard();
    const column = byKind.ready!.id;
    // Cards prepend, so the column reads [top, bottom].
    const bottom = await createTask({ boardId: board.id, columnId: column, title: "bottom" });
    await createTask({ boardId: board.id, columnId: column, title: "top" });

    // Always drop into the same slot, just above `bottom` — the case that halves
    // the gap every time and eventually exhausts float precision.
    for (let i = 0; i < 80; i++) {
      const card = await createTask({
        boardId: board.id,
        columnId: byKind.backlog!.id,
        title: `card ${i}`,
      });
      await moveTask(card.id, { columnId: column, beforeTaskId: bottom.id });
    }

    const inColumn = (await listTasks(board.id)).filter((t) => t.columnId === column);
    expect(inColumn).toHaveLength(82);

    // The invariant that matters: every card still has a distinct place in a
    // strict order, however many times the gap had to be respaced.
    const orders = inColumn.map((t) => t.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(new Set(orders).size).toBe(orders.length);
    expect(inColumn.at(-1)!.title).toBe("bottom");
  });

  it("refuses to move a card that does not exist", async () => {
    const { byKind } = await seedBoard();
    await expect(moveTask("ghost", { columnId: byKind.ready!.id })).rejects.toThrow(/not found/);
  });
});

describe("unresolvedBlockersOf", () => {
  it("ignores blockers that were deleted", async () => {
    expect(await unresolvedBlockersOf({ blockedBy: ["gone"] })).toEqual([]);
  });

  it("counts an archived blocker as resolved", async () => {
    const { board, byKind } = await seedBoard();
    const blocker = await createTask({ boardId: board.id, columnId: byKind.ready!.id, title: "b" });
    await archiveTask(blocker.id);
    expect(await unresolvedBlockersOf({ blockedBy: [blocker.id] })).toEqual([]);
  });
});

describe("task timeline", () => {
  it("interleaves human and agent entries in one feed", async () => {
    const { board, byKind } = await seedBoard();
    const task = await createTask({ boardId: board.id, columnId: byKind.ready!.id, title: "x" });

    await appendTaskEvent(task.id, {
      actor: "user",
      kind: "commented",
      message: "Check the redirect after SSO.",
    });
    await appendTaskEvent(task.id, {
      actor: "agent:implementer",
      kind: "run_step",
      message: "Edited src/auth/redirect.ts",
      meta: { nodeId: "implementer", step: 3 },
    });

    const events = await listTaskEvents(task.id);
    expect(events.map((e) => e.actor)).toEqual(["user", "user", "agent:implementer"]);
    expect(events.at(-1)!.meta).toEqual({ nodeId: "implementer", step: 3 });
  });
});

describe("listTasks", () => {
  it("hides archived cards unless asked", async () => {
    const { board, byKind } = await seedBoard();
    const task = await createTask({ boardId: board.id, columnId: byKind.ready!.id, title: "x" });
    await archiveTask(task.id);

    expect(await listTasks(board.id)).toHaveLength(0);
    expect(await listTasks(board.id, { includeArchived: true })).toHaveLength(1);
  });
});
