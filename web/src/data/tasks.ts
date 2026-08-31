import {
  OrderPrecisionError,
  checkColumnEntry,
  createTaskInputSchema,
  orderBetween,
  renormalizeOrders,
  updateTaskInputSchema,
} from "@agentflow/core";
import type {
  ColumnKind,
  Task,
  TaskEvent,
  TaskEventActor,
  TaskEventKind,
  TaskPriority,
} from "@agentflow/core";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "./client";
import { toRecord, toStringArray } from "./json";

/**
 * Tasks — the unit of work.
 *
 * Every mutation that a human would want to see later also writes a TaskEvent,
 * so the card's timeline is the whole story: your edits and the agents' steps
 * in one feed (docs/BOARD.md).
 */

/** A move the board rules refused. Callers should surface `reason` verbatim. */
export class ColumnEntryRejected extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ColumnEntryRejected";
  }
}

type TaskRow = {
  id: string;
  boardId: string;
  columnId: string;
  title: string;
  body: string | null;
  order: number;
  priority: string;
  labels: Prisma.JsonValue;
  estimate: number | null;
  repo: string | null;
  issueNumber: number | null;
  prNumber: number | null;
  prUrl: string | null;
  blockedBy: Prisma.JsonValue;
  dueAt: Date | null;
  recurrence: string | null;
  templateId: string | null;
  parentTaskId: string | null;
  archivedAt: Date | null;
};

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    boardId: row.boardId,
    columnId: row.columnId,
    title: row.title,
    body: row.body,
    order: row.order,
    priority: row.priority as TaskPriority,
    labels: toStringArray(row.labels),
    estimate: row.estimate,
    repo: row.repo,
    issueNumber: row.issueNumber,
    prNumber: row.prNumber,
    prUrl: row.prUrl,
    blockedBy: toStringArray(row.blockedBy),
    dueAt: row.dueAt,
    recurrence: row.recurrence,
    templateId: row.templateId,
    parentTaskId: row.parentTaskId,
    archivedAt: row.archivedAt,
  };
}

export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskInputSchema>;

export async function createTask(input: CreateTaskInput): Promise<Task> {
  const data = createTaskInputSchema.parse(input);

  // New cards go to the TOP of the column. The quick-add box sits at the top,
  // so this is where the eye already is — you always see what you just typed,
  // even in a column with hundreds of cards.
  const first = await prisma.task.findFirst({
    where: { columnId: data.columnId, archivedAt: null },
    orderBy: { order: "asc" },
    select: { order: true },
  });

  const created = await prisma.task.create({
    data: {
      boardId: data.boardId,
      columnId: data.columnId,
      title: data.title,
      body: data.body ?? null,
      order: orderBetween(undefined, first?.order),
      priority: data.priority ?? "normal",
      labels: data.labels ?? [],
      estimate: data.estimate ?? null,
      repo: data.repo ?? null,
      issueNumber: data.issueNumber ?? null,
      blockedBy: data.blockedBy ?? [],
      dueAt: data.dueAt ?? null,
      recurrence: data.recurrence ?? null,
      templateId: data.templateId ?? null,
      parentTaskId: data.parentTaskId ?? null,
    },
  });

  await appendTaskEvent(created.id, {
    actor: "user",
    kind: "created",
    message: `Created "${created.title}".`,
  });

  return toTask(created);
}

export async function getTask(id: string): Promise<Task | null> {
  const row = await prisma.task.findUnique({ where: { id } });
  return row ? toTask(row) : null;
}

export async function listTasks(
  boardId: string,
  options: { includeArchived?: boolean } = {},
): Promise<Task[]> {
  const rows = await prisma.task.findMany({
    where: { boardId, ...(options.includeArchived ? {} : { archivedAt: null }) },
    orderBy: [{ columnId: "asc" }, { order: "asc" }],
  });
  return rows.map(toTask);
}

