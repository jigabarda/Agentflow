import { TRIGGER_NODE_TYPES } from "@agentflow/core";
import type { PrismaClient } from "@prisma/client";
import type { RecurringTemplate, ScheduledPipeline, SchedulerStore } from "./index";

/**
 * The scheduler's storage.
 *
 * Both writes rely on a unique index rather than a read-then-write check: two
 * schedulers racing on the same slot end with one row and one caught conflict,
 * which a "does it exist yet?" query could never promise.
 */

const UNIQUE_VIOLATION = "P2002";
const SCHEDULE_TRIGGER = "schedule-trigger";
const DEFAULT_TIMEZONE = "UTC";

function isDuplicate(error: unknown): boolean {
  return (error as { code?: string })?.code === UNIQUE_VIOLATION;
}

export class PrismaSchedulerStore implements SchedulerStore {
  constructor(private readonly prisma: PrismaClient) {}

  async listRecurringTemplates(): Promise<RecurringTemplate[]> {
    const rows = await this.prisma.task.findMany({
      where: { recurrence: { not: null }, archivedAt: null },
    });

    return Promise.all(
      rows.map(async (row) => {
        const newest = await this.prisma.task.findFirst({
          where: { templateId: row.id, scheduledFor: { not: null } },
          orderBy: { scheduledFor: "desc" },
          select: { scheduledFor: true },
        });

        return {
          id: row.id,
          boardId: row.boardId,
          columnId: row.columnId,
          title: row.title,
          body: row.body,
          labels: Array.isArray(row.labels) ? (row.labels as string[]) : [],
          priority: row.priority,
          repo: row.repo,
          recurrence: row.recurrence!,
          timezone: row.recurrenceTz ?? DEFAULT_TIMEZONE,
          lastSpawnedFor: newest?.scheduledFor ?? null,
          createdAt: row.createdAt,
        };
      }),
    );
  }

  async listScheduledPipelines(): Promise<ScheduledPipeline[]> {
    const nodes = await this.prisma.pipelineNode.findMany({
      where: { type: SCHEDULE_TRIGGER },
      include: { pipeline: { select: { id: true, name: true } } },
    });

    return Promise.all(
      nodes.map(async (node) => {
        const config = (node.config ?? {}) as { cron?: unknown; timezone?: unknown };

        const newest = await this.prisma.run.findFirst({
          where: { pipelineId: node.pipelineId, scheduledFor: { not: null } },
          orderBy: { scheduledFor: "desc" },
          select: { scheduledFor: true },
        });

        return {
          id: node.pipelineId,
          name: node.pipeline.name,
          nodeId: node.id,
          cron: typeof config.cron === "string" ? config.cron : "",
          timezone: typeof config.timezone === "string" ? config.timezone : DEFAULT_TIMEZONE,
          lastScheduledFor: newest?.scheduledFor ?? null,
          createdAt: new Date(),
        };
      }),
    );
  }

  async spawnChild(template: RecurringTemplate, slot: Date): Promise<{ id: string } | null> {
    // The child goes to the top of the column, where a fresh card belongs.
    const first = await this.prisma.task.findFirst({
      where: { columnId: template.columnId, archivedAt: null },
      orderBy: { order: "asc" },
      select: { order: true },
    });

    try {
      const created = await this.prisma.task.create({
        data: {
          boardId: template.boardId,
          columnId: template.columnId,
          title: template.title,
          body: template.body,
          order: (first?.order ?? 1000) - 1000,
          priority: template.priority,
          labels: template.labels,
          repo: template.repo,
          blockedBy: [],
          templateId: template.id,
          scheduledFor: slot,
        },
        select: { id: true },
      });

      await this.prisma.taskEvent.create({
        data: {
          taskId: created.id,
          actor: "system",
          kind: "created",
          message: `Created on schedule for ${slot.toISOString()}.`,
          meta: { templateId: template.id, scheduledFor: slot.toISOString() },
        },
      });

      return created;
    } catch (error) {
      // Someone else got this slot first. That is the system working.
      if (isDuplicate(error)) return null;
      throw error;
    }
  }

  async enqueueScheduledRun(
    pipeline: ScheduledPipeline,
    slot: Date,
  ): Promise<{ id: string } | null> {
    try {
      return await this.prisma.run.create({
        data: {
          pipelineId: pipeline.id,
          status: "queued",
          scheduledFor: slot,
          // A cardless run: the trigger payload is the slot itself.
          trigger: { scheduledFor: slot.toISOString() },
        },
        select: { id: true },
      });
    } catch (error) {
      if (isDuplicate(error)) return null;
      throw error;
    }
  }
}

/** Node types that start a run on a clock rather than on a card. */
export const SCHEDULE_TRIGGER_TYPES = TRIGGER_NODE_TYPES.filter(
  (type) => type === SCHEDULE_TRIGGER,
);
