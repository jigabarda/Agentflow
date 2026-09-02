"use client";

import { useState } from "react";
import type { BoardColumn, Task } from "@agentflow/core";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { TriangleAlert, Zap } from "lucide-react";
import type { RunSummary } from "@/data/runSummaries";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { TaskCard } from "./TaskCard";

/**
 * One column of the board.
 *
 * The quick-add input sits at the TOP and stays focused after a commit, because
 * adding several cards in a row is the most common thing anyone does here and
 * friction there kills the whole system (docs/BOARD.md).
 */
export function Column({
  column,
  tasks,
  blockedTaskIds,
  selectedTaskId,
  runs,
  onQuickAdd,
  onOpenTask,
  onSelectTask,
  onDecide,
}: {
  column: BoardColumn;
  tasks: Task[];
  blockedTaskIds: Set<string>;
  selectedTaskId: string | null;
  runs: Record<string, RunSummary>;
  onQuickAdd: (title: string) => void;
  onOpenTask: (taskId: string) => void;
  onSelectTask: (taskId: string) => void;
  onDecide: (runId: string, decision: "approve" | "reject") => void;
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
      data-over-limit={overLimit || undefined}
      className="flex w-72 shrink-0 flex-col rounded-xl border bg-muted/40 p-2"
    >
      <header className="mb-2 flex items-center gap-2 px-1">
        <h2 className="text-sm font-semibold tracking-tight">{column.name}</h2>

        <Badge variant="secondary" className="h-5 min-w-5 justify-center px-1.5 font-normal">
          {tasks.length}
        </Badge>

        {overLimit && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge
                variant="outline"
                data-testid={`wip-warning-${column.id}`}
                className="gap-1 border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300"
              >
                <TriangleAlert className="size-3" aria-hidden />
                over limit
              </Badge>
            </TooltipTrigger>
            <TooltipContent>Over the WIP limit of {column.wipLimit}</TooltipContent>
          </Tooltip>
        )}

        {column.pipelineId && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                data-testid={`automated-${column.id}`}
                className="ml-auto inline-flex text-sky-600 dark:text-sky-400"
              >
                <Zap className="size-3.5" aria-hidden />
                <span className="sr-only">This column runs a pipeline</span>
              </span>
            </TooltipTrigger>
            <TooltipContent>Cards entering this column start a pipeline</TooltipContent>
          </Tooltip>
        )}
      </header>

      <Input
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
        className="mb-2 h-8 bg-background text-sm"
      />

      <ul
        ref={setNodeRef}
        data-testid={`dropzone-${column.id}`}
        data-over={isOver || undefined}
        className={cn(
          "flex min-h-24 flex-1 flex-col gap-2 rounded-lg p-1 transition-colors",
          // A dashed ring rather than a fill: the cards keep their own surface,
          // so the drop target reads without washing them out.
          isOver && "bg-accent/60 ring-2 ring-ring/40 ring-inset",
        )}
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
              {...(runs[task.id] ? { run: runs[task.id] } : {})}
              onOpen={() => onOpenTask(task.id)}
              onSelect={() => onSelectTask(task.id)}
              onDecide={onDecide}
            />
          ))}
        </SortableContext>
      </ul>
    </section>
  );
}
