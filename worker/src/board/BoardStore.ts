import type { AutoAdvance, ColumnKind, TaskEventActor, TaskEventKind } from "@agentflow/core";
import type { PrismaClient } from "@prisma/client";

/**
 * Everything the board nodes and the reconciler need from storage.
 *
 * Separate from `RunStore` on purpose: the two halves of the product (work
 * tracking and execution) meet at Task ←→ Run and nowhere else, and keeping the
 * interfaces apart keeps that seam visible.
 */

export interface BoardTask {
  id: string;
  boardId: string;
  columnId: string;
  title: string;
  body: string | null;
  labels: string[];
  priority: string;
  repo: string | null;
  issueNumber: number | null;
  prNumber: number | null;
  prUrl: string | null;
}

export interface BoardColumnInfo {
  id: string;
  boardId: string;
  name: string;
  kind: ColumnKind;
  pipelineId: string | null;
  autoAdvance: AutoAdvance | null;
}

export interface TaskPatch {
  columnId?: string;
  title?: string;
  body?: string | null;
  priority?: string;
  /** Merged with what the card already has; never replaces the list. */
  addLabels?: string[];
  prNumber?: number | null;
  prUrl?: string | null;
  estimate?: number | null;
}

export interface NewTask {
  boardId: string;
  columnId: string;
  title: string;
  body?: string | null;
  labels?: string[];
  priority?: string;
  repo?: string | null;
  blockedBy?: string[];
  /** The card whose run created this one, so the origin stays traceable. */
  parentTaskId?: string | null;
}

export interface TaskEventInput {
  actor: TaskEventActor;
  kind: TaskEventKind;
  message: string;
  meta?: Record<string, unknown>;
}

export interface BoardStore {
  getTask(taskId: string): Promise<BoardTask | null>;
  getColumn(columnId: string): Promise<BoardColumnInfo | null>;
  /** The first column of a board with this kind — used to park a card at a gate. */
  findColumnByKind(boardId: string, kind: ColumnKind): Promise<BoardColumnInfo | null>;
  updateTask(taskId: string, patch: TaskPatch): Promise<BoardTask>;
  createTask(input: NewTask): Promise<BoardTask>;
  appendEvent(taskId: string, event: TaskEventInput): Promise<void>;
}

// ────────────────────────────── Prisma-backed ───────────────────────────────

const ORDER_STEP = 1000;

export class PrismaBoardStore implements BoardStore {
  constructor(private readonly prisma: PrismaClient) {}

  async getTask(taskId: string): Promise<BoardTask | null> {
    const row = await this.prisma.task.findUnique({ where: { id: taskId } });
    return row ? toBoardTask(row) : null;
  }

  async getColumn(columnId: string): Promise<BoardColumnInfo | null> {
    const row = await this.prisma.boardColumn.findUnique({ where: { id: columnId } });
    return row ? toColumn(row) : null;
  }

  async findColumnByKind(boardId: string, kind: ColumnKind): Promise<BoardColumnInfo | null> {
    const row = await this.prisma.boardColumn.findFirst({
      where: { boardId, kind },
      orderBy: { order: "asc" },
    });
    return row ? toColumn(row) : null;
  }

  async updateTask(taskId: string, patch: TaskPatch): Promise<BoardTask> {
    // Labels accumulate. An agent adding "needs-review" must not drop the
    // labels a human put on the card.
    let labels: string[] | undefined;
    if (patch.addLabels && patch.addLabels.length > 0) {
      const current = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: { labels: true },
      });
      const existing = Array.isArray(current?.labels) ? (current.labels as string[]) : [];
      labels = [...new Set([...existing, ...patch.addLabels])];
    }

    // A card entering a new column goes to the top of it, where the eye is.
    let order: number | undefined;
    if (patch.columnId) {
      const first = await this.prisma.task.findFirst({
        where: { columnId: patch.columnId, archivedAt: null },
        orderBy: { order: "asc" },
        select: { order: true },
      });
      order = first ? first.order - ORDER_STEP : ORDER_STEP;
    }

    const row = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        ...(patch.columnId !== undefined ? { columnId: patch.columnId } : {}),
        ...(order !== undefined ? { order } : {}),
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        ...(labels !== undefined ? { labels } : {}),
        ...(patch.prNumber !== undefined ? { prNumber: patch.prNumber } : {}),
        ...(patch.prUrl !== undefined ? { prUrl: patch.prUrl } : {}),
        ...(patch.estimate !== undefined ? { estimate: patch.estimate } : {}),
      },
    });

    return toBoardTask(row);
  }

  async createTask(input: NewTask): Promise<BoardTask> {
    const last = await this.prisma.task.findFirst({
      where: { columnId: input.columnId, archivedAt: null },
      orderBy: { order: "desc" },
      select: { order: true },
    });

    const row = await this.prisma.task.create({
      data: {
        boardId: input.boardId,
        columnId: input.columnId,
        title: input.title,
        body: input.body ?? null,
        order: (last?.order ?? 0) + ORDER_STEP,
        priority: input.priority ?? "normal",
        labels: input.labels ?? [],
        repo: input.repo ?? null,
        blockedBy: input.blockedBy ?? [],
        parentTaskId: input.parentTaskId ?? null,
      },
    });

    return toBoardTask(row);
  }

  async appendEvent(taskId: string, event: TaskEventInput): Promise<void> {
    await this.prisma.taskEvent.create({
      data: {
        taskId,
        actor: event.actor,
        kind: event.kind,
        message: event.message,
        ...(event.meta ? { meta: event.meta as never } : {}),
      },
    });
  }
}

function toBoardTask(row: {
  id: string;
  boardId: string;
  columnId: string;
  title: string;
  body: string | null;
  labels: unknown;
  priority: string;
  repo: string | null;
  issueNumber: number | null;
  prNumber: number | null;
  prUrl: string | null;
}): BoardTask {
  return {
    id: row.id,
    boardId: row.boardId,
    columnId: row.columnId,
    title: row.title,
    body: row.body,
    labels: Array.isArray(row.labels) ? (row.labels as string[]) : [],
    priority: row.priority,
    repo: row.repo,
    issueNumber: row.issueNumber,
    prNumber: row.prNumber,
    prUrl: row.prUrl,
  };
}

function toColumn(row: {
  id: string;
  boardId: string;
  name: string;
  kind: string;
  pipelineId: string | null;
  autoAdvance: unknown;
}): BoardColumnInfo {
  return {
    id: row.id,
    boardId: row.boardId,
    name: row.name,
    kind: row.kind as ColumnKind,
    pipelineId: row.pipelineId,
    autoAdvance:
      row.autoAdvance && typeof row.autoAdvance === "object"
        ? (row.autoAdvance as AutoAdvance)
        : null,
  };
}
