// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { createBoard } from "./boards";
import { prisma } from "./client";
import { createPipeline } from "./pipelines";
import { createTask, updateTask } from "./tasks";
import { resetDatabase } from "./testing";
import { todayItems } from "./today";

/**
 * The Today screen's data: what is due, running, or waiting on you, across
 * every board. The clock is passed in, so none of this depends on the hour.
 */

beforeEach(resetDatabase);

const now = new Date(2026, 2, 10, 14, 0, 0);
const laterToday = new Date(2026, 2, 10, 23, 0, 0);
const yesterday = new Date(2026, 2, 9, 9, 0, 0);

async function seed() {
  const board = await createBoard("My work");
  const byKind = Object.fromEntries(board.columns.map((column) => [column.kind, column]));
  return { board, byKind };
}

describe("todayItems", () => {
  it("shows a card due today", async () => {
    const { board, byKind } = await seed();
    await createTask({
      boardId: board.id,
      columnId: byKind.ready!.id,
      title: "Due today",
      dueAt: laterToday,
    });

    const items = await todayItems(now);
    expect(items.map((item) => item.title)).toEqual(["Due today"]);
    expect(items[0]?.bucket).toBe("due");
  });

  it("shows an overdue card as overdue", async () => {
    const { board, byKind } = await seed();
    await createTask({
      boardId: board.id,
      columnId: byKind.ready!.id,
      title: "Late",
      dueAt: yesterday,
    });

    expect((await todayItems(now))[0]?.bucket).toBe("overdue");
  });

  it("leaves out a card with nothing happening to it", async () => {
    const { board, byKind } = await seed();
    await createTask({ boardId: board.id, columnId: byKind.ready!.id, title: "Someday" });

    expect(await todayItems(now)).toEqual([]);
  });

  it("leaves out finished work even when it was due", async () => {
    const { board, byKind } = await seed();
    const task = await createTask({
      boardId: board.id,
      columnId: byKind.done!.id,
      title: "Shipped",
      dueAt: yesterday,
    });
    expect(task.columnId).toBe(byKind.done!.id);

    expect(await todayItems(now)).toEqual([]);
  });

  it("shows a running card as in flight, whatever its due date", async () => {
    const { board, byKind } = await seed();
    const pipeline = await createPipeline({ name: "P", nodes: [], edges: [] });
    const task = await createTask({
      boardId: board.id,
      columnId: byKind.working!.id,
      title: "Working on it",
    });
    await prisma.run.create({
      data: { pipelineId: pipeline.id, taskId: task.id, status: "running", trigger: {} },
    });

    const items = await todayItems(now);
    expect(items[0]).toMatchObject({ bucket: "in-flight", runStatus: "running" });
  });

  it("puts a card awaiting a decision in the waiting pile", async () => {
    const { board, byKind } = await seed();
    const pipeline = await createPipeline({ name: "P", nodes: [], edges: [] });
    const task = await createTask({
      boardId: board.id,
      columnId: byKind.waiting!.id,
      title: "Needs you",
    });
    await prisma.run.create({
      data: {
        pipelineId: pipeline.id,
        taskId: task.id,
        status: "awaiting_approval",
        trigger: {},
      },
    });

    const items = await todayItems(now);
    expect(items[0]).toMatchObject({ bucket: "waiting" });
    expect(items[0]?.runId).not.toBeNull();
  });

  it("reads only the newest run for a card", async () => {
    const { board, byKind } = await seed();
    const pipeline = await createPipeline({ name: "P", nodes: [], edges: [] });
    const task = await createTask({
      boardId: board.id,
      columnId: byKind.working!.id,
      title: "Retried",
    });

    await prisma.run.create({
      data: { pipelineId: pipeline.id, taskId: task.id, status: "failed", trigger: {} },
    });
    await prisma.run.create({
      data: { pipelineId: pipeline.id, taskId: task.id, status: "running", trigger: {} },
    });

    expect((await todayItems(now))[0]?.runStatus).toBe("running");
  });

  it("says whether Run would actually do anything", async () => {
    const { board, byKind } = await seed();
    const pipeline = await createPipeline({ name: "P", nodes: [], edges: [] });
    await prisma.boardColumn.update({
      where: { id: byKind.ready!.id },
      data: { pipelineId: pipeline.id },
    });

    await createTask({
      boardId: board.id,
      columnId: byKind.ready!.id,
      title: "Runnable",
      dueAt: laterToday,
    });
    await createTask({
      boardId: board.id,
      columnId: byKind.backlog!.id,
      title: "Not runnable",
      dueAt: laterToday,
    });

    const items = await todayItems(now);
    expect(items.find((item) => item.title === "Runnable")?.runnable).toBe(true);
    expect(items.find((item) => item.title === "Not runnable")?.runnable).toBe(false);
  });

  it("marks a recurrence template as one", async () => {
    const { board, byKind } = await seed();
    const task = await createTask({
      boardId: board.id,
      columnId: byKind.ready!.id,
      title: "Daily standup",
      dueAt: laterToday,
    });
    await updateTask(task.id, { recurrence: "0 9 * * 1-5", recurrenceTz: "UTC" });

    expect((await todayItems(now))[0]?.isTemplate).toBe(true);
  });

  it("spans every board, because 'what should I do now' does not care", async () => {
    const first = await seed();
    const second = await createBoard("Side project");

    await createTask({
      boardId: first.board.id,
      columnId: first.byKind.ready!.id,
      title: "From board one",
      dueAt: laterToday,
    });
    await createTask({
      boardId: second.id,
      columnId: second.columns.find((column) => column.kind === "ready")!.id,
      title: "From board two",
      dueAt: laterToday,
    });

    const items = await todayItems(now);
    expect(items.map((item) => item.title).sort()).toEqual(["From board one", "From board two"]);
    expect(new Set(items.map((item) => item.boardName)).size).toBe(2);
  });

  it("leaves out archived cards", async () => {
    const { board, byKind } = await seed();
    const task = await createTask({
      boardId: board.id,
      columnId: byKind.ready!.id,
      title: "Put away",
      dueAt: yesterday,
    });
    await prisma.task.update({ where: { id: task.id }, data: { archivedAt: new Date() } });

    expect(await todayItems(now)).toEqual([]);
  });
});
