import { appendTaskEvent } from "@/data/tasks";
import { prisma } from "./client";

/**
 * Human gates, from the board's side.
 *
 * The worker opens a gate and parks the run; this is what a person's decision
 * does to it. Approving and rejecting both put the run back in the queue — a
 * rejection is not a special case, it is the run resuming and then failing at
 * the gate with the user's comment as the reason, so the column's failure rule
 * still applies (docs/BOARD.md).
 */

export type ApprovalDecision = "approve" | "reject";

export type DecideResult =
  { ok: true; state: "approved" | "rejected" } | { ok: false; reason: string; status: 404 | 409 };

export interface PendingApproval {
  runId: string;
  nodeId: string;
  taskId: string | null;
  pipelineName: string;
  /** The question the gate asked, taken from the log line it wrote. */
  message: string | null;
}

export async function decideApproval(
  runId: string,
  decision: ApprovalDecision,
  comment: string | null,
): Promise<DecideResult> {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: { id: true, status: true, taskId: true },
  });
  if (!run) return { ok: false, reason: "That run no longer exists.", status: 404 };

  if (run.status !== "awaiting_approval") {
    return {
      ok: false,
      reason: `This run is ${run.status}, so there is nothing to approve.`,
      status: 409,
    };
  }

  const gate = await prisma.runApproval.findFirst({
    where: { runId, state: "pending" },
    orderBy: { createdAt: "desc" },
  });
  if (!gate) {
    return { ok: false, reason: "This run is not waiting on a decision.", status: 409 };
  }

  const state = decision === "approve" ? "approved" : "rejected";

  await prisma.$transaction([
    prisma.runApproval.update({
      where: { id: gate.id },
      data: { state, comment, decidedAt: new Date() },
    }),
    // Back into the queue. The worker resumes at the gate, which now finds a
    // verdict instead of parking again.
    prisma.run.update({ where: { id: runId }, data: { status: "queued", error: null } }),
  ]);

  if (run.taskId) {
    await appendTaskEvent(run.taskId, {
      actor: "user",
      kind: state === "approved" ? "approved" : "rejected",
      message: comment?.trim() || (state === "approved" ? "Approved." : "Rejected."),
      meta: { runId, nodeId: gate.nodeId },
    });
  }

  return { ok: true, state };
}

/** The gates currently waiting on a person — the board's "waiting on me". */
export async function listPendingApprovals(): Promise<PendingApproval[]> {
  const rows = await prisma.runApproval.findMany({
    where: { state: "pending", run: { status: "awaiting_approval" } },
    include: { run: { select: { taskId: true, pipeline: { select: { name: true } } } } },
    orderBy: { createdAt: "desc" },
  });

  return rows.map((row) => ({
    runId: row.runId,
    nodeId: row.nodeId,
    taskId: row.run.taskId,
    pipelineName: row.run.pipeline.name,
    message: null,
  }));
}

/** The gate a given card is parked at, if any. */
export async function pendingApprovalForTask(taskId: string): Promise<PendingApproval | null> {
  const row = await prisma.runApproval.findFirst({
    where: { state: "pending", run: { taskId, status: "awaiting_approval" } },
    include: { run: { select: { taskId: true, pipeline: { select: { name: true } } } } },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return null;

  return {
    runId: row.runId,
    nodeId: row.nodeId,
    taskId: row.run.taskId,
    pipelineName: row.run.pipeline.name,
    message: null,
  };
}
