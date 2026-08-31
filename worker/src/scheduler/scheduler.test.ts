import { beforeEach, describe, expect, it } from "vitest";
import { tick, type RecurringTemplate, type ScheduledPipeline, type SchedulerStore } from "./index";

/**
 * The scheduler. Every test pins the clock; nothing here waits for real time.
 *
 * The property that matters most: a slot produces exactly one card, however
 * many times the tick runs over it.
 */

const utc = (iso: string) => new Date(`${iso}Z`);

/**
 * An in-memory store that enforces the same uniqueness the database does —
 * one row per (template, slot) — so a duplicate is refused here too.
 */
class MemorySchedulerStore implements SchedulerStore {
  templates: RecurringTemplate[] = [];
  pipelines: ScheduledPipeline[] = [];
  readonly cards: { templateId: string; slot: string; id: string }[] = [];
  readonly runs: { pipelineId: string; slot: string; id: string }[] = [];

  private counter = 0;

  async listRecurringTemplates(): Promise<RecurringTemplate[]> {
    // Mirrors the Prisma store: the newest slot already spawned.
    return this.templates.map((template) => ({
      ...template,
      lastSpawnedFor: this.newestSlotFor(template.id),
    }));
  }

  async listScheduledPipelines(): Promise<ScheduledPipeline[]> {
    return this.pipelines.map((pipeline) => ({
      ...pipeline,
      lastScheduledFor: this.newestRunSlotFor(pipeline.id),
    }));
  }

  async spawnChild(template: RecurringTemplate, slot: Date): Promise<{ id: string } | null> {
    const key = slot.toISOString();
    if (this.cards.some((card) => card.templateId === template.id && card.slot === key)) {
      return null;
    }
    const id = `task_${++this.counter}`;
    this.cards.push({ templateId: template.id, slot: key, id });
    return { id };
  }

  async enqueueScheduledRun(
    pipeline: ScheduledPipeline,
    slot: Date,
  ): Promise<{ id: string } | null> {
    const key = slot.toISOString();
    if (this.runs.some((run) => run.pipelineId === pipeline.id && run.slot === key)) return null;
    const id = `run_${++this.counter}`;
    this.runs.push({ pipelineId: pipeline.id, slot: key, id });
    return { id };
  }

  private newestSlotFor(templateId: string): Date | null {
    const slots = this.cards
      .filter((card) => card.templateId === templateId)
      .map((card) => card.slot)
      .sort();
    const newest = slots.at(-1);
    return newest ? new Date(newest) : null;
  }

  private newestRunSlotFor(pipelineId: string): Date | null {
    const slots = this.runs
      .filter((run) => run.pipelineId === pipelineId)
      .map((run) => run.slot)
      .sort();
    const newest = slots.at(-1);
    return newest ? new Date(newest) : null;
  }
}

let store: MemorySchedulerStore;

function template(overrides: Partial<RecurringTemplate> = {}): RecurringTemplate {
  return {
    id: "template_1",
    boardId: "board_1",
    columnId: "col_todo",
    title: "Daily standup notes",
    body: null,
    labels: [],
    priority: "normal",
    repo: null,
    recurrence: "0 9 * * *",
    timezone: "UTC",
    lastSpawnedFor: null,
    createdAt: utc("2026-01-01T00:00:00"),
    ...overrides,
  };
}

function scheduled(overrides: Partial<ScheduledPipeline> = {}): ScheduledPipeline {
  return {
    id: "pipe_1",
    name: "Nightly audit",
    nodeId: "trigger",
    cron: "0 2 * * *",
    timezone: "UTC",
    lastScheduledFor: null,
    createdAt: utc("2026-01-01T00:00:00"),
    ...overrides,
  };
}

beforeEach(() => {
  store = new MemorySchedulerStore();
});

