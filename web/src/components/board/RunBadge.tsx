"use client";

import type { RunSummary } from "@/data/runSummaries";

/**
 * The live run badge on a card face.
 *
 * A failure belongs HERE, naming the step that broke — never buried in a log
 * page you have to go looking for (docs/BOARD.md, rule 2).
 */

const TONE: Record<string, string> = {
  queued: "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  running: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  awaiting_approval: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300",
  succeeded: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  canceled: "bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400",
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

const ICON: Record<string, string> = {
  queued: "•",
  running: "⚙",
  awaiting_approval: "⏸",
  succeeded: "✓",
  failed: "✗",
  canceled: "—",
};

export function RunBadge({ run }: { run: RunSummary }) {
  return (
    <span
      data-testid={`run-badge-${run.taskId}`}
      data-run-status={run.status}
      title={run.error ?? undefined}
      className={`rounded px-1 text-[10px] ${TONE[run.status] ?? TONE.queued}`}
    >
      {ICON[run.status] ?? "•"} {label(run)}
    </span>
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
    <div className="mt-1 flex gap-1" data-testid={`approval-${run.taskId}`}>
      <button
        type="button"
        data-testid={`approve-${run.taskId}`}
        // The card is draggable; a click here must not start a drag.
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onDecide("approve");
        }}
        className="rounded bg-emerald-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-700"
      >
        Approve
      </button>
      <button
        type="button"
        data-testid={`reject-${run.taskId}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onDecide("reject");
        }}
        className="rounded border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
      >
        Reject
      </button>
    </div>
  );
}
