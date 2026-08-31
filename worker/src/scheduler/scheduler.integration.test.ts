import { beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaSchedulerStore } from "./PrismaSchedulerStore";
import { tick } from "./index";

/**
 * The scheduler against the real database.
 *
 * The in-memory tests prove the logic; this proves the guarantee underneath it.
 * "Exactly once per slot" rests on a unique index, not on a check-then-write —
 * so this is the test that would catch a schema change quietly removing it.
 */

const prisma = new PrismaClient();
const store = new PrismaSchedulerStore(prisma);

const utc = (iso: string) => new Date(`${iso}Z`);

let boardId: string;
let columns: Record<string, string>;

beforeEach(async () => {
  await prisma.$transaction([
    prisma.logEntry.deleteMany(),
    prisma.runStep.deleteMany(),
    prisma.runApproval.deleteMany(),
    prisma.run.deleteMany(),
    prisma.taskEvent.deleteMany(),
    prisma.task.deleteMany(),
    prisma.boardColumn.deleteMany(),
    prisma.board.deleteMany(),
    prisma.variable.deleteMany(),
    prisma.pipelineNode.deleteMany(),
    prisma.pipelineEdge.deleteMany(),
    prisma.pipeline.deleteMany(),
  ]);

  const board = await prisma.board.create({
    data: {
      name: "My work",
      columns: {
        create: [
          { name: "Todo", kind: "ready", order: 100 },
          { name: "In progress", kind: "working", order: 200 },
        ],
      },
    },
    include: { columns: true },
  });

  boardId = board.id;
  columns = Object.fromEntries(board.columns.map((column) => [column.kind, column.id]));
});

async function templateCard(recurrence = "0 9 * * *", timezone = "UTC") {
  return prisma.task.create({
    data: {
      boardId,
      columnId: columns.ready!,
      title: "Daily standup notes",
      body: "What moved yesterday?",
      order: 1000,
      labels: ["routine"],
      blockedBy: [],
      recurrence,
      recurrenceTz: timezone,
    },
  });
}

describe("spawning a recurring card", () => {
  it("creates the child in the template's column", async () => {
    const template = await templateCard();

    await tick({ store }, utc("2026-03-10T09:00:30"));

    const children = await prisma.task.findMany({ where: { templateId: template.id } });
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      title: "Daily standup notes",
      columnId: columns.ready,
      boardId,
    });
    expect(children[0]?.scheduledFor?.toISOString()).toBe("2026-03-10T09:00:00.000Z");
  });

  it("copies the brief and the labels the agent will read", async () => {
    const template = await templateCard();
    await tick({ store }, utc("2026-03-10T09:00:30"));

    const child = await prisma.task.findFirst({ where: { templateId: template.id } });
    expect(child?.body).toBe("What moved yesterday?");
    expect(child?.labels).toEqual(["routine"]);
  });

  it("says on the child's timeline that it was created on a schedule", async () => {
    const template = await templateCard();
    await tick({ store }, utc("2026-03-10T09:00:30"));

    const child = await prisma.task.findFirst({ where: { templateId: template.id } });
    const events = await prisma.taskEvent.findMany({ where: { taskId: child!.id } });
    expect(events[0]?.message).toMatch(/Created on schedule/);
  });

  it("leaves the template itself exactly where it was", async () => {
    const template = await templateCard();
    await tick({ store }, utc("2026-03-10T09:00:30"));

    const after = await prisma.task.findUnique({ where: { id: template.id } });
    expect(after).toMatchObject({ columnId: columns.ready, scheduledFor: null });
  });

  it("creates one card however many times the tick runs over the slot", async () => {
    const template = await templateCard();

    for (let i = 0; i < 5; i += 1) {
      await tick({ store }, utc(`2026-03-10T09:0${i}:00`));
    }

    expect(await prisma.task.count({ where: { templateId: template.id } })).toBe(1);
  });

  it("refuses a duplicate slot at the database level, not just in the logic", async () => {
    // Two schedulers racing cannot both win: the second insert is rejected.
    const template = await templateCard();
    const slot = utc("2026-03-10T09:00:00");

    const templates = await store.listRecurringTemplates();
    const first = await store.spawnChild(templates[0]!, slot);
    const second = await store.spawnChild(templates[0]!, slot);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(await prisma.task.count({ where: { templateId: template.id } })).toBe(1);
  });

  it("catches up on missed slots without duplicating the ones it has", async () => {
    const template = await templateCard("0 * * * *");
    await tick({ store }, utc("2026-03-10T06:00:30"));

    await tick({ store }, utc("2026-03-10T09:05:00"));

    const children = await prisma.task.findMany({
      where: { templateId: template.id },
      orderBy: { scheduledFor: "asc" },
    });
    expect(children.map((child) => child.scheduledFor?.toISOString())).toEqual([
      "2026-03-10T06:00:00.000Z",
      "2026-03-10T07:00:00.000Z",
      "2026-03-10T08:00:00.000Z",
      "2026-03-10T09:00:00.000Z",
    ]);
  });

  it("ignores an archived template", async () => {
    const template = await templateCard();
    await prisma.task.update({ where: { id: template.id }, data: { archivedAt: new Date() } });

    await tick({ store }, utc("2026-03-10T09:00:30"));

    expect(await prisma.task.count({ where: { templateId: template.id } })).toBe(0);
  });
});

describe("a scheduled pipeline", () => {
  async function schedulePipeline(cron = "0 2 * * *") {
    return prisma.pipeline.create({
      data: {
        name: "Nightly audit",
        nodes: {
          create: [
            {
              id: "trigger",
              type: "schedule-trigger",
              label: "Nightly",
              config: { cron, timezone: "UTC" },
              x: 0,
              y: 0,
            },
          ],
        },
      },
    });
  }

  it("enqueues a cardless run for its slot", async () => {
    const pipeline = await schedulePipeline();

    await tick({ store }, utc("2026-03-10T02:00:20"));

    const runs = await prisma.run.findMany({ where: { pipelineId: pipeline.id } });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "queued", taskId: null });
    expect(runs[0]?.scheduledFor?.toISOString()).toBe("2026-03-10T02:00:00.000Z");
  });

  it("puts the slot in the trigger payload for the pipeline to read", async () => {
    const pipeline = await schedulePipeline();
    await tick({ store }, utc("2026-03-10T02:00:20"));

    const run = await prisma.run.findFirst({ where: { pipelineId: pipeline.id } });
    expect(run?.trigger).toEqual({ scheduledFor: "2026-03-10T02:00:00.000Z" });
  });

  it("enqueues one run however many times the tick runs", async () => {
    const pipeline = await schedulePipeline();

    for (let i = 0; i < 5; i += 1) {
      await tick({ store }, utc(`2026-03-10T02:0${i}:00`));
    }

    expect(await prisma.run.count({ where: { pipelineId: pipeline.id } })).toBe(1);
  });

  it("refuses a duplicate slot at the database level", async () => {
    await schedulePipeline();
    const slot = utc("2026-03-10T02:00:00");

    const pipelines = await store.listScheduledPipelines();
    expect(await store.enqueueScheduledRun(pipelines[0]!, slot)).not.toBeNull();
    expect(await store.enqueueScheduledRun(pipelines[0]!, slot)).toBeNull();
  });
});