describe("a recurring card", () => {
  it("spawns once when its slot comes round", async () => {
    store.templates = [template()];

    const result = await tick({ store }, utc("2026-03-10T09:00:30"));

    expect(result.spawned).toHaveLength(1);
    expect(result.spawned[0]?.slot.toISOString()).toBe("2026-03-10T09:00:00.000Z");
  });

  it("spawns nothing when the slot has not arrived", async () => {
    store.templates = [template()];
    const result = await tick({ store }, utc("2026-03-10T08:30:00"));
    expect(result.spawned).toEqual([]);
  });

  it("does not spawn again on the very next tick", async () => {
    store.templates = [template()];

    await tick({ store }, utc("2026-03-10T09:00:10"));
    const second = await tick({ store }, utc("2026-03-10T09:00:40"));

    expect(second.spawned).toEqual([]);
    expect(store.cards).toHaveLength(1);
  });

  it("stays at one card however many times the tick runs", async () => {
    store.templates = [template()];

    for (let minute = 0; minute < 30; minute += 1) {
      await tick({ store }, utc(`2026-03-10T09:${String(minute).padStart(2, "0")}:00`));
    }

    expect(store.cards).toHaveLength(1);
  });

  it("catches up after three hours down without spawning 180 duplicates", async () => {
    // Hourly card; the worker was last up at 06:00 and comes back at 09:05.
    store.templates = [template({ recurrence: "0 * * * *" })];
    await tick({ store }, utc("2026-03-10T06:00:30"));

    const result = await tick({ store }, utc("2026-03-10T09:05:00"));

    // 07:00, 08:00 and 09:00 — the slots it actually missed.
    expect(result.spawned.map((item) => item.slot.toISOString())).toEqual([
      "2026-03-10T07:00:00.000Z",
      "2026-03-10T08:00:00.000Z",
      "2026-03-10T09:00:00.000Z",
    ]);
    expect(store.cards).toHaveLength(4);
  });

  it("does not spawn a backlog for a template switched on long ago", async () => {
    // Never fired, created months back: the lookback keeps this to one card.
    store.templates = [template({ createdAt: utc("2025-01-01T00:00:00") })];

    const result = await tick({ store }, utc("2026-03-10T09:00:30"));

    expect(result.spawned).toHaveLength(1);
  });

  it("reports a slot it had already handled rather than silently dropping it", async () => {
    store.templates = [template()];
    await tick({ store }, utc("2026-03-10T09:00:10"));

    // Force a replay of the same window by reporting no high-water mark, as a
    // scheduler that had just restarted mid-slot would.
    const forgetful: SchedulerStore = {
      listRecurringTemplates: async () => [template()],
      listScheduledPipelines: async () => [],
      spawnChild: (item, slot) => store.spawnChild(item, slot),
      enqueueScheduledRun: (item, slot) => store.enqueueScheduledRun(item, slot),
    };

    const replay = await tick({ store: forgetful }, utc("2026-03-10T09:00:40"));

    expect(replay.spawned).toEqual([]);
    expect(replay.skipped).toBe(1);
  });

  it("keeps going when one card's schedule cannot be read", async () => {
    store.templates = [
      template({ id: "broken", recurrence: "every morning" }),
      template({ id: "fine" }),
    ];

    const result = await tick({ store }, utc("2026-03-10T09:00:30"));

    expect(result.problems.map((problem) => problem.id)).toEqual(["broken"]);
    expect(result.spawned.map((item) => item.templateId)).toEqual(["fine"]);
  });

  it("reads the schedule in the card's own timezone", async () => {
    store.templates = [template({ timezone: "Asia/Manila" })];

    // 09:00 Manila is 01:00 UTC; nothing should fire at 09:00 UTC.
    expect((await tick({ store }, utc("2026-03-10T09:00:30"))).spawned).toEqual([]);
    expect((await tick({ store }, utc("2026-03-11T01:00:30"))).spawned).toHaveLength(1);
  });
});

describe("a scheduled pipeline", () => {
  it("enqueues a cardless run on its cron", async () => {
    store.pipelines = [scheduled()];

    const result = await tick({ store }, utc("2026-03-10T02:00:20"));

    expect(result.enqueued).toHaveLength(1);
    expect(result.enqueued[0]?.slot.toISOString()).toBe("2026-03-10T02:00:00.000Z");
  });

  it("enqueues exactly one run per slot", async () => {
    store.pipelines = [scheduled()];

    await tick({ store }, utc("2026-03-10T02:00:20"));
    await tick({ store }, utc("2026-03-10T02:00:50"));

    expect(store.runs).toHaveLength(1);
  });

  it("catches up on missed nights", async () => {
    store.pipelines = [scheduled()];
    await tick({ store }, utc("2026-03-08T02:00:10"));

    const result = await tick({ store }, utc("2026-03-10T02:00:10"));

    expect(result.enqueued.map((item) => item.slot.toISOString())).toEqual([
      "2026-03-09T02:00:00.000Z",
      "2026-03-10T02:00:00.000Z",
    ]);
  });

  it("keeps going when one pipeline's cron cannot be read", async () => {
    store.pipelines = [scheduled({ id: "broken", cron: "" }), scheduled({ id: "fine" })];

    const result = await tick({ store }, utc("2026-03-10T02:00:10"));

    expect(result.problems.map((problem) => problem.id)).toEqual(["broken"]);
    expect(result.enqueued.map((item) => item.pipelineId)).toEqual(["fine"]);
  });
});

describe("a quiet tick", () => {
  it("does nothing at all when nothing is due", async () => {
    store.templates = [template()];
    store.pipelines = [scheduled()];

    const result = await tick({ store }, utc("2026-03-10T15:00:00"));

    expect(result).toMatchObject({ spawned: [], enqueued: [], skipped: 0, problems: [] });
  });

  it("does nothing at all when there is nothing scheduled", async () => {
    const result = await tick({ store }, utc("2026-03-10T09:00:00"));
    expect(result.spawned).toEqual([]);
    expect(result.enqueued).toEqual([]);
  });
});
