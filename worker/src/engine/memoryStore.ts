import type {
  CompletedStep,
  LoadedPipeline,
  LogInput,
  QueuedRun,
  RunStatusPatch,
  RunStore,
  StepPatch,
} from "../store";

/**
 * An in-memory `RunStore` for tests.
 *
 * The runner's logic is worth testing without a database — this records every
 * write so a test can assert on the exact sequence of transitions.
 */
export interface RecordedStep {
  id: string;
  runId: string;
  nodeId: string;
  status: string;
  output?: unknown;
  error?: string | null;
}

export interface RecordedLog {
  runId: string;
  level: string;
  message: string;
  nodeId?: string | null;
}

export class MemoryRunStore implements RunStore {
  readonly steps: RecordedStep[] = [];
  readonly logs: RecordedLog[] = [];
  readonly runStatuses: RunStatusPatch[] = [];

  private queue: QueuedRun[] = [];
  private stepCounter = 0;

  constructor(private readonly pipelines: Map<string, LoadedPipeline> = new Map()) {}

  addPipeline(pipeline: LoadedPipeline): void {
    this.pipelines.set(pipeline.id, pipeline);
  }

  enqueue(run: QueuedRun): void {
    this.queue.push(run);
  }

  async claimNextQueuedRun(): Promise<QueuedRun | null> {
    return this.queue.shift() ?? null;
  }

  async loadPipeline(pipelineId: string): Promise<LoadedPipeline | null> {
    return this.pipelines.get(pipelineId) ?? null;
  }

  async setRunStatus(_runId: string, patch: RunStatusPatch): Promise<void> {
    this.runStatuses.push(patch);
  }

  async createStep(runId: string, nodeId: string): Promise<{ id: string }> {
    const id = `step_${++this.stepCounter}`;
    this.steps.push({ id, runId, nodeId, status: "pending" });
    return { id };
  }

  async setStepStatus(stepId: string, patch: StepPatch): Promise<void> {
    const step = this.steps.find((item) => item.id === stepId);
    if (!step) throw new Error(`No such step ${stepId}`);
    step.status = patch.status;
    if (patch.output !== undefined) step.output = patch.output;
    if (patch.error !== undefined) step.error = patch.error;
  }

  async appendLog(runId: string, entry: LogInput): Promise<void> {
    this.logs.push({ runId, ...entry });
  }

  async loadCompletedSteps(runId: string): Promise<CompletedStep[]> {
    return this.steps
      .filter((step) => step.runId === runId && step.status === "succeeded")
      .map((step) => ({ nodeId: step.nodeId, output: step.output }));
  }

  async findOpenStep(runId: string, nodeId: string): Promise<{ id: string } | null> {
    const step = this.steps.find(
      (item) =>
        item.runId === runId &&
        item.nodeId === nodeId &&
        (item.status === "pending" || item.status === "running"),
    );
    return step ? { id: step.id } : null;
  }

  /** The node ids that actually ran, in the order they ran. */
  executionOrder(): string[] {
    return this.steps.map((step) => step.nodeId);
  }

  finalStatus(): string | undefined {
    return this.runStatuses.at(-1)?.status;
  }
}
