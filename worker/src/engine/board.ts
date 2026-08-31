import { nextColumn } from "@agentflow/core";
import type { BoardStore } from "../board/BoardStore";

/**
 * The board reconciler — rule 2 and rule 3 of docs/BOARD.md.
 *
 * The runner executes; this is what makes the *card* reflect it. Every step
 * transition writes a TaskEvent, and a terminal outcome applies the column's
 * `autoAdvance` rule. Nothing here decides where a card goes on its own: the
 * destination comes from a rule the user set on the column, resolved by the
 * pure `nextColumn` in core.
 *
 * A run with no card (a canvas test-run) reconciles to nothing, which is why
 * every method starts by checking for one.
 */

export interface ReconcilerRun {
  id: string;
  taskId: string | null;
}

export interface StepReport {
  nodeId: string;
  label: string;
  /** 1-based, for "step 3 of 7". */
  index: number;
  total: number;
}

export interface RunReconciler {
  onRunStarted(run: ReconcilerRun, pipelineName: string, total: number): Promise<void>;
  onStepSucceeded(run: ReconcilerRun, step: StepReport): Promise<void>;
  onStepFailed(run: ReconcilerRun, step: StepReport, error: string): Promise<void>;
  onRunSucceeded(run: ReconcilerRun): Promise<void>;
  onRunFailed(run: ReconcilerRun, error: string, failedNodeId?: string): Promise<void>;
}

export function createBoardReconciler(board: BoardStore): RunReconciler {
  /** Move the card if the column it sits in has a rule for this outcome. */
  async function advance(
    run: ReconcilerRun,
    outcome: "run_succeeded" | "run_failed",
  ): Promise<void> {
    if (!run.taskId) return;

    const task = await board.getTask(run.taskId);
    if (!task) return;

    const column = await board.getColumn(task.columnId);
    if (!column) return;

    const destinationId = nextColumn(outcome, column);
    // No rule set for this outcome: the card stays exactly where it is.
    if (!destinationId || destinationId === task.columnId) return;

    const destination = await board.getColumn(destinationId);
    if (!destination) return;

    await board.updateTask(task.id, { columnId: destinationId });
    await board.appendEvent(task.id, {
      actor: "system",
      kind: "moved",
      message: `Moved to ${destination.name}.`,
      meta: {
        fromColumnId: column.id,
        toColumnId: destinationId,
        runId: run.id,
        rule: outcome,
      },
    });
  }

  return {
    async onRunStarted(run, pipelineName, total) {
      if (!run.taskId) return;
      await board.appendEvent(run.taskId, {
        actor: "system",
        kind: "run_started",
        message: `Started "${pipelineName}" — ${total} step${total === 1 ? "" : "s"}.`,
        meta: { runId: run.id, total },
      });
    },

    async onStepSucceeded(run, step) {
      if (!run.taskId) return;
      await board.appendEvent(run.taskId, {
        actor: `agent:${step.nodeId}`,
        kind: "run_step",
        message: `${step.label || step.nodeId} finished (${step.index}/${step.total}).`,
        meta: { runId: run.id, nodeId: step.nodeId, index: step.index, total: step.total },
      });
    },

    async onStepFailed(run, step, error) {
      if (!run.taskId) return;
      await board.appendEvent(run.taskId, {
        actor: `agent:${step.nodeId}`,
        kind: "run_step",
        message: `${step.label || step.nodeId} failed — ${error}`,
        meta: { runId: run.id, nodeId: step.nodeId, failed: true },
      });
    },

    async onRunSucceeded(run) {
      if (!run.taskId) return;
      await board.appendEvent(run.taskId, {
        actor: "system",
        kind: "run_succeeded",
        message: "Run succeeded.",
        meta: { runId: run.id },
      });
      await advance(run, "run_succeeded");
    },

    async onRunFailed(run, error, failedNodeId) {
      if (!run.taskId) return;
      await board.appendEvent(run.taskId, {
        actor: "system",
        kind: "run_failed",
        // The card face shows this verbatim, so it has to name the step.
        message: failedNodeId ? `Failed at ${failedNodeId} — ${error}` : `Failed — ${error}`,
        meta: { runId: run.id, ...(failedNodeId ? { nodeId: failedNodeId } : {}) },
      });
      await advance(run, "run_failed");
    },
  };
}
