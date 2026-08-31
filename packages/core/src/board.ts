/**
 * Board rules — pure decision functions used by the worker's reconciler
 * (docs/BOARD.md) and by the web layer before it writes a move.
 *
 * No DB, no clock, no I/O: everything here is a function of its arguments.
 */
import type { AutoAdvance, ColumnKind, RunOutcome } from "./types";

/** Column kinds where a card is considered actively worked on. */
const WORKING_KINDS: readonly ColumnKind[] = ["working"];

/**
 * Where a card should go now that its run (or PR) reached a terminal state.
 * Returns `null` when the column has no rule for this outcome — the card stays put.
 *
 * Unknown outcomes never throw; they simply match no rule.
 */
export function nextColumn(
  outcome: RunOutcome | string,
  column: { autoAdvance?: AutoAdvance | null },
): string | null {
  const rules = column.autoAdvance;
  if (!rules) return null;

  switch (outcome) {
    case "run_succeeded":
      return rules.onRunSucceeded ?? null;
    case "run_failed":
      return rules.onRunFailed ?? null;
    case "pr_merged":
      return rules.onPrMerged ?? null;
    default:
      return null;
  }
}

export interface ColumnEntryVerdict {
  allowed: boolean;
  /** Set when `allowed` is false — safe to show to the user verbatim. */
  reason?: string;
  /** Set when the move is permitted but pushes the column past its WIP limit. */
  warning?: string;
}

/**
 * May this card enter this column?
 *
 * The one hard rule: a card with unresolved blockers cannot enter a `working`
 * column — the UI blocks the drop and the API rejects it. A WIP limit is a soft
 * cap: the move goes through, with a warning.
 */
export function checkColumnEntry(params: {
  column: { kind: ColumnKind; wipLimit?: number | null; name?: string };
  /** Ids of this card's blockers that are NOT done yet. */
  unresolvedBlockers?: readonly string[];
  /** How many cards the destination column already holds. */
  currentCount?: number;
}): ColumnEntryVerdict {
  const { column, unresolvedBlockers = [], currentCount = 0 } = params;

  if (WORKING_KINDS.includes(column.kind) && unresolvedBlockers.length > 0) {
    const count = unresolvedBlockers.length;
    return {
      allowed: false,
      reason: `Blocked by ${count} unfinished ${count === 1 ? "task" : "tasks"}.`,
    };
  }

  const limit = column.wipLimit;
  if (typeof limit === "number" && limit > 0 && currentCount + 1 > limit) {
    return {
      allowed: true,
      warning: `${column.name ?? "This column"} is over its WIP limit (${currentCount + 1}/${limit}).`,
    };
  }

  return { allowed: true };
}

/**
 * Does entering this column start a run?
 * Board automation is bound to columns, never to buttons — see docs/BOARD.md.
 */
export function pipelineForColumnEntry(column: { pipelineId?: string | null }): string | null {
  return column.pipelineId ?? null;
}
