/**
 * The cost guard.
 *
 * A runaway agent loop is the one failure mode that costs real money while
 * looking like progress: every step "succeeds", and the bill is the only thing
 * that notices. So a pipeline may carry a token cap, and the runner stops the
 * moment it is passed.
 *
 * Pure, so the arithmetic and the message can be tested without spending
 * anything to find out.
 */

export interface CostVerdict {
  /** True when the run has spent more than it was allowed. */
  exceeded: boolean;
  used: number;
  cap: number | null;
  /** Safe to show the user verbatim. Empty when nothing is wrong. */
  reason: string;
}

/**
 * Has this run spent too much?
 *
 * A missing or non-positive cap means "no limit" — the absence of a number is
 * not a reason to refuse to work.
 */
export function checkCost(used: number, cap: number | null | undefined): CostVerdict {
  const limit = typeof cap === "number" && cap > 0 ? cap : null;
  const spent = Number.isFinite(used) && used > 0 ? Math.floor(used) : 0;

  if (limit === null || spent <= limit) {
    return { exceeded: false, used: spent, cap: limit, reason: "" };
  }

  return {
    exceeded: true,
    used: spent,
    cap: limit,
    reason: `This run has used ${spent.toLocaleString()} tokens, past its limit of ${limit.toLocaleString()}. Stopping before it spends more — raise the limit on the pipeline if this is genuinely a big job.`,
  };
}

/** The tokens a node output reports, if it reports any. */
export function tokensFrom(output: unknown): number {
  if (!output || typeof output !== "object") return 0;

  const usage = (output as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return 0;

  const tokens = (usage as { tokens?: unknown }).tokens;
  return typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0
    ? Math.floor(tokens)
    : 0;
}

/** How much of the budget is gone, 0–1. For a progress bar. */
export function costFraction(used: number, cap: number | null | undefined): number | null {
  const limit = typeof cap === "number" && cap > 0 ? cap : null;
  if (limit === null) return null;
  return Math.min(1, Math.max(0, used / limit));
}
