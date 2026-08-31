import {
  Flow,
  FlowLoopExceeded,
  branchOf,
  interpolateConfig,
  topologicalOrder,
} from "@agentflow/core";
import type { RunContext, RunStatus } from "@agentflow/core";
import { NodeFailure, RunPaused, type NodeHandler } from "../handlers/index";
import type { LoadedPipeline, QueuedRun, RunStore } from "../store";
import type { RunReconciler } from "./board";

/**
 * The runner — walks a pipeline's DAG and executes it.
 *
 * Deliberately boring and deterministic: topological order, one node at a time,
 * every transition written down. The clock is injected so tests never depend on
 * wall time (CLAUDE.md guardrail 13).
 *
 * A run may be executed more than once. An approval gate parks it mid-way, and
 * approving puts it back in the queue; on the second pass the runner rebuilds
 * its context from the steps that already succeeded and carries on from the
 * gate, so no node — and no agent — runs twice.
 *
 * From Phase 8 the walk is driven by the pure `Flow` controller rather than a
 * flat topological order, so a `condition` can prune the branch it did not
 * choose and a reviewer can send the work back — bounded, and never silently.
 */

export interface RunnerDeps {
  store: RunStore;
  handlers: Map<string, NodeHandler>;
  /** Injected so a test can assert on exact timestamps. */
  now?: () => Date;
  /** Where this run's isolated workspace lives. */
  workspaceDir?: (runId: string) => string;
  /**
   * Delete the run's workspace. Called only when a run ENDS — a run parked at
   * an approval gate keeps its clone and the agent's edits, because it will
   * resume into exactly that directory.
   */
  cleanupWorkspace?: (runId: string) => void;
  /** Reflects run progress onto the board card. Omit for canvas-only runs. */
  reconciler?: RunReconciler;
}

export interface RunOutcome {
  status: Extract<RunStatus, "succeeded" | "failed" | "awaiting_approval">;
  /** Node outputs, in case a caller wants them without re-reading the database. */
  outputs: Record<string, unknown>;
  error?: string;
  /** Set when the run parked: the gate it is waiting on. */
  awaitingNodeId?: string;
}

