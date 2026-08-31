import type { RunStore } from "../store";

/**
 * Recovery — what happens to runs that were interrupted.
 *
 * Two situations, one answer. A worker killed mid-run leaves a `running` row
 * with nothing behind it; a run that failed at step five should not have to
 * redo steps one to four. Both are solved by the resume the approval gate
 * already needed: put the run back in the queue, and the runner rebuilds its
 * context from the steps that already succeeded.
 *
 * The honest caveat is at-least-once for the *interrupted* step. A run killed
 * during an agent call has no record that the call finished, so the resumed run
 * makes it again. Everything before it is reused, so the cost is one step, not
 * the whole run — but it is not zero, and a node with an outward effect can
 * therefore happen twice. That is why anything destructive belongs behind an
 * approval gate (docs/SECURITY.md).
 */

export interface RecoveryReport {
  runIds: string[];
}

export async function recoverInterruptedRuns(
  store: RunStore,
  log: (message: string) => void = () => {},
): Promise<RecoveryReport> {
  const runIds = await store.requeueInterruptedRuns();

  if (runIds.length > 0) {
    log(
      `Recovered ${runIds.length} run${runIds.length === 1 ? "" : "s"} that were interrupted: ${runIds.join(", ")}. Each resumes from its last completed step.`,
    );
  }

  return { runIds };
}
