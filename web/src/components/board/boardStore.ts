"use client";

import { OrderPrecisionError, orderBetween } from "@agentflow/core";
import type { Board, BoardColumn, Task, TaskEvent } from "@agentflow/core";
import { create } from "zustand";
import { EMPTY_FILTERS, matchesFilters, type BoardFilters } from "./filters";

/**
 * Board state.
 *
 * Moves are optimistic: the card lands where you dropped it immediately, and
 * only rolls back if the server refuses (a blocked card entering a `working`
 * column). A spinner between drop and landing would make the board feel like a
 * form, which is exactly what it must not feel like (docs/BOARD.md).
 */

interface BoardState {
  board: Board | null;
  columns: BoardColumn[];
  tasks: Task[];
  filters: BoardFilters;

  selectedTaskId: string | null;
  drawerTaskId: string | null;
  events: TaskEvent[];

  /** Why the last move was refused — shown to the user, cleared on the next action. */
  rejection: string | null;
  /** A move that went through but pushed a column past its WIP limit. */
  warning: string | null;

  load: (board: Board, tasks: Task[]) => void;
  setFilters: (filters: BoardFilters) => void;

  visibleTasks: (columnId: string) => Task[];
  allTasksIn: (columnId: string) => Task[];

  createTask: (columnId: string, title: string) => Promise<Task | null>;
  moveTask: (taskId: string, toColumnId: string, targetIndex: number) => Promise<boolean>;
  updateTask: (taskId: string, patch: Record<string, unknown>) => Promise<void>;

  selectTask: (taskId: string | null) => void;
  openDrawer: (taskId: string | null) => Promise<void>;
  reloadEvents: (taskId: string) => Promise<void>;
  dismissMessages: () => void;
}

function byOrder(a: Task, b: Task): number {
  return a.order - b.order;
}

export const useBoardStore = create<BoardState>((set, get) => ({
  board: null,
  columns: [],
  tasks: [],
  filters: EMPTY_FILTERS,
  selectedTaskId: null,
  drawerTaskId: null,
  events: [],
  rejection: null,
  warning: null,

  load: (board, tasks) => set({ board, columns: board.columns, tasks }),

  setFilters: (filters) => set({ filters }),

  allTasksIn: (columnId) =>
    get()
      .tasks.filter((task) => task.columnId === columnId && !task.archivedAt)
      .sort(byOrder),

  visibleTasks: (columnId) =>
    get()
      .allTasksIn(columnId)
      .filter((task) => matchesFilters(task, get().filters)),

  createTask: async (columnId, title) => {
    const board = get().board;
    if (!board || title.trim() === "") return null;

    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ boardId: board.id, columnId, title: title.trim() }),
    });
    if (!response.ok) return null;

    const task = (await response.json()) as Task;
    set({ tasks: [...get().tasks, task] });
    return task;
  },

  moveTask: async (taskId, toColumnId, targetIndex) => {
    const snapshot = get().tasks;
    const task = snapshot.find((item) => item.id === taskId);
    if (!task) return false;

    // Neighbours at the drop position, ignoring the card being moved.
    const destination = get()
      .allTasksIn(toColumnId)
      .filter((item) => item.id !== taskId);
    const after = destination[targetIndex - 1];
    const before = destination[targetIndex];

    let optimisticOrder: number;
    try {
      optimisticOrder = orderBetween(after?.order, before?.order);
    } catch (error) {
      if (!(error instanceof OrderPrecisionError)) throw error;
      // The server renormalizes and returns the real value; this is only what
      // the card shows for the few milliseconds until it answers.
      optimisticOrder = after?.order ?? before?.order ?? 0;
    }

    set({
      rejection: null,
      warning: null,
      tasks: snapshot.map((item) =>
        item.id === taskId ? { ...item, columnId: toColumnId, order: optimisticOrder } : item,
      ),
    });

    try {
      const response = await fetch(`/api/tasks/${taskId}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          columnId: toColumnId,
          afterTaskId: after?.id ?? null,
          beforeTaskId: before?.id ?? null,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        // Put the board back exactly as it was, and say why.
        set({ tasks: snapshot, rejection: payload.error ?? "That move was not allowed." });
        return false;
      }

      const result = (await response.json()) as { task: Task; warning?: string };
      set({
        tasks: get().tasks.map((item) => (item.id === taskId ? result.task : item)),
        ...(result.warning ? { warning: result.warning } : {}),
      });
      return true;
    } catch {
      set({ tasks: snapshot, rejection: "Could not reach the server." });
      return false;
    }
  },

  updateTask: async (taskId, patch) => {
    const response = await fetch(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!response.ok) return;

    const updated = (await response.json()) as Task;
    set({ tasks: get().tasks.map((item) => (item.id === taskId ? updated : item)) });
    if (get().drawerTaskId === taskId) await get().reloadEvents(taskId);
  },

  selectTask: (taskId) => set({ selectedTaskId: taskId }),

  openDrawer: async (taskId) => {
    set({ drawerTaskId: taskId, events: [] });
    if (taskId) await get().reloadEvents(taskId);
  },

  reloadEvents: async (taskId) => {
    const response = await fetch(`/api/tasks/${taskId}/events`);
    if (!response.ok) return;
    set({ events: (await response.json()) as TaskEvent[] });
  },

  dismissMessages: () => set({ rejection: null, warning: null }),
}));