export async function updateTask(
  id: string,
  patch: UpdateTaskInput,
  actor: TaskEventActor = "user",
): Promise<Task> {
  const parsed = updateTaskInputSchema.parse(patch);

  /**
   * Only touch the fields the caller actually sent.
   *
   * The parsed object is NOT a safe guide to that: a partial schema still fills
   * in defaults for absent keys (`labels: []`, `blockedBy: []`), so writing
   * every parsed key would quietly wipe a card's labels on an unrelated edit.
   */
  const provided = new Set(Object.keys((patch ?? {}) as Record<string, unknown>));
  const data = Object.fromEntries(
    Object.entries(parsed).filter(([key]) => provided.has(key)),
  ) as typeof parsed;

  const updated = await prisma.task.update({
    where: { id },
    data: {
      ...(data.title !== undefined ? { title: data.title } : {}),
      ...(data.body !== undefined ? { body: data.body } : {}),
      ...(data.priority !== undefined ? { priority: data.priority } : {}),
      ...(data.labels !== undefined ? { labels: data.labels } : {}),
      ...(data.estimate !== undefined ? { estimate: data.estimate } : {}),
      ...(data.repo !== undefined ? { repo: data.repo } : {}),
      ...(data.issueNumber !== undefined ? { issueNumber: data.issueNumber } : {}),
      ...(data.prNumber !== undefined ? { prNumber: data.prNumber } : {}),
      ...(data.prUrl !== undefined ? { prUrl: data.prUrl } : {}),
      ...(data.blockedBy !== undefined ? { blockedBy: data.blockedBy } : {}),
      ...(data.dueAt !== undefined ? { dueAt: data.dueAt } : {}),
      ...(data.recurrence !== undefined ? { recurrence: data.recurrence } : {}),
    },
  });

  const fields = Object.keys(data);
  if (fields.length > 0) {
    await appendTaskEvent(updated.id, {
      actor,
      kind: "updated",
      message: `Updated ${fields.join(", ")}.`,
      meta: { fields },
    });
  }

  return toTask(updated);
}

/** Which of this card's blockers are not finished yet. */
export async function unresolvedBlockersOf(task: Pick<Task, "blockedBy">): Promise<string[]> {
  if (task.blockedBy.length === 0) return [];

  const blockers = await prisma.task.findMany({
    where: { id: { in: task.blockedBy } },
    select: { id: true, archivedAt: true, column: { select: { kind: true } } },
  });

  const done = new Set(
    blockers.filter((b) => b.column.kind === "done" || b.archivedAt !== null).map((b) => b.id),
  );

  // A blocker that no longer exists cannot hold anything up.
  const known = new Set(blockers.map((b) => b.id));
  return task.blockedBy.filter((id) => known.has(id) && !done.has(id));
}

export interface MoveTaskInput {
  columnId: string;
  /** The card this one now sits after, if any. */
  afterTaskId?: string | null;
  /** The card this one now sits before, if any. */
  beforeTaskId?: string | null;
  actor?: TaskEventActor;
}

export interface MoveTaskResult {
  task: Task;
  /** Set when the move went through but pushed the column past its WIP limit. */
  warning?: string;
  /** Where the card came from. Differs from `task.columnId` only on a real move. */
  fromColumnId: string;
}

/**
 * Move a card, writing exactly one row.
 *
 * Rejects the move when board rules say no (blocked card entering a `working`
 * column). On the float-precision floor it renormalizes that column once and
 * retries, so a user never sees an ordering failure.
 */
export async function moveTask(taskId: string, input: MoveTaskInput): Promise<MoveTaskResult> {
  const task = await getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  const column = await prisma.boardColumn.findUnique({ where: { id: input.columnId } });
  if (!column) throw new Error(`Column ${input.columnId} not found`);

  const [unresolvedBlockers, currentCount] = await Promise.all([
    unresolvedBlockersOf(task),
    prisma.task.count({
      where: { columnId: input.columnId, archivedAt: null, id: { not: taskId } },
    }),
  ]);

  const verdict = checkColumnEntry({
    column: { kind: column.kind as ColumnKind, wipLimit: column.wipLimit, name: column.name },
    unresolvedBlockers,
    currentCount,
  });
  if (!verdict.allowed) throw new ColumnEntryRejected(verdict.reason ?? "Move not allowed.");

  const order = await orderForPosition(input, taskId);

  const updated = await prisma.task.update({
    where: { id: taskId },
    data: { columnId: input.columnId, order },
  });

  if (task.columnId !== input.columnId) {
    const from = await prisma.boardColumn.findUnique({
      where: { id: task.columnId },
      select: { name: true },
    });
    await appendTaskEvent(taskId, {
      actor: input.actor ?? "user",
      kind: "moved",
      message: `Moved from ${from?.name ?? "a column"} to ${column.name}.`,
      meta: { fromColumnId: task.columnId, toColumnId: input.columnId },
    });
  }

  return {
    task: toTask(updated),
    fromColumnId: task.columnId,
    ...(verdict.warning ? { warning: verdict.warning } : {}),
  };
}

