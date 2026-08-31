import { interpolateConfig, topologicalOrder } from "@agentflow/core";
import type { RunContext, RunStatus } from "@agentflow/core";
import { NodeFailure, type NodeHandler } from "../handlers/index";
import type { LoadedPipeline, QueuedRun, RunStore } from "../store";

/**
 * The runner — walks a pipeline's DAG and executes it.
 *
 * Deliberately boring and deterministic: topological order, one node at a time,
 * every transition written down. The clock is injected so tests never depend on
 * wall time (CLAUDE.md guardrail 13).
 */

export interface RunnerDeps {
  store: RunStore;
  handlers: Map<string, NodeHandler>;
  /** Injected so a test can assert on exact timestamps. */
  now?: () => Date;
  /** Where this run's isolated workspace lives. Phase 5 creates it for real. */
  workspaceDir?: (runId: string) => string;
}

export interface RunOutcome {
  status: Extract<RunStatus, "succeeded" | "failed">;
  /** Node outputs, in case a caller wants them without re-reading the database. */
  outputs: Record<string, unknown>;
  error?: string;
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
  const { store } = deps;

  const pipeline = await store.loadPipeline(run.pipelineId);
  if (!pipeline) {
    return fail(store, run.id, now, `Pipeline ${run.pipelineId} no longer exists.`, {});
  }

  let order;
  try {
    order = topologicalOrder(pipeline);
  } catch (error) {
    // The editor refuses to save a cyclic graph, so this means the data was
    // changed some other way. Fail the run cleanly rather than loop forever.
    return fail(store, run.id, now, describeError(error), {});
  }

  const context: RunContext = {
    pipeline: { vars: pipeline.vars },
    trigger: run.trigger,
    nodes: {},
    runId: run.id,
    pipelineId: run.pipelineId,
    workspaceDir,
  };

  await store.appendLog(run.id, {
    level: "info",
    message: `Running "${pipeline.name}" — ${order.length} step${order.length === 1 ? "" : "s"}.`,
  });

  for (const node of order) {
    const step = await store.createStep(run.id, node.id);
    const startedAt = now();
    await store.setStepStatus(step.id, { status: "running", startedAt });

    const handler = deps.handlers.get(node.type);
    if (!handler) {
      const message = `No handler for node type "${node.type}" (node "${node.id}").`;
      await store.setStepStatus(step.id, { status: "failed", error: message, endedAt: now() });
      await store.appendLog(run.id, { level: "error", message, nodeId: node.id });
      return fail(store, run.id, now, message, outputsOf(context));
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
    } catch (error) {
      const message = describeError(error);
      await store.setStepStatus(step.id, { status: "failed", error: message, endedAt: now() });
      await store.appendLog(run.id, {
        level: "error",
        message: `${node.label || node.id} failed — ${message}`,
        nodeId: node.id,
      });
      return fail(store, run.id, now, `${node.id}: ${message}`, outputsOf(context));
    }
  }

  await store.setRunStatus(run.id, { status: "succeeded", endedAt: now(), error: null });
  await store.appendLog(run.id, { level: "info", message: "Run succeeded." });
  return { status: "succeeded", outputs: outputsOf(context) };
}

function outputsOf(context: RunContext): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(context.nodes).map(([nodeId, entry]) => [nodeId, entry.output]),
  );
}

async function fail(
  store: RunStore,
  runId: string,
  now: () => Date,
  error: string,
  outputs: Record<string, unknown>,
): Promise<RunOutcome> {
  await store.setRunStatus(runId, { status: "failed", error, endedAt: now() });
  await store.appendLog(runId, { level: "error", message: `Run failed — ${error}` });
  return { status: "failed", outputs, error };
}

/** Load and execute whatever is next in the queue. Returns null when idle. */
export async function runNextQueued(deps: RunnerDeps): Promise<RunOutcome | null> {
  const run = await deps.store.claimNextQueuedRun();
  if (!run) return null;
  return executeRun(deps, run);
}

export type { LoadedPipeline, QueuedRun };
