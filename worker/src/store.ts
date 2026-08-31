import type {
  LogLevel,
  PipelineEdge,
  PipelineNode,
  RunStatus,
  RunStepStatus,
} from "@agentflow/core";
import { redact } from "@agentflow/core";
import type { PrismaClient } from "@prisma/client";

/**
 * Everything the engine needs from storage, behind one interface.
 *
 * The runner takes a `RunStore`, so its logic can be unit-tested against an
 * in-memory implementation with no database, and the integration test can run
 * the very same code against SQLite.
 */

export interface QueuedRun {
  id: string;
  pipelineId: string;
  taskId: string | null;
  trigger: unknown;
}

export interface LoadedPipeline {
  id: string;
  name: string;
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  vars: Record<string, string>;
}

export interface RunStatusPatch {
  status: RunStatus;
  error?: string | null;
  startedAt?: Date;
  endedAt?: Date;
}

export interface StepPatch {
  status: RunStepStatus;
  output?: unknown;
  error?: string | null;
  startedAt?: Date;
  endedAt?: Date;
}

export interface LogInput {
  level: LogLevel;
  message: string;
  nodeId?: string | null;
}

export interface CompletedStep {
  nodeId: string;
  output: unknown;
}

export interface RunStore {
  /** Atomically take one queued run. Returns null when the queue is empty. */
  claimNextQueuedRun(): Promise<QueuedRun | null>;
  loadPipeline(pipelineId: string): Promise<LoadedPipeline | null>;
  setRunStatus(runId: string, patch: RunStatusPatch): Promise<void>;
  createStep(runId: string, nodeId: string): Promise<{ id: string }>;
  setStepStatus(stepId: string, patch: StepPatch): Promise<void>;
  appendLog(runId: string, entry: LogInput): Promise<void>;
  /**
   * Steps that already succeeded on an earlier attempt at this run.
   *
   * This is what makes an approval gate resumable: the run comes back from the
   * queue, rebuilds its context from these outputs, and carries on from the
   * gate rather than redoing work (and re-spending tokens).
   */
  loadCompletedSteps(runId: string): Promise<CompletedStep[]>;
  /** A step for this node that has not finished — reused instead of duplicated. */
  findOpenStep(runId: string, nodeId: string): Promise<{ id: string } | null>;
}

// ────────────────────────────── Prisma-backed ───────────────────────────────

export class PrismaRunStore implements RunStore {
  constructor(
    private readonly prisma: PrismaClient,
    /** Plaintext secrets in play, scrubbed from every log line before write. */
    private readonly secrets: readonly string[] = [],
  ) {}

  /**
   * Claim exactly one queued run.
   *
   * The conditional `updateMany` is the lock: only the worker whose update
   * matched a still-`queued` row gets the run, so a second worker (or a restart
   * racing the first) can never pick up the same one.
   */
  async claimNextQueuedRun(): Promise<QueuedRun | null> {
    const candidate = await this.prisma.run.findFirst({
      where: { status: "queued" },
      orderBy: { createdAt: "asc" },
      select: { id: true, pipelineId: true, taskId: true, trigger: true },
    });
    if (!candidate) return null;

    const claimed = await this.prisma.run.updateMany({
      where: { id: candidate.id, status: "queued" },
      data: { status: "running", startedAt: new Date() },
    });
    if (claimed.count === 0) return null; // someone else got it first

    return {
      id: candidate.id,
      pipelineId: candidate.pipelineId,
      taskId: candidate.taskId,
      trigger: candidate.trigger,
    };
  }

  async loadPipeline(pipelineId: string): Promise<LoadedPipeline | null> {
    const row = await this.prisma.pipeline.findUnique({
      where: { id: pipelineId },
      include: { nodes: true, edges: true, variables: true },
    });
    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      nodes: row.nodes.map((node) => ({
        id: node.id,
        type: node.type,
        label: node.label,
        config: (node.config ?? {}) as Record<string, unknown>,
        x: node.x,
        y: node.y,
      })),
      edges: row.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
        // Without these the flow controller cannot tell a deliberate loop from
        // a cycle, and the run would refuse to start.
        ...(edge.loop ? { loop: true } : {}),
        ...(edge.maxIterations !== null ? { maxIterations: edge.maxIterations } : {}),
      })),
      vars: Object.fromEntries(row.variables.map((variable) => [variable.key, variable.value])),
    };
  }

  async setRunStatus(runId: string, patch: RunStatusPatch): Promise<void> {
    await this.prisma.run.update({
      where: { id: runId },
      data: {
        status: patch.status,
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        ...(patch.startedAt ? { startedAt: patch.startedAt } : {}),
        ...(patch.endedAt ? { endedAt: patch.endedAt } : {}),
      },
    });
  }

  async createStep(runId: string, nodeId: string): Promise<{ id: string }> {
    return this.prisma.runStep.create({
      data: { runId, nodeId, status: "pending" },
      select: { id: true },
    });
  }

  async setStepStatus(stepId: string, patch: StepPatch): Promise<void> {
    await this.prisma.runStep.update({
      where: { id: stepId },
      data: {
        status: patch.status,
        ...(patch.output !== undefined ? { output: patch.output as never } : {}),
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        ...(patch.startedAt ? { startedAt: patch.startedAt } : {}),
        ...(patch.endedAt ? { endedAt: patch.endedAt } : {}),
      },
    });
  }

  async loadCompletedSteps(runId: string): Promise<CompletedStep[]> {
    const rows = await this.prisma.runStep.findMany({
      where: { runId, status: "succeeded" },
      orderBy: { startedAt: "asc" },
      select: { nodeId: true, output: true },
    });
    return rows.map((row) => ({ nodeId: row.nodeId, output: row.output }));
  }

  async findOpenStep(runId: string, nodeId: string): Promise<{ id: string } | null> {
    return this.prisma.runStep.findFirst({
      where: { runId, nodeId, status: { in: ["pending", "running"] } },
      select: { id: true },
    });
  }

  async appendLog(runId: string, entry: LogInput): Promise<void> {
    await this.prisma.logEntry.create({
      data: {
        runId,
        nodeId: entry.nodeId ?? null,
        level: entry.level,
        // Redaction happens at the single write point, never at call sites.
        message: redact(entry.message, this.secrets),
      },
    });
  }
}
