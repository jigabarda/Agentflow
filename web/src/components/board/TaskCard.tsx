"use client";

import type { Task } from "@agentflow/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ExternalLink, GitPullRequest, Lock } from "lucide-react";
import type { RunSummary } from "@/data/runSummaries";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ApprovalControls, RunBadge } from "./RunBadge";

/**
 * A card's face. Everything you need to triage at a glance without opening it:
 * what it is, how urgent, which repo, whether it is blocked, and how its run is
 * progressing.
 *
 * The priority stripe stays a coloured bar rather than a badge on purpose — it
 * is the one thing that has to be readable while scanning a column at speed,
 * and colour down the edge reads faster than a word.
 */

const PRIORITY_STRIPE: Record<string, string> = {
  low: "bg-muted-foreground/30",
  normal: "bg-sky-500",
  high: "bg-amber-500",
  urgent: "bg-red-500",
};

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
      data-priority={task.priority}
      data-selected={selected || undefined}
      className={cn(
        "group relative flex cursor-grab gap-2.5 rounded-lg border bg-card p-2.5",
        "shadow-xs transition-shadow hover:shadow-md",
        selected && "ring-2 ring-ring ring-offset-1 ring-offset-background",
        isDragging && "opacity-40 shadow-none",
      )}
      onClick={onSelect}
      onDoubleClick={onOpen}
      {...attributes}
      {...listeners}
    >
      <span
        aria-hidden
        data-testid={`card-priority-${task.id}`}
        className={cn(
          "w-1 shrink-0 rounded-full",
          PRIORITY_STRIPE[task.priority] ?? PRIORITY_STRIPE.normal,
        )}
      />

      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="text-sm leading-snug font-medium text-card-foreground">{task.title}</p>

        {(run || blocked || task.labels.length > 0 || task.repo || task.prUrl) && (
          <div className="flex flex-wrap items-center gap-1">
            {run && <RunBadge run={run} />}

            {blocked && (
              <Badge
                variant="outline"
                data-testid={`card-blocked-${task.id}`}
                title="Blocked by an unfinished card"
                className="gap-1 text-muted-foreground"
              >
                <Lock className="size-3" aria-hidden />
                blocked
              </Badge>
            )}

            {task.labels.map((label) => (
              <Badge key={label} variant="secondary" className="font-normal">
                {label}
              </Badge>
            ))}

            {task.repo && (
              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                {task.repo}
                {task.issueNumber ? ` #${task.issueNumber}` : ""}
              </span>
            )}

            {task.prUrl && (
              <a
                href={task.prUrl}
                target="_blank"
                rel="noreferrer"
                data-testid={`card-pr-${task.id}`}
                // The card is draggable; opening a link must not start a drag.
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
                className="no-underline"
              >
                <Badge
                  variant="outline"
                  className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300"
                >
                  <GitPullRequest className="size-3" aria-hidden />
                  PR {task.prNumber ? `#${task.prNumber}` : ""}
                  <ExternalLink className="size-2.5 opacity-60" aria-hidden />
                </Badge>
              </a>
            )}
          </div>
        )}

        {run?.awaitingApproval && (
          <ApprovalControls run={run} onDecide={(decision) => onDecide(run.runId, decision)} />
        )}
      </div>
    </li>
  );
}
