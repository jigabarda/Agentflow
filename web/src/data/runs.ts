import { redact } from "@agentflow/core";
import type { LogLevel, RunStatus, RunStepStatus } from "@agentflow/core";
import type { Prisma } from "@prisma/client";
import { prisma } from "./client";

/**
 * Runs, steps, and logs.
 *
 * The web app only ever ENQUEUES a run (status `queued`) and reads state back.
 * The worker is the only thing that executes (docs/ARCHITECTURE.md, boundary 6).
 */

export interface CreateRunInput {
  pipelineId: string;
  /** The card this run belongs to; omit for a canvas test-run. */
  taskId?: string | null;
  trigger: unknown;
}

export async function enqueueRun(input: CreateRunInput): Promise<{ id: string }> {
  const run = await prisma.run.create({
    data: {
      pipelineId: input.pipelineId,
      taskId: input.taskId ?? null,
      status: "queued" satisfies RunStatus,
      trigger: (input.trigger ?? null) as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  return run;
}

export async function getRun(id: string) {
  return prisma.run.findUnique({
    where: { id },
    include: { steps: { orderBy: { startedAt: "asc" } } },
  });
}

export async function listRunsForTask(taskId: string) {
  return prisma.run.findMany({ where: { taskId }, orderBy: { createdAt: "desc" } });
}

export interface RunStatusPatch {
  status: RunStatus;
  error?: string | null;
  startedAt?: Date | null;
  endedAt?: Date | null;
  tokensUsed?: number;
}

export async function setRunStatus(id: string, patch: RunStatusPatch) {
  return prisma.run.update({
    where: { id },
    data: {
      status: patch.status,
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
      ...(patch.endedAt !== undefined ? { endedAt: patch.endedAt } : {}),
      ...(patch.tokensUsed !== undefined ? { tokensUsed: patch.tokensUsed } : {}),
    },
  });
}

export async function createRunStep(runId: string, nodeId: string) {
  return prisma.runStep.create({
    data: { runId, nodeId, status: "pending" satisfies RunStepStatus },
  });
}

export interface RunStepPatch {
  status: RunStepStatus;
  output?: unknown;
  error?: string | null;
  startedAt?: Date | null;
  endedAt?: Date | null;
}

export async function setRunStepStatus(id: string, patch: RunStepPatch) {
  return prisma.runStep.update({
    where: { id },
    data: {
      status: patch.status,
      ...(patch.output !== undefined ? { output: patch.output as Prisma.InputJsonValue } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
      ...(patch.endedAt !== undefined ? { endedAt: patch.endedAt } : {}),
    },
  });
}

export interface AppendLogInput {
  level: LogLevel;
  message: string;
  nodeId?: string | null;
  /**
   * Plaintext secrets in play for this run. Every one is scrubbed from the
   * message before it is written — logs are the most common leak path, so
   * redaction happens HERE, at the single write point, not at each call site.
   */
  secrets?: readonly (string | null | undefined)[];
}

export async function appendLog(runId: string, input: AppendLogInput) {
  return prisma.logEntry.create({
    data: {
      runId,
      nodeId: input.nodeId ?? null,
      level: input.level,
      message: redact(input.message, input.secrets ?? []),
    },
  });
}

export async function listLogs(runId: string) {
  return prisma.logEntry.findMany({ where: { runId }, orderBy: { createdAt: "asc" } });
}
