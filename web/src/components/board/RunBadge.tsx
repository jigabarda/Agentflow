"use client";

import { AlertCircle, Check, CircleDashed, Cog, Minus, PauseCircle } from "lucide-react";
import type { ComponentType } from "react";
import type { RunSummary } from "@/data/runSummaries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The live run badge on a card face.
 *
 * A failure belongs HERE, naming the step that broke — never buried in a log
 * page you have to go looking for (docs/BOARD.md, rule 2).
 */

const TONE: Record<string, string> = {
  queued: "border-transparent bg-muted text-muted-foreground",
  running: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  awaiting_approval: "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  succeeded: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  failed: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  canceled: "border-transparent bg-muted text-muted-foreground",
};

const ICON: Record<string, ComponentType<{ className?: string }>> = {
  queued: CircleDashed,
  running: Cog,
  awaiting_approval: PauseCircle,
  succeeded: Check,
  failed: AlertCircle,
  canceled: Minus,
};

function label(run: RunSummary): string {
  switch (run.status) {
    case "queued":
      return "queued";
    case "running":
      return run.currentNodeId
        ? `${run.currentNodeId} · ${run.done}/${run.total}`
        : `${run.done}/${run.total}`;
    case "awaiting_approval":
      return "needs you";
    case "succeeded":
      return "done";
    case "failed":
      // The step is the useful part: "failed at open-pr" tells you where to look.
      return run.currentNodeId ? `failed at ${run.currentNodeId}` : "failed";
    default:
      return run.status;
  }
}

export function RunBadge({ run }: { run: RunSummary }) {
  const Icon = ICON[run.status] ?? CircleDashed;

  return (
    <Badge
      data-testid={`run-badge-${run.taskId}`}
      data-run-status={run.status}
      title={run.error ?? undefined}
      className={cn("gap-1 font-normal", TONE[run.status] ?? TONE.queued)}
    >
      <Icon className={cn("size-3", run.status === "running" && "animate-spin")} aria-hidden />
      {label(run)}
    </Badge>
  );
}

/**
 * Approve / Reject, on the card face.
 *
 * The whole point of a gate is that deciding is one click from where you already
 * are. Making the user open a drawer to unblock a run would defeat it.
 */
export function ApprovalControls({
  run,
  onDecide,
}: {
  run: RunSummary;
  onDecide: (decision: "approve" | "reject") => void;
}) {
  return (
    <div className="flex gap-1.5 pt-0.5" data-testid={`approval-${run.taskId}`}>
      <Button
        size="sm"
        data-testid={`approve-${run.taskId}`}
        // The card is draggable; a click here must not start a drag.
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onDecide("approve");
        }}
        className="h-6 bg-emerald-600 px-2 text-[11px] text-white hover:bg-emerald-700"
      >
        Approve
      </Button>
      <Button
        size="sm"
        variant="outline"
        data-testid={`reject-${run.taskId}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onDecide("reject");
        }}
        className="h-6 px-2 text-[11px]"
      >
        Reject
      </Button>
    </div>
  );
}
