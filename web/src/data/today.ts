import { belongsOnToday, todayBucket, type TodayBucket } from "@agentflow/core";
import { prisma } from "./client";

/**
 * The 9am screen: what is due, overdue, in flight, and waiting on you —
 * across every board, not one at a time (docs/BOARD.md).
 */

export interface TodayItem {
  taskId: string;
  boardId: string;
  boardName: string;
  columnName: string;
  columnKind: string;
  title: string;
  priority: string;
  repo: string | null;
  dueAt: Date | null;
  bucket: TodayBucket;
  runId: string | null;
  runStatus: string | null;
  /** True when this card's column runs a pipeline, so ▶ Run means something. */
  runnable: boolean;
  /** True when this card is a recurrence template, which never moves itself. */
  isTemplate: boolean;
}

export async function todayItems(now: Date = new Date()): Promise<TodayItem[]> {
  const tasks = await prisma.task.findMany({
    where: { archivedAt: null },
    include: {
      board: { select: { name: true } },
      column: { select: { name: true, kind: true, pipelineId: true } },
      runs: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true, status: true },
      },
    },
    orderBy: [{ dueAt: "asc" }, { order: "asc" }],
  });

  const items: TodayItem[] = [];

  for (const task of tasks) {
    const run = task.runs[0] ?? null;
    const bucket = todayBucket(
      { dueAt: task.dueAt, columnKind: task.column.kind, runStatus: run?.status ?? null },
      now,
    );

    if (!belongsOnToday(bucket, task.column.kind)) continue;

    items.push({
      taskId: task.id,
      boardId: task.boardId,
      boardName: task.board.name,
      columnName: task.column.name,
      columnKind: task.column.kind,
      title: task.title,
      priority: task.priority,
      repo: task.repo,
      dueAt: task.dueAt,
      bucket,
      runId: run?.id ?? null,
      runStatus: run?.status ?? null,
      runnable: task.column.pipelineId !== null,
      isTemplate: task.recurrence !== null,
    });
  }

  return items;
}
