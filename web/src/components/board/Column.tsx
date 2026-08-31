"use client";

import { useState } from "react";
import type { BoardColumn, Task } from "@agentflow/core";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { TaskCard } from "./TaskCard";

export function Column({
  column,
  tasks,
  blockedTaskIds,
  selectedTaskId,
  onQuickAdd,
  onOpenTask,
  onSelectTask,
}: {
  column: BoardColumn;
  tasks: Task[];
  blockedTaskIds: Set<string>;
  selectedTaskId: string | null;
  onQuickAdd: (title: string) => void;
  onOpenTask: (taskId: string) => void;
  onSelectTask: (taskId: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  const [draft, setDraft] = useState("");

  const overLimit = typeof column.wipLimit === "number" && tasks.length > column.wipLimit;

  function commit() {
    const title = draft.trim();
    if (!title) return;
    onQuickAdd(title);
    // Keep focus and clear — adding several cards in a row must be frictionless.
    setDraft("");
  }

  return (
    <section
      data-testid={`column-${column.id}`}
      data-column-kind={column.kind}
      className="flex w-72 shrink-0 flex-col rounded-lg bg-neutral-100 p-2 dark:bg-neutral-950"
    >
      <header className="mb-2 flex items-center gap-2 px-1">
        <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">
          {column.name}
        </h2>
        <span className="text-xs text-neutral-500">{tasks.length}</span>

        {overLimit && (
          <span
            data-testid={`wip-warning-${column.id}`}
            title={`Over the WIP limit of ${column.wipLimit}`}
            className="text-xs text-amber-600"
          >
            over limit
          </span>
        )}

        {column.pipelineId && (
          <span
            data-testid={`automated-${column.id}`}
            title="Cards entering this column start a pipeline"
            className="ml-auto text-xs text-sky-600"
          >
            ⚡
          </span>
        )}
      </header>

      <input
        data-testid={`quick-add-${column.id}`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
        placeholder="Add a card…"
        aria-label={`Add a card to ${column.name}`}
        className="mb-2 w-full rounded border border-neutral-200 bg-white px-2 py-1 text-sm placeholder:text-neutral-400 focus:border-sky-500 focus:outline-none dark:border-neutral-800 dark:bg-neutral-900"
      />

      <ul
        ref={setNodeRef}
        data-testid={`dropzone-${column.id}`}
        className={`flex min-h-24 flex-1 flex-col gap-2 rounded p-1 ${
          isOver ? "bg-sky-100 dark:bg-sky-950/40" : ""
        }`}
      >
        <SortableContext
          items={tasks.map((task) => task.id)}
          strategy={verticalListSortingStrategy}
        >
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              blocked={blockedTaskIds.has(task.id)}
              selected={selectedTaskId === task.id}
              onOpen={() => onOpenTask(task.id)}
              onSelect={() => onSelectTask(task.id)}
            />
          ))}
        </SortableContext>
      </ul>
    </section>
  );
}
