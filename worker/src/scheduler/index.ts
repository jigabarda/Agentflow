import { dueSlots } from "@agentflow/core";

/**
 * The scheduler — work that shows up on its own.
 *
 * Two jobs, one tick:
 *   · a **template card** with a recurrence spawns a child into its column;
 *   · a pipeline whose trigger is a **schedule** enqueues a cardless run.
 *
 * Idempotence is the whole game here. A tick that runs twice, a worker that
 * was down for three hours, two workers racing — none of them may produce a
 * duplicate. Two things guarantee that:
 *
 *   1. slots are computed from an *exclusive* lower bound, so re-running the
 *      same window yields nothing;
 *   2. the write itself is unique on (template, slot) and (pipeline, slot), so
 *      even a genuine race ends with one row and one refusal.
 *
 * The clock is an argument. Nothing here reads the wall time.
 */

export const DEFAULT_TICK_MS = 60_000;
/** How far back a first-ever tick looks. Long enough to cover a restart. */
export const DEFAULT_LOOKBACK_MS = 5 * 60_000;

export interface RecurringTemplate {
  id: string;
  boardId: string;
  columnId: string;
  title: string;
  body: string | null;
  labels: string[];
  priority: string;
  repo: string | null;
  recurrence: string;
  timezone: string;
  /** The newest slot already spawned, if any. */
  lastSpawnedFor: Date | null;
  createdAt: Date;
}

export interface ScheduledPipeline {
  id: string;
  name: string;
  nodeId: string;
  cron: string;
  timezone: string;
  lastScheduledFor: Date | null;
  createdAt: Date;
}

export interface SchedulerStore {
  listRecurringTemplates(): Promise<RecurringTemplate[]>;
  listScheduledPipelines(): Promise<ScheduledPipeline[]>;
  /** Create the child card. Returns null when that slot already exists. */
  spawnChild(template: RecurringTemplate, slot: Date): Promise<{ id: string } | null>;
  /** Enqueue the run. Returns null when that slot already exists. */
  enqueueScheduledRun(pipeline: ScheduledPipeline, slot: Date): Promise<{ id: string } | null>;
}

export interface SchedulerDeps {
  store: SchedulerStore;
  log?: (level: "info" | "warn" | "error", message: string) => void;
  /** How far back to look when a template has never fired. */
  lookbackMs?: number;
}

export interface TickResult {
  /** Cards actually created, by template id. */
  spawned: { templateId: string; taskId: string; slot: Date }[];
  /** Runs actually enqueued. */
  enqueued: { pipelineId: string; runId: string; slot: Date }[];
  /** Slots that were already handled — the proof that a replay is harmless. */
  skipped: number;
  /** Templates whose recurrence could not be read. */
  problems: { id: string; message: string }[];
}

/**
 * Where to start looking for missed slots.
 *
 * The last slot handled, when there is one. Otherwise a short lookback — not
 * the card's creation date, or turning on a months-old template would spawn
 * months of backlog the moment the worker started.
 */
function windowStart(last: Date | null, now: Date, lookbackMs: number): Date {
  return last ?? new Date(now.getTime() - lookbackMs);
}

export async function tick(deps: SchedulerDeps, now: Date): Promise<TickResult> {
  const lookbackMs = deps.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const log = deps.log ?? (() => {});

  const result: TickResult = { spawned: [], enqueued: [], skipped: 0, problems: [] };

  for (const template of await deps.store.listRecurringTemplates()) {
    let slots: Date[];
    try {
      slots = dueSlots(
        template.recurrence,
        template.timezone,
        windowStart(template.lastSpawnedFor, now, lookbackMs),
        now,
      );
    } catch (error) {
      // A card with an unreadable schedule must not stop every other one.
      const message = error instanceof Error ? error.message : String(error);
      result.problems.push({ id: template.id, message });
      log("warn", `Card "${template.title}" has a schedule that cannot be read: ${message}`);
      continue;
    }

    for (const slot of slots) {
      const created = await deps.store.spawnChild(template, slot);
      if (!created) {
        result.skipped += 1;
        continue;
      }
      result.spawned.push({ templateId: template.id, taskId: created.id, slot });
      log("info", `Spawned "${template.title}" for ${slot.toISOString()}.`);
    }
  }

  for (const pipeline of await deps.store.listScheduledPipelines()) {
    let slots: Date[];
    try {
      slots = dueSlots(
        pipeline.cron,
        pipeline.timezone,
        windowStart(pipeline.lastScheduledFor, now, lookbackMs),
        now,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.problems.push({ id: pipeline.id, message });
      log("warn", `Pipeline "${pipeline.name}" has a schedule that cannot be read: ${message}`);
      continue;
    }

    for (const slot of slots) {
      const run = await deps.store.enqueueScheduledRun(pipeline, slot);
      if (!run) {
        result.skipped += 1;
        continue;
      }
      result.enqueued.push({ pipelineId: pipeline.id, runId: run.id, slot });
      log("info", `Queued "${pipeline.name}" for ${slot.toISOString()}.`);
    }
  }

  return result;
}
