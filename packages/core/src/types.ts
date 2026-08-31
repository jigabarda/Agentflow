/**
 * Core domain types — pure, framework-free, shared by `web` and `worker`.
 *
 * Two halves, joined by Task ←→ Run:
 *   · work tracking — Board / BoardColumn / Task / TaskEvent   (docs/BOARD.md)
 *   · execution     — Pipeline / Run / RunStep / LogEntry      (docs/ARCHITECTURE.md)
 */

/** Node-type ids are kebab-case and join the editor registry to the worker handler registry. */
export type NodeTypeId = string;

// ─────────────────────────────── work tracking ───────────────────────────────

/** Semantic column role. Drives UI affordances and what automation may do. */
export type ColumnKind = "backlog" | "ready" | "working" | "waiting" | "done";

export type TaskPriority = "low" | "normal" | "high" | "urgent";

/** Where a card goes when its run (or its PR) reaches a terminal state. */
export interface AutoAdvance {
  onRunSucceeded?: string;
  onRunFailed?: string;
  onPrMerged?: string;
}

/** The terminal outcomes `autoAdvance` can react to. */
export type RunOutcome = "run_succeeded" | "run_failed" | "pr_merged";

export interface BoardColumn {
  id: string;
  boardId: string;
  name: string;
  order: number;
  kind: ColumnKind;
  wipLimit?: number | null;
  /** Entering this column starts THIS pipeline. Null = a manual column. */
  pipelineId?: string | null;
  autoAdvance?: AutoAdvance | null;
}

export interface Board {
  id: string;
  name: string;
  columns: BoardColumn[];
}

export interface Task {
  id: string;
  boardId: string;
  columnId: string;
  title: string;
  /** Markdown — this is the brief the agent reads. */
  body?: string | null;
  order: number;
  priority: TaskPriority;
  labels: string[];
  estimate?: number | null;
  repo?: string | null;
  issueNumber?: number | null;
  prNumber?: number | null;
  prUrl?: string | null;
  /** Task ids that must be done before this card may enter a `working` column. */
  blockedBy: string[];
  dueAt?: Date | null;
  /** cron/RRULE — a template card respawns children on this schedule. */
  recurrence?: string | null;
  /** The timezone that recurrence is read in. */
  recurrenceTz?: string | null;
  /** For a spawned child: the slot it was created for. */
  scheduledFor?: Date | null;
  templateId?: string | null;
  parentTaskId?: string | null;
  archivedAt?: Date | null;
}

export type TaskEventActor = "user" | "system" | "github" | `agent:${string}`;

export type TaskEventKind =
  | "created"
  | "moved"
  | "commented"
  | "updated"
  | "run_started"
  | "run_step"
  | "run_succeeded"
  | "run_failed"
  | "pr_opened"
  | "approved"
  | "rejected";

export interface TaskEvent {
  id: string;
  taskId: string;
  actor: TaskEventActor;
  kind: TaskEventKind;
  message: string;
  meta?: Record<string, unknown> | null;
  createdAt: Date;
}

// ──────────────────────────────── execution ─────────────────────────────────

export type RunStatus =
  "queued" | "running" | "awaiting_approval" | "succeeded" | "failed" | "canceled";

export type RunStepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface PipelineNode {
  id: string;
  type: NodeTypeId;
  label: string;
  /** Validated by the node type's own Zod schema; may contain `{{ interpolated }}` values. */
  config: Record<string, unknown>;
  x: number;
  y: number;
}

export interface PipelineEdge {
  id: string;
  source: string;
  target: string;
  /** Set by branching nodes (e.g. "true" / "false") so the runner follows one path. */
  sourceHandle?: string;
  /**
   * A deliberate way back to an earlier node — "reviewer asked for changes, go
   * implement again". Marked explicitly so that every OTHER cycle stays a
   * validation error: an accidental loop must never be runnable.
   */
  loop?: boolean;
  /** How many times this loop may be taken before the run fails. */
  maxIterations?: number;
}

export interface Pipeline {
  id: string;
  name: string;
  nodes: PipelineNode[];
  edges: PipelineEdge[];
}

export interface RunStep {
  id: string;
  runId: string;
  nodeId: string;
  status: RunStepStatus;
  output?: unknown;
  error?: string;
}

export interface Run {
  id: string;
  pipelineId: string;
  /** The board card this run belongs to; null for canvas test-runs. */
  taskId?: string;
  status: RunStatus;
  trigger: unknown;
  steps: RunStep[];
  error?: string;
}

/**
 * An agent node's effective model choice.
 * ⚠️ There is NO default provider/model — the user must pick both, or the
 * pipeline is invalid and un-runnable. See docs/AGENTS.md.
 */
export interface AgentModelChoice {
  provider: string;
  model: string;
}

// ────────────────────────────── run context ─────────────────────────────────

/**
 * The single object threaded through every node during a run.
 * Templates in node configs resolve against exactly this shape.
 */
export interface RunContext {
  /** Pipeline-level reusable variables. */
  pipeline: { vars: Record<string, string> };
  /** The triggering payload — the task card, an issue, or manual input. */
  trigger: unknown;
  /** The board card this run belongs to, when it came from the board. */
  task?: {
    id: string;
    title: string;
    body?: string | null;
    repo?: string | null;
    issueNumber?: number | null;
  };
  /** Outputs of the nodes that have already run, by node id. */
  nodes: Record<string, { output: unknown }>;
  runId: string;
  /** The pipeline being executed — handlers resolve per-pipeline credentials with it. */
  pipelineId: string;
  /** This run's isolated working directory. */
  workspaceDir: string;
}
