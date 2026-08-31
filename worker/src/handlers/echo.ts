import type { NodeHandler } from "./types";

/**
 * `echo` — returns its own (already interpolated) config value.
 *
 * It exists to prove the engine end-to-end without agents or GitHub: if an
 * echo pipeline runs and its output carries a value threaded from an earlier
 * node, the runner, the context, and interpolation are all working.
 */
export const echo: NodeHandler<{ value?: unknown }, { value: unknown }> = {
  type: "echo",
  async run(_context, config) {
    return { value: config.value ?? "" };
  },
};
