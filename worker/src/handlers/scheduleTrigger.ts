import type { NodeHandler } from "./types";

/**
 * `schedule-trigger` — a run that starts on a clock, with no card at all.
 *
 * The scheduler has already decided this run should exist and which slot it is
 * for; the node's job is only to put that slot into the run context, so later
 * nodes can say "the digest for {{ nodes.trigger.output.scheduledFor }}".
 */

export interface ScheduleTriggerOutput {
  /** The slot this run was scheduled for, as an ISO string. */
  scheduledFor: string;
}

export const scheduleTrigger: NodeHandler<Record<string, unknown>, ScheduleTriggerOutput> = {
  type: "schedule-trigger",
  async run(context) {
    const trigger = (context.trigger ?? {}) as { scheduledFor?: unknown };
    const scheduledFor =
      typeof trigger.scheduledFor === "string" ? trigger.scheduledFor : new Date(0).toISOString();

    return { scheduledFor };
  },
};
