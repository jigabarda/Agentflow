import type { AutoAdvance, Board, BoardColumn, ColumnKind } from "@agentflow/core";
import { Prisma } from "@prisma/client";
import { prisma } from "./client";
import { toRecord } from "./json";

/**
 * Boards and columns.
 *
 * Automation lives on the COLUMN (`pipelineId` + `autoAdvance`), not on a
 * button — see docs/BOARD.md. These functions only read and write rows; the
 * worker is what acts on them.
 */

/** The board every new install starts with. */
export const DEFAULT_COLUMNS: readonly { name: string; kind: ColumnKind }[] = [
  { name: "Backlog", kind: "backlog" },
  { name: "Todo", kind: "ready" },
  { name: "In progress", kind: "working" },
  { name: "Review", kind: "waiting" },
  { name: "Done", kind: "done" },
];

type ColumnRow = {
  id: string;
  boardId: string;
  name: string;
  order: number;
  kind: string;
  wipLimit: number | null;
  pipelineId: string | null;
  autoAdvance: unknown;
};

function toColumn(row: ColumnRow): BoardColumn {
  return {
    id: row.id,
    boardId: row.boardId,
    name: row.name,
    order: row.order,
    kind: row.kind as ColumnKind,
    wipLimit: row.wipLimit,
    pipelineId: row.pipelineId,
    autoAdvance: toRecord(row.autoAdvance as never) as AutoAdvance | null,
  };
}

export async function createBoard(
  name: string,
  columns: readonly { name: string; kind: ColumnKind }[] = DEFAULT_COLUMNS,
): Promise<Board> {
  const board = await prisma.board.create({
    data: {
      name,
      columns: {
        create: columns.map((column, index) => ({
          name: column.name,
          kind: column.kind,
          order: (index + 1) * 100,
        })),
      },
    },
    include: { columns: { orderBy: { order: "asc" } } },
  });

  return { id: board.id, name: board.name, columns: board.columns.map(toColumn) };
}

export async function getBoard(id: string): Promise<Board | null> {
  const board = await prisma.board.findUnique({
    where: { id },
    include: { columns: { orderBy: { order: "asc" } } },
  });
  if (!board) return null;
  return { id: board.id, name: board.name, columns: board.columns.map(toColumn) };
}

export async function listBoards(): Promise<{ id: string; name: string }[]> {
  return prisma.board.findMany({
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });
}

export async function getColumn(id: string): Promise<BoardColumn | null> {
  const column = await prisma.boardColumn.findUnique({ where: { id } });
  return column ? toColumn(column) : null;
}

export interface ColumnPatch {
  name?: string;
  order?: number;
  kind?: ColumnKind;
  wipLimit?: number | null;
  /** Bind (or unbind) the pipeline that runs when a card enters this column. */
  pipelineId?: string | null;
  autoAdvance?: AutoAdvance | null;
}

export async function updateColumn(id: string, patch: ColumnPatch): Promise<BoardColumn> {
  const data: Prisma.BoardColumnUncheckedUpdateInput = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.order !== undefined ? { order: patch.order } : {}),
    ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
    ...(patch.wipLimit !== undefined ? { wipLimit: patch.wipLimit } : {}),
    ...(patch.pipelineId !== undefined ? { pipelineId: patch.pipelineId } : {}),
    ...(patch.autoAdvance !== undefined
      ? {
          autoAdvance:
            patch.autoAdvance === null
              ? Prisma.DbNull
              : ({ ...patch.autoAdvance } as Prisma.InputJsonValue),
        }
      : {}),
  };

  const column = await prisma.boardColumn.update({ where: { id }, data });
  return toColumn(column);
}

/** How many live (non-archived) cards a column holds — for WIP-limit checks. */
export async function countTasksInColumn(columnId: string): Promise<number> {
  return prisma.task.count({ where: { columnId, archivedAt: null } });
}
