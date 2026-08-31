import { checkRunReadiness, taskMatchesTrigger } from "@agentflow/core";
import type { Task } from "@agentflow/core";
import { agentProfileChoices } from "@/data/agentProfiles";
import { getPipeline } from "@/data/pipelines";
import { enqueueRun } from "@/data/runs";
import { listCredentialStates } from "@/data/secrets";
import { appendTaskEvent } from "@/data/tasks";
import { prisma } from "./client";

/**
 * Board-driven automation: entering a column starts that column's pipeline.
 *
 * This is the ONLY place the two halves of the product meet on the web side,
 * and it still writes nothing but rows — a `queued` Run. The worker is the only
 * thing that executes (CLAUDE.md guardrail 12).
 */

export type StartRunOutcome =
  | { started: true; runId: string }
  /** Nothing was wrong — this column simply does not automate this card. */
  | { started: false; reason: string; blocked?: false }
  /** The run could not be queued and the user needs to know why. */
  | { started: false; reason: string; blocked: true };

/** The card as the agent reads it: `{{ trigger.task.title }}` (docs/BOARD.md). */
export function triggerPayloadFor(task: Task) {
  return {
    task: {
      id: task.id,
      title: task.title,
      body: task.body,
      labels: task.labels,
      priority: task.priority,
      repo: task.repo,
      issueNumber: task.issueNumber,
      dueAt: task.dueAt,
    },
  };
}

/**
 * Queue a run of `pipelineId` for `task`.
 *
 * Refuses before spending anything: an invalid graph, or a provider with no key
 * on this pipeline, makes the run impossible (docs/AGENTS.md).
 */
export async function startRunForTask(
  task: Task,
  pipelineId: string,
  options: { via: "column" | "manual" } = { via: "manual" },
): Promise<StartRunOutcome> {
  const pipeline = await getPipeline(pipelineId);
  if (!pipeline) {
    return { started: false, blocked: true, reason: "That pipeline no longer exists." };
  }

  // Only run for the cards this pipeline's trigger asks for.
  const trigger = pipeline.nodes.find((node) => node.type === "task-trigger");
  const requireLabels = trigger?.config?.requireLabels;
  if (!taskMatchesTrigger(task, Array.isArray(requireLabels) ? requireLabels.map(String) : null)) {
    return {
      started: false,
      reason: `"${pipeline.name}" only runs for cards labelled ${(requireLabels as string[]).join(", ")}.`,
    };
  }

  const readiness = checkRunReadiness(
    pipeline,
    await listCredentialStates(pipeline.id),
    await agentProfileChoices(),
  );
  if (!readiness.ready) {
    const reason = readiness.problems[0]?.message ?? "This pipeline is not ready to run.";
    // The card's timeline should say why nothing happened — otherwise a drop
    // that starts nothing looks like the system silently ignoring you.
    await appendTaskEvent(task.id, {
      actor: "system",
      kind: "updated",
      message: `Could not start "${pipeline.name}" — ${reason}`,
      meta: { pipelineId, problems: readiness.problems },
    });
    return { started: false, blocked: true, reason };
  }

  const run = await enqueueRun({
    pipelineId: pipeline.id,
    taskId: task.id,
    trigger: triggerPayloadFor(task),
  });

  await appendTaskEvent(task.id, {
    actor: "system",
    kind: "run_started",
    message:
      options.via === "column"
        ? `Queued "${pipeline.name}".`
        : `Queued "${pipeline.name}" (run now).`,
    meta: { runId: run.id, pipelineId: pipeline.id, via: options.via },
  });

  return { started: true, runId: run.id };
}

/**
 * A card has just entered `columnId`. Start the column's pipeline, if it has one.
 *
 * Called after the move is written, never before: a card that fails to start a
 * run has still moved, and the timeline says what went wrong.
 */
export async function startColumnAutomation(
  task: Task,
  columnId: string,
): Promise<StartRunOutcome> {
  const column = await prisma.boardColumn.findUnique({
    where: { id: columnId },
    select: { pipelineId: true },
  });

  if (!column?.pipelineId) {
    return { started: false, reason: "This column does not run a pipeline." };
  }

  return startRunForTask(task, column.pipelineId, { via: "column" });
}
