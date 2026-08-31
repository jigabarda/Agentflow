import type { RunStatus } from "@agentflow/core";
import { prisma } from "./client";

/**
 * Run history — the dashboard's data.
 *
 * What a person asks of a run list is always one of three things: what is
 * happening now, what went wrong, and what did it cost. So those are the
 * columns, and the filter is on status.
 */

export interface RunListItem {
  id: string;
  pipelineId: string;
  pipelineName: string;
  status: RunStatus;
  taskId: string | null;
  taskTitle: string | null;
  error: string | null;
  tokensUsed: number;
  maxTokensPerRun: number | null;
  stepsDone: number;
  stepsTotal: number;
  createdAt: Date;
  endedAt: Date | null;
}

export interface RunListFilters {
  status?: string;
  pipelineId?: string;
  limit?: number;
}

export async function listRuns(filters: RunListFilters = {}): Promise<RunListItem[]> {
  const rows = await prisma.run.findMany({
    where: {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.pipelineId ? { pipelineId: filters.pipelineId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(filters.limit ?? 50, 200),
    select: {
      id: true,
      pipelineId: true,
      status: true,
      error: true,
      tokensUsed: true,
      createdAt: true,
      endedAt: true,
      taskId: true,
      pipeline: {
        select: { name: true, maxTokensPerRun: true, _count: { select: { nodes: true } } },
      },
      task: { select: { title: true } },
      steps: { select: { status: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    pipelineId: row.pipelineId,
    pipelineName: row.pipeline.name,
    status: row.status as RunStatus,
    taskId: row.taskId,
    taskTitle: row.task?.title ?? null,
    error: row.error,
    tokensUsed: row.tokensUsed,
    maxTokensPerRun: row.pipeline.maxTokensPerRun,
    stepsDone: row.steps.filter((step) => step.status === "succeeded").length,
    stepsTotal: row.pipeline._count.nodes,
    createdAt: row.createdAt,
    endedAt: row.endedAt,
  }));
}

/** Totals for the dashboard header. */
export async function runTotals(): Promise<{
  byStatus: Record<string, number>;
  tokensToday: number;
}> {
  const grouped = await prisma.run.groupBy({ by: ["status"], _count: { _all: true } });

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const today = await prisma.run.aggregate({
    _sum: { tokensUsed: true },
    where: { createdAt: { gte: startOfToday } },
  });

  return {
    byStatus: Object.fromEntries(grouped.map((row) => [row.status, row._count._all])),
    tokensToday: today._sum.tokensUsed ?? 0,
  };
}
