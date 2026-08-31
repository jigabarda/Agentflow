import type { NodeHandler } from "./types";

/**
 * `manual-trigger` — starts a run from a payload you supply.
 * The trigger payload is already on the context; this simply publishes it as
 * this node's output so downstream nodes can read `{{ nodes.<id>.output.input }}`.
 */
export const manualTrigger: NodeHandler<Record<string, unknown>, { input: unknown }> = {
  type: "manual-trigger",
  async run(context) {
    return { input: context.trigger };
  },
};
