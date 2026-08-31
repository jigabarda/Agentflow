"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import type { Board as BoardType, Task } from "@agentflow/core";
import {
  DndContext,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { Column } from "./Column";
import { TaskDrawer } from "./TaskDrawer";
import { useBoardStore } from "./boardStore";
import { useRunStream } from "./useRunStream";
import {
  EMPTY_FILTERS,
  filtersFromQuery,
  filtersToQuery,
  isFiltering,
  matchesFilters,
} from "./filters";
import type { BoardFilters } from "./filters";

/**
 * The board — the app's front door.
 *
 * Everything here is built to be fast to act on: drop a card and it lands
 * immediately, add a card with one keystroke, and never touch the mouse if you
 * do not want to (docs/BOARD.md).
 */
export function Board({ board, tasks }: { board: BoardType; tasks: Task[] }) {
  const load = useBoardStore((state) => state.load);
  const columns = useBoardStore((state) => state.columns);
  const allTasks = useBoardStore((state) => state.tasks);
  const filters = useBoardStore((state) => state.filters);
  const setFilters = useBoardStore((state) => state.setFilters);
  const selectedTaskId = useBoardStore((state) => state.selectedTaskId);
  const drawerTaskId = useBoardStore((state) => state.drawerTaskId);
  const rejection = useBoardStore((state) => state.rejection);
  const warning = useBoardStore((state) => state.warning);
  const createTask = useBoardStore((state) => state.createTask);
  const moveTask = useBoardStore((state) => state.moveTask);
  const selectTask = useBoardStore((state) => state.selectTask);
  const openDrawer = useBoardStore((state) => state.openDrawer);
  const dismissMessages = useBoardStore((state) => state.dismissMessages);
  const runs = useBoardStore((state) => state.runs);
  const setRuns = useBoardStore((state) => state.setRuns);
  const decide = useBoardStore((state) => state.decide);

  // Live run state, pushed. The card face reads it; nothing here polls.
  useRunStream(board.id, setRuns);

  const filterInputRef = useRef<HTMLInputElement>(null);
  // A ref, not state: "have we hydrated yet" must not itself cause a render.
  const hydrated = useRef(false);

  useEffect(() => {
    // Idempotent: React Strict Mode runs effects twice in development, and a
    // second read must not see a URL this component has already rewritten.
    if (hydrated.current) return;
    load(board, tasks);
    // A filtered board is a link you can send yourself.
    setFilters(filtersFromQuery(window.location.search.replace(/^\?/, "")));
    hydrated.current = true;
  }, [board, tasks, load, setFilters]);

  /**
   * Change the filters and record them in the URL, in one step.
   *
   * Deliberately NOT an effect on `filters`: such an effect would fire once on
   * mount with the pre-restore (empty) filters and strip the very query params
   * it was meant to preserve. Params the filters do not own (`?board=`) survive.
   */
  const applyFilters = useCallback(
    (next: BoardFilters) => {
      setFilters(next);
      const query = filtersToQuery(next, window.location.search.replace(/^\?/, ""));
      window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
    },
    [setFilters],
  );

  /** Cards held up by something unfinished — they cannot enter a working column. */
  const blockedTaskIds = useMemo(() => {
    const columnKind = new Map(columns.map((column) => [column.id, column.kind]));
    const done = new Set(
      allTasks
        .filter((task) => columnKind.get(task.columnId) === "done" || task.archivedAt)
        .map((task) => task.id),
    );
    const known = new Set(allTasks.map((task) => task.id));

    return new Set(
      allTasks
        .filter((task) => task.blockedBy.some((id) => known.has(id) && !done.has(id)))
        .map((task) => task.id),
    );
  }, [allTasks, columns]);

  const visibleByColumn = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const column of columns) {
      map.set(
        column.id,
        allTasks
          .filter((task) => task.columnId === column.id && !task.archivedAt)
          .filter((task) => matchesFilters(task, filters))
          .sort((a, b) => a.order - b.order),
      );
    }
    return map;
  }, [columns, allTasks, filters]);

  /** Selection walks the board in reading order: down a column, then the next. */
  const flatVisible = useMemo(
    () => columns.flatMap((column) => visibleByColumn.get(column.id) ?? []),
    [columns, visibleByColumn],
  );

  const moveSelection = useCallback(
    (delta: number) => {
      if (flatVisible.length === 0) return;
      const current = flatVisible.findIndex((task) => task.id === selectedTaskId);
      const next =
        current === -1 ? 0 : Math.min(flatVisible.length - 1, Math.max(0, current + delta));
      selectTask(flatVisible[next]!.id);
    },
    [flatVisible, selectedTaskId, selectTask],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);

      if (event.key === "Escape") {
        if (typing) (target as HTMLElement).blur();
        else void openDrawer(null);
        return;
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === "/") {
        event.preventDefault();
        filterInputRef.current?.focus();
        return;
      }
      if (event.key === "n") {
        event.preventDefault();
        const first = columns[0];
        if (first)
          document
            .querySelector<HTMLInputElement>(`[data-testid="quick-add-${first.id}"]`)
            ?.focus();
        return;
      }
      if (event.key === "j") {
        event.preventDefault();
        moveSelection(1);
        return;
      }
      if (event.key === "k") {
        event.preventDefault();
        moveSelection(-1);
        return;
      }
      if (event.key === "Enter" && selectedTaskId) {
        event.preventDefault();
        void openDrawer(selectedTaskId);
        return;
      }

      // 1–9 move the selected card to that column.
      if (/^[1-9]$/.test(event.key) && selectedTaskId) {
        const column = columns[Number(event.key) - 1];
        if (!column) return;
        event.preventDefault();
        const destination = visibleByColumn.get(column.id) ?? [];
        void moveTask(selectedTaskId, column.id, destination.length);
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [columns, moveSelection, moveTask, openDrawer, selectedTaskId, visibleByColumn]);

  const sensors = useSensors(
    // A few pixels of travel before a drag starts, so a click still selects.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;

    const taskId = String(active.id);
    const overId = String(over.id);

    // Dropped on a column, or on a card inside one.
    const targetColumn =
      columns.find((column) => column.id === overId) ??
      columns.find((column) =>
        (visibleByColumn.get(column.id) ?? []).some((task) => task.id === overId),
      );
    if (!targetColumn) return;

    const destination = (visibleByColumn.get(targetColumn.id) ?? []).filter(
      (task) => task.id !== taskId,
    );
    const overIndex = destination.findIndex((task) => task.id === overId);
    const index = overIndex === -1 ? destination.length : overIndex;

    void moveTask(taskId, targetColumn.id, index);
  }

  const drawerTask = allTasks.find((task) => task.id === drawerTaskId);

  return (
    <div className="flex h-screen flex-col bg-white dark:bg-neutral-900">
      <header className="flex items-center gap-3 border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
        <h1 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          {board.name}
        </h1>

        <input
          ref={filterInputRef}
          data-testid="board-filter"
          value={filters.text}
          onChange={(event) => applyFilters({ ...filters, text: event.target.value })}
          placeholder="Filter cards…  (press /)"
          className="w-64 rounded border border-neutral-300 px-2 py-1 text-sm focus:border-sky-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900"
        />

        {isFiltering(filters) && (
          <button
            type="button"
            data-testid="clear-filters"
            onClick={() => applyFilters(EMPTY_FILTERS)}
            className="text-xs text-neutral-500 underline"
          >
            clear
          </button>
        )}

        <Link href="/pipelines" className="ml-auto text-xs text-sky-600 underline">
          Pipelines
        </Link>
      </header>

      {(rejection || warning) && (
        <div
          data-testid={rejection ? "move-rejected" : "move-warning"}
          role="status"
          className={`flex items-center gap-2 px-4 py-1 text-xs ${
            rejection
              ? "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300"
              : "bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
          }`}
        >
          <span>{rejection ?? warning}</span>
          <button type="button" onClick={dismissMessages} className="underline">
            dismiss
          </button>
        </div>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={onDragEnd}>
        <main className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
          {columns.map((column) => (
            <Column
              key={column.id}
              column={column}
              tasks={visibleByColumn.get(column.id) ?? []}
              blockedTaskIds={blockedTaskIds}
              selectedTaskId={selectedTaskId}
              runs={runs}
              onQuickAdd={(title) => void createTask(column.id, title)}
              onOpenTask={(taskId) => void openDrawer(taskId)}
              onSelectTask={selectTask}
              onDecide={(runId, decision) => void decide(runId, decision)}
            />
          ))}
        </main>
      </DndContext>

      {drawerTask && <TaskDrawer key={drawerTask.id} task={drawerTask} />}
    </div>
  );
}
