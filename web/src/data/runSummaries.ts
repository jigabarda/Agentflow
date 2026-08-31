import type { RunStatus } from "@agentflow/core";
import { prisma } from "./client";

/**
 * What a card shows about its run: the live badge on the card face.
 *
 * One summary per card — its newest run — because that is what the board asks:
 * "what is happening to this card right now?" (docs/BOARD.md, card face).
 */

export interface RunSummary {
  taskId: string;
  runId: string;
  status: RunStatus;
  /** Steps finished, and how many the pipeline has in total: "3/7". */
  done: number;
  total: number;
  /** The node that is running now, or the one that failed. */
  currentNodeId: string | null;
  error: string | null;
  /** True when the run is parked at a gate and the card needs a decision. */
  awaitingApproval: boolean;
  updatedAt: Date;
}

export async function runSummariesForBoard(boardId: string): Promise<RunSummary[]> {
  const runs = await prisma.run.findMany({
    where: { task: { boardId, archivedAt: null } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      taskId: true,
      status: true,
      error: true,
      createdAt: true,
      startedAt: true,
      endedAt: true,
      pipeline: { select: { _count: { select: { nodes: true } } } },
      steps: {
        select: { nodeId: true, status: true, endedAt: true, startedAt: true },
        orderBy: { startedAt: "asc" },
      },
    },
  });

  const newestPerTask = new Map<string, RunSummary>();

  for (const run of runs) {
    if (!run.taskId || newestPerTask.has(run.taskId)) continue;

    const done = run.steps.filter((step) => step.status === "succeeded").length;
    const active =
      run.steps.find((step) => step.status === "running") ??
      run.steps.find((step) => step.status === "failed") ??
      run.steps.find((step) => step.status === "pending");

    newestPerTask.set(run.taskId, {
      taskId: run.taskId,
      runId: run.id,
      status: run.status as RunStatus,
      done,
      total: run.pipeline._count.nodes,
      currentNodeId: active?.nodeId ?? null,
      error: run.error,
      awaitingApproval: run.status === "awaiting_approval",
      updatedAt: run.endedAt ?? run.startedAt ?? run.createdAt,
    });
  }

  return [...newestPerTask.values()];
}

/**
 * A cheap value that changes whenever anything on the board's runs changes.
 *
 * The stream compares this between ticks so it only sends when there is news.
 */
export function fingerprint(summaries: readonly RunSummary[]): string {
  return summaries
    .map((s) => `${s.taskId}:${s.runId}:${s.status}:${s.done}:${s.currentNodeId ?? ""}`)
    .sort()
    .join("|");
}