/** A message worth showing the user, versus a bug we should not paper over. */
function describeError(error: unknown): string {
  if (error instanceof NodeFailure) return error.message;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export async function executeRun(deps: RunnerDeps, run: QueuedRun): Promise<RunOutcome> {
  const now = deps.now ?? (() => new Date());
  const workspaceDir = (deps.workspaceDir ?? ((id: string) => `.workspaces/${id}`))(run.id);
  const { store, reconciler } = deps;
  const card = { id: run.id, taskId: run.taskId };

  const pipeline = await store.loadPipeline(run.pipelineId);
  if (!pipeline) {
    return fail(deps, run, now, `Pipeline ${run.pipelineId} no longer exists.`, {});
  }

  let flow: Flow;
  let total: number;
  try {
    // Validates the shape up front: an unmarked cycle still fails here rather
    // than at run time.
    total = topologicalOrder({ ...pipeline, edges: pipeline.edges.filter((e) => !e.loop) }).length;
    flow = new Flow(pipeline);
  } catch (error) {
    // The editor refuses to save a cyclic graph, so this means the data was
    // changed some other way. Fail the run cleanly rather than loop forever.
    return fail(deps, run, now, describeError(error), {});
  }

  // Anything this run already finished, from a pass that ended at a gate.
  const completed = await store.loadCompletedSteps(run.id);
  const alreadyDone = new Map(completed.map((step) => [step.nodeId, step.output]));
  const resuming = alreadyDone.size > 0;

  const context: RunContext = {
    pipeline: { vars: pipeline.vars },
    trigger: run.trigger,
    ...(triggerTask(run.trigger) ? { task: triggerTask(run.trigger)! } : {}),
    nodes: Object.fromEntries(completed.map((step) => [step.nodeId, { output: step.output }])),
    runId: run.id,
    pipelineId: run.pipelineId,
    workspaceDir,
  };

  await store.appendLog(run.id, {
    level: "info",
    message: resuming
      ? `Resuming "${pipeline.name}" — ${alreadyDone.size} of ${total} step(s) already done.`
      : `Running "${pipeline.name}" — ${total} step${total === 1 ? "" : "s"}.`,
  });

  if (!resuming) {
    await reconciler?.onRunStarted(card, pipeline.name, total);
  }

  let position = 0;

  for (;;) {
    let node;
    try {
      node = flow.next();
    } catch (error) {
      // A loop that never settled. Fail with the cap named, never silently.
      if (error instanceof FlowLoopExceeded) {
        await store.appendLog(run.id, { level: "error", message: error.message });
        return fail(deps, run, now, error.message, outputsOf(context));
      }
      throw error;
    }
    if (!node) break;

    position += 1;
    const report = {
      nodeId: node.id,
      label: node.label,
      index: position,
      total,
    };

    // Already succeeded on an earlier pass: keep its output, do not re-run it.
    if (alreadyDone.has(node.id)) {
      flow.complete(node.id, branchOf(alreadyDone.get(node.id)));
      continue;
    }

    // Reuse the step row a pause left behind, so a gate does not accumulate a
    // new row every time the run comes back.
    const open = await store.findOpenStep(run.id, node.id);
    const step = open ?? (await store.createStep(run.id, node.id));
    const startedAt = now();
    await store.setStepStatus(step.id, { status: "running", startedAt });

    const handler = deps.handlers.get(node.type);
    if (!handler) {
      const message = `No handler for node type "${node.type}" (node "${node.id}").`;
      await store.setStepStatus(step.id, { status: "failed", error: message, endedAt: now() });
      await store.appendLog(run.id, { level: "error", message, nodeId: node.id });
      await reconciler?.onStepFailed(card, report, message);
      flow.fail(node.id);
      return fail(deps, run, now, message, outputsOf(context), node.id);
    }

    try {
      // Config is resolved against everything the run knows so far, so a
      // handler never has to think about templates.
      const config = interpolateConfig(node.config, context);
      const output = await handler.run(context, config, {
        id: node.id,
        type: node.type,
        label: node.label,
      });

      context.nodes[node.id] = { output };
      await store.setStepStatus(step.id, { status: "succeeded", output, endedAt: now() });
      await store.appendLog(run.id, {
        level: "info",
        message: `${node.label || node.id} finished.`,
        nodeId: node.id,
      });
      await reconciler?.onStepSucceeded(card, report);

      // The node may have chosen a branch; the flow prunes the rest.
      try {
        flow.complete(node.id, branchOf(output));
      } catch (error) {
        if (error instanceof FlowLoopExceeded) {
          await store.appendLog(run.id, { level: "error", message: error.message });
          return fail(deps, run, now, error.message, outputsOf(context), node.id);
        }
        throw error;
      }
    } catch (error) {
      // A gate is not a failure. Put the step back to pending, park the run,
      // and leave everything computed so far on disk for the resume.
      if (error instanceof RunPaused) {
        await store.setStepStatus(step.id, { status: "pending" });
        await store.setRunStatus(run.id, { status: "awaiting_approval", error: null });
        return {
          status: "awaiting_approval",
          outputs: outputsOf(context),
          awaitingNodeId: error.nodeId,
        };
      }

      const message = describeError(error);
      await store.setStepStatus(step.id, { status: "failed", error: message, endedAt: now() });
      await store.appendLog(run.id, {
        level: "error",
        message: `${node.label || node.id} failed — ${message}`,
        nodeId: node.id,
      });
      await reconciler?.onStepFailed(card, report, message);
      flow.fail(node.id);
      return fail(deps, run, now, `${node.id}: ${message}`, outputsOf(context), node.id);
    }
  }

  // A graph that stopped with work still pending has stalled — usually an edge
  // that can never fire. Reporting that as success would hide a broken pipeline.
  const stalled = flow.stalled();
  if (stalled.length > 0) {
    const message = `The pipeline stopped with ${stalled.join(", ")} still waiting on an input that never arrived.`;
    await store.appendLog(run.id, { level: "error", message });
    return fail(deps, run, now, message, outputsOf(context));
  }

  // A branch that was never taken is recorded as skipped, so the run detail
  // shows why a node has no output instead of leaving a gap.
  for (const skipped of flow.skipped()) {
    const step = await store.findOpenStep(run.id, skipped);
    if (step) await store.setStepStatus(step.id, { status: "skipped", endedAt: now() });
  }

  await store.setRunStatus(run.id, { status: "succeeded", endedAt: now(), error: null });
  await store.appendLog(run.id, { level: "info", message: "Run succeeded." });
  await reconciler?.onRunSucceeded(card);
  cleanup(deps, run.id);
  return { status: "succeeded", outputs: outputsOf(context) };
}

/**
 * The card, lifted out of the trigger payload onto `context.task`.
 *
 * A board-triggered run carries it as `trigger.task` (docs/BOARD.md); handlers
 * that act on "this run's card" read the shorter path.
 */
function triggerTask(trigger: unknown): RunContext["task"] | null {
  if (!trigger || typeof trigger !== "object") return null;
  const task = (trigger as { task?: unknown }).task;
  if (!task || typeof task !== "object") return null;

  const record = task as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.title !== "string") return null;

  return {
    id: record.id,
    title: record.title,
    body: typeof record.body === "string" ? record.body : null,
    repo: typeof record.repo === "string" ? record.repo : null,
    issueNumber: typeof record.issueNumber === "number" ? record.issueNumber : null,
  };
}

/** Workspace removal must never turn a finished run into a failed one. */
function cleanup(deps: RunnerDeps, runId: string): void {
  try {
    deps.cleanupWorkspace?.(runId);
  } catch {
    // A leftover temp directory is not worth failing a completed run over.
  }
}

function outputsOf(context: RunContext): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(context.nodes).map(([nodeId, entry]) => [nodeId, entry.output]),
  );
}

async function fail(
  deps: RunnerDeps,
  run: QueuedRun,
  now: () => Date,
  error: string,
  outputs: Record<string, unknown>,
  failedNodeId?: string,
): Promise<RunOutcome> {
  await deps.store.setRunStatus(run.id, { status: "failed", error, endedAt: now() });
  await deps.store.appendLog(run.id, { level: "error", message: `Run failed — ${error}` });
  await deps.reconciler?.onRunFailed({ id: run.id, taskId: run.taskId }, error, failedNodeId);
  cleanup(deps, run.id);
  return { status: "failed", outputs, error };
}

/** Load and execute whatever is next in the queue. Returns null when idle. */
export async function runNextQueued(deps: RunnerDeps): Promise<RunOutcome | null> {
  const run = await deps.store.claimNextQueuedRun();
  if (!run) return null;
  return executeRun(deps, run);
}

export type { LoadedPipeline, QueuedRun };