/**
 * Resolve the drop position to an order value, renormalizing if floats run out.
 *
 * The UI may name one neighbour or both. When it names only one, the other side
 * is read from the column — otherwise "drop just above the last card" would
 * compute a gap against nothing and collide with an existing card.
 */
async function orderForPosition(input: MoveTaskInput, movingTaskId: string): Promise<number> {
  const excludeMoving = { columnId: input.columnId, archivedAt: null, id: { not: movingTaskId } };

  const neighbours = async (): Promise<{ prev?: number; next?: number }> => {
    const [after, before] = await Promise.all([
      input.afterTaskId
        ? prisma.task.findUnique({ where: { id: input.afterTaskId }, select: { order: true } })
        : null,
      input.beforeTaskId
        ? prisma.task.findUnique({ where: { id: input.beforeTaskId }, select: { order: true } })
        : null,
    ]);

    let prev = after?.order;
    let next = before?.order;

    // Fill in whichever side the caller left out, from the column itself.
    if (prev !== undefined && next === undefined) {
      const following = await prisma.task.findFirst({
        where: { ...excludeMoving, order: { gt: prev } },
        orderBy: { order: "asc" },
        select: { order: true },
      });
      next = following?.order;
    } else if (next !== undefined && prev === undefined) {
      const preceding = await prisma.task.findFirst({
        where: { ...excludeMoving, order: { lt: next } },
        orderBy: { order: "desc" },
        select: { order: true },
      });
      prev = preceding?.order;
    } else if (prev === undefined && next === undefined) {
      // No neighbours named at all: append to the end of the column.
      const last = await prisma.task.findFirst({
        where: excludeMoving,
        orderBy: { order: "desc" },
        select: { order: true },
      });
      prev = last?.order;
    }

    return { prev, next };
  };

  const { prev, next } = await neighbours();

  try {
    return orderBetween(prev, next);
  } catch (error) {
    if (!(error instanceof OrderPrecisionError)) throw error;
    // The gap ran out of floats. Respace the column once, then re-read and retry.
    await renormalizeColumn(input.columnId, movingTaskId);
    const retry = await neighbours();
    return orderBetween(retry.prev, retry.next);
  }
}

/** Rewrite a column's order values with even spacing. The precision escape hatch. */
export async function renormalizeColumn(columnId: string, excludeTaskId?: string): Promise<void> {
  const tasks = await prisma.task.findMany({
    where: {
      columnId,
      archivedAt: null,
      ...(excludeTaskId ? { id: { not: excludeTaskId } } : {}),
    },
    orderBy: { order: "asc" },
    select: { id: true },
  });

  const orders = renormalizeOrders(tasks.length);
  await prisma.$transaction(
    tasks.map((task, index) =>
      prisma.task.update({ where: { id: task.id }, data: { order: orders[index]! } }),
    ),
  );
}

export async function archiveTask(id: string): Promise<Task> {
  const row = await prisma.task.update({ where: { id }, data: { archivedAt: new Date() } });
  return toTask(row);
}

// ─────────────────────────────── task events ────────────────────────────────

export interface AppendTaskEventInput {
  actor: TaskEventActor;
  kind: TaskEventKind;
  message: string;
  meta?: Record<string, unknown>;
}

export async function appendTaskEvent(
  taskId: string,
  input: AppendTaskEventInput,
): Promise<TaskEvent> {
  const row = await prisma.taskEvent.create({
    data: {
      taskId,
      actor: input.actor,
      kind: input.kind,
      message: input.message,
      meta: input.meta === undefined ? undefined : (input.meta as Prisma.InputJsonValue),
    },
  });

  return {
    id: row.id,
    taskId: row.taskId,
    actor: row.actor as TaskEventActor,
    kind: row.kind as TaskEventKind,
    message: row.message,
    meta: toRecord(row.meta),
    createdAt: row.createdAt,
  };
}

export async function listTaskEvents(taskId: string): Promise<TaskEvent[]> {
  const rows = await prisma.taskEvent.findMany({
    where: { taskId },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) => ({
    id: row.id,
    taskId: row.taskId,
    actor: row.actor as TaskEventActor,
    kind: row.kind as TaskEventKind,
    message: row.message,
    meta: toRecord(row.meta),
    createdAt: row.createdAt,
  }));
}
