import type { ColumnKind } from "@agentflow/core";
import type {
  BoardColumnInfo,
  BoardStore,
  BoardTask,
  NewTask,
  TaskEventInput,
  TaskPatch,
} from "./BoardStore";

/**
 * An in-memory `BoardStore` for tests.
 *
 * Keeps the cards and their timeline in plain objects, so a test can assert on
 * where a card ended up and what its feed says without a database.
 */

export interface RecordedEvent extends TaskEventInput {
  taskId: string;
}

export class MemoryBoardStore implements BoardStore {
  readonly tasks = new Map<string, BoardTask>();
  readonly columns = new Map<string, BoardColumnInfo>();
  readonly events: RecordedEvent[] = [];

  private created = 0;

  addColumn(column: Partial<BoardColumnInfo> & { id: string }): BoardColumnInfo {
    const full: BoardColumnInfo = {
      boardId: "board_1",
      name: column.id,
      kind: "ready" as ColumnKind,
      pipelineId: null,
      autoAdvance: null,
      ...column,
    };
    this.columns.set(full.id, full);
    return full;
  }

  addTask(task: Partial<BoardTask> & { id: string; columnId: string }): BoardTask {
    const full: BoardTask = {
      boardId: "board_1",
      title: `Card ${task.id}`,
      body: null,
      labels: [],
      priority: "normal",
      repo: null,
      issueNumber: null,
      prNumber: null,
      prUrl: null,
      ...task,
    };
    this.tasks.set(full.id, full);
    return full;
  }

  /** Every timeline entry written for one card, in order. */
  eventsFor(taskId: string): RecordedEvent[] {
    return this.events.filter((event) => event.taskId === taskId);
  }

  async getTask(taskId: string): Promise<BoardTask | null> {
    return this.tasks.get(taskId) ?? null;
  }

  async getColumn(columnId: string): Promise<BoardColumnInfo | null> {
    return this.columns.get(columnId) ?? null;
  }

  async findColumnByKind(boardId: string, kind: ColumnKind): Promise<BoardColumnInfo | null> {
    for (const column of this.columns.values()) {
      if (column.boardId === boardId && column.kind === kind) return column;
    }
    return null;
  }

  async updateTask(taskId: string, patch: TaskPatch): Promise<BoardTask> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`No such task ${taskId}`);

    const updated: BoardTask = {
      ...task,
      ...(patch.columnId !== undefined ? { columnId: patch.columnId } : {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.prNumber !== undefined ? { prNumber: patch.prNumber } : {}),
      ...(patch.prUrl !== undefined ? { prUrl: patch.prUrl } : {}),
      // Labels accumulate, exactly as the Prisma store does.
      ...(patch.addLabels?.length
        ? { labels: [...new Set([...task.labels, ...patch.addLabels])] }
        : {}),
    };

    this.tasks.set(taskId, updated);
    return updated;
  }

  async createTask(input: NewTask): Promise<BoardTask> {
    const id = `task_new_${++this.created}`;
    return this.addTask({
      id,
      boardId: input.boardId,
      columnId: input.columnId,
      title: input.title,
      body: input.body ?? null,
      labels: input.labels ?? [],
      priority: input.priority ?? "normal",
      repo: input.repo ?? null,
    });
  }

  async appendEvent(taskId: string, event: TaskEventInput): Promise<void> {
    this.events.push({ taskId, ...event });
  }
}
