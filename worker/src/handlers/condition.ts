import type { NodeHandler } from "./types";
import { NodeFailure } from "./types";

/**
 * `condition` — the node that chooses a path.
 *
 * It compares an interpolated value against the cases the user listed and
 * returns `{ branch }`; the runner then follows only the outgoing edge with
 * that handle and SKIPS the rest. This is what turns a straight line into a
 * crew: "reviewer said changes" goes back to the implementer, "approved" goes
 * on to the PR.
 *
 * Matching is deliberately forgiving, because the value usually comes from an
 * agent: case and surrounding whitespace are ignored, and a case matches if it
 * appears anywhere in the value. A reviewer that replies "Changes requested —
 * the test is missing" still routes to `changes`.
 */

export interface ConditionConfig {
  /** The value to route on, usually `{{ nodes.reviewer.output.result }}`. */
  expression?: string;
  /**
   * Handles to try, in order. A plain list is the common case; the first one
   * found in the value wins, so put the more specific case first.
   */
  cases?: string[];
  /** Followed when nothing matches. */
  default?: string;
}

export interface ConditionOutput {
  branch: string;
  /** True when a case actually matched, rather than falling through. */
  matched: boolean;
  /** What was compared, so the log and the timeline can show it. */
  value: string;
}

export const DEFAULT_BRANCH = "false";

export function evaluateCondition(config: ConditionConfig): ConditionOutput {
  const value = (config.expression ?? "").trim();
  const cases = (config.cases ?? []).map((item) => item.trim()).filter(Boolean);
  const fallback = config.default?.trim() || DEFAULT_BRANCH;

  const haystack = value.toLowerCase();

  for (const candidate of cases) {
    if (haystack.includes(candidate.toLowerCase())) {
      return { branch: candidate, matched: true, value };
    }
  }

  // With no cases listed at all, treat the value itself as the handle — that
  // covers an agent asked to answer with one word.
  if (cases.length === 0 && value) {
    return { branch: value, matched: true, value };
  }

  return { branch: fallback, matched: false, value };
}

export interface ConditionDeps {
  log: (
    runId: string,
    entry: { level: "debug" | "info" | "warn" | "error"; message: string; nodeId: string },
  ) => Promise<void>;
}

export function createConditionHandler(
  deps: ConditionDeps,
): NodeHandler<ConditionConfig, ConditionOutput> {
  return {
    type: "condition",
    async run(context, config, node) {
      if (config.expression === undefined) {
        throw new NodeFailure(`Node "${node.id}": there is no expression to route on.`);
      }

      const outcome = evaluateCondition(config);

      await deps.log(context.runId, {
        level: outcome.matched ? "info" : "warn",
        nodeId: node.id,
        message: outcome.matched
          ? `Routing to "${outcome.branch}".`
          : `Nothing matched, so taking the default branch "${outcome.branch}".`,
      });

      return outcome;
    },
  };
}
