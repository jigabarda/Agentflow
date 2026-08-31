"use client";

import type { Task } from "@agentflow/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { RunSummary } from "@/data/runSummaries";
import { ApprovalControls, RunBadge } from "./RunBadge";

const PRIORITY_STRIPE: Record<string, string> = {
  low: "bg-neutral-300",
  normal: "bg-sky-400",
  high: "bg-amber-500",
  urgent: "bg-red-500",
};

/**
 * A card's face. Everything you need to triage at a glance without opening it:
 * what it is, how urgent, which repo, whether it is blocked, and — from Phase 7
 * — how its run is progressing.
 */
export function TaskCard({
  task,
  blocked,
  selected,
  run,
  onOpen,
  onSelect,
  onDecide,
}: {
  task: Task;
  blocked: boolean;
  selected: boolean;
  /** This card's newest run, when it has one. */
  run?: RunSummary;
  onOpen: () => void;
  onSelect: () => void;
  onDecide: (runId: string, decision: "approve" | "reject") => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
  });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-testid={`card-${task.id}`}
      data-task-title={task.title}
      className={[
        "relative flex cursor-grab gap-2 rounded-md border bg-white p-2 shadow-sm",
        "dark:border-neutral-800 dark:bg-neutral-900",
        selected ? "ring-2 ring-sky-500" : "border-neutral-200",
        isDragging ? "opacity-40" : "",
      ].join(" ")}
      onClick={onSelect}
      onDoubleClick={onOpen}
      {...attributes}
      {...listeners}
    >
      <span
        aria-hidden
        className={`w-1 shrink-0 rounded ${PRIORITY_STRIPE[task.priority] ?? PRIORITY_STRIPE.normal}`}
      />

      <div className="min-w-0 flex-1">
        <p className="text-sm text-neutral-900 dark:text-neutral-100">{task.title}</p>

        <div className="mt-1 flex flex-wrap items-center gap-1">
          {run && <RunBadge run={run} />}

          {blocked && (
            <span
              data-testid={`card-blocked-${task.id}`}
              title="Blocked by an unfinished card"
              className="rounded bg-neutral-200 px-1 text-[10px] text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
            >
              🔒 blocked
            </span>
          )}

          {task.labels.map((label) => (
            <span
              key={label}
              className="rounded bg-neutral-100 px-1 text-[10px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400"
            >
              {label}
            </span>
          ))}

          {task.repo && (
            <span className="text-[10px] text-neutral-500">
              {task.repo}
              {task.issueNumber ? ` #${task.issueNumber}` : ""}
            </span>
          )}

          {task.prUrl && (
            <span
              data-testid={`card-pr-${task.id}`}
              className="rounded bg-emerald-100 px-1 text-[10px] text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
            >
              🔗 PR {task.prNumber ? `#${task.prNumber}` : ""}
            </span>
          )}
        </div>

        {run?.awaitingApproval && (
          <ApprovalControls run={run} onDecide={(decision) => onDecide(run.runId, decision)} />
        )}
      </div>
    </li>
  );
}
