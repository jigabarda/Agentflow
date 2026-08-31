import { appendTaskEvent } from "@/data/tasks";
import { prisma } from "./client";

/**
 * Retrying a failed run.
 *
 * The failed step is put back to `pending` and the run back to `queued`; the
 * worker then resumes it exactly as it resumes an approved gate, rebuilding
 * context from the steps that already succeeded. So a retry re-runs the step
 * that broke and nothing before it.
 *
 * The web app still writes only rows — it never executes.
 */

export type RetryResult =
  { ok: true; resumingFrom: string | null } | { ok: false; reason: string; status: 404 | 409 };

export async function retryRun(runId: string): Promise<RetryResult> {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: { id: true, status: true, taskId: true, error: true },
  });
  if (!run) return { ok: false, reason: "That run no longer exists.", status: 404 };

  if (run.status !== "failed") {
    return {
      ok: false,
      reason: `This run is ${run.status}, so there is nothing to retry.`,
      status: 409,
    };
  }

  const failedStep = await prisma.runStep.findFirst({
    where: { runId, status: "failed" },
    orderBy: { startedAt: "desc" },
    select: { id: true, nodeId: true },
  });

  await prisma.$transaction([
    // Clear the failed step so the runner sees work to do rather than a
    // finished node, and reuses this row instead of adding another.
    ...(failedStep
      ? [
          prisma.runStep.update({
            where: { id: failedStep.id },
            data: { status: "pending", error: null, endedAt: null },
          }),
        ]
      : []),
    // A step that was skipped because the run died is fair game again too.
    prisma.runStep.updateMany({
      where: { runId, status: "skipped" },
      data: { status: "pending", endedAt: null },
    }),
    prisma.run.update({
      where: { id: runId },
      data: { status: "queued", error: null, endedAt: null },
    }),
  ]);

  if (run.taskId) {
    await appendTaskEvent(run.taskId, {
      actor: "user",
      kind: "run_started",
      message: failedStep ? `Retrying from ${failedStep.nodeId}.` : "Retrying.",
      meta: { runId, ...(failedStep ? { nodeId: failedStep.nodeId } : {}) },
    });
  }

  return { ok: true, resumingFrom: failedStep?.nodeId ?? null };
}
