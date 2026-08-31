/**
 * Zod schemas — the single source of truth for validation across web + worker.
 * `types.ts` describes the shape; these enforce it at every boundary.
 */
import { z } from "zod";

// ─────────────────────────────── work tracking ───────────────────────────────

export const columnKindSchema = z.enum(["backlog", "ready", "working", "waiting", "done"]);

export const taskPrioritySchema = z.enum(["low", "normal", "high", "urgent"]);

export const autoAdvanceSchema = z.object({
  onRunSucceeded: z.string().min(1).optional(),
  onRunFailed: z.string().min(1).optional(),
  onPrMerged: z.string().min(1).optional(),
});

export const runOutcomeSchema = z.enum(["run_succeeded", "run_failed", "pr_merged"]);

export const boardColumnSchema = z.object({
  id: z.string().min(1),
  boardId: z.string().min(1),
  name: z.string().min(1),
  order: z.number().int(),
  kind: columnKindSchema,
  wipLimit: z.number().int().positive().nullish(),
  pipelineId: z.string().min(1).nullish(),
  autoAdvance: autoAdvanceSchema.nullish(),
});

export const boardSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  columns: z.array(boardColumnSchema).default([]),
});

/** "owner/name" — the only repo form the GitHub nodes accept. */
export const repoSlugSchema = z
  .string()
  .regex(/^[\w.-]+\/[\w.-]+$/, 'repo must look like "owner/name"');

export const taskSchema = z.object({
  id: z.string().min(1),
  boardId: z.string().min(1),
  columnId: z.string().min(1),
  title: z.string().min(1, "a card needs a title"),
  body: z.string().nullish(),
  order: z.number().finite(),
  priority: taskPrioritySchema.default("normal"),
  labels: z.array(z.string().min(1)).default([]),
  estimate: z.number().int().positive().nullish(),
  repo: repoSlugSchema.nullish(),
  issueNumber: z.number().int().positive().nullish(),
  prNumber: z.number().int().positive().nullish(),
  prUrl: z.string().url().nullish(),
  blockedBy: z.array(z.string().min(1)).default([]),
  dueAt: z.coerce.date().nullish(),
  recurrence: z.string().min(1).nullish(),
  templateId: z.string().min(1).nullish(),
  parentTaskId: z.string().min(1).nullish(),
  archivedAt: z.coerce.date().nullish(),
});

/** What the UI may send when creating a card. Quick-add sends title alone. */
export const createTaskInputSchema = taskSchema
  .pick({
    boardId: true,
    columnId: true,
    title: true,
    body: true,
    priority: true,
    labels: true,
    estimate: true,
    repo: true,
    issueNumber: true,
    blockedBy: true,
    dueAt: true,
    recurrence: true,
    templateId: true,
    parentTaskId: true,
  })
  .partial({
    body: true,
    priority: true,
    labels: true,
    estimate: true,
    repo: true,
    issueNumber: true,
    blockedBy: true,
    dueAt: true,
    recurrence: true,
    templateId: true,
    parentTaskId: true,
  });

export const updateTaskInputSchema = taskSchema
  .pick({
    title: true,
    body: true,
    priority: true,
    labels: true,
    estimate: true,
    repo: true,
    issueNumber: true,
    prNumber: true,
    prUrl: true,
    blockedBy: true,
    dueAt: true,
    recurrence: true,
  })
  .partial();

export const taskEventActorSchema = z
  .string()
  .min(1)
  .refine(
    (actor) =>
      actor === "user" || actor === "system" || actor === "github" || actor.startsWith("agent:"),
    'actor must be "user", "system", "github", or "agent:<nodeId>"',
  );

export const taskEventKindSchema = z.enum([
  "created",
  "moved",
  "commented",
  "updated",
  "run_started",
  "run_step",
  "run_succeeded",
  "run_failed",
  "pr_opened",
  "approved",
  "rejected",
]);

export const taskEventSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  actor: taskEventActorSchema,
  kind: taskEventKindSchema,
  message: z.string().min(1),
  meta: z.record(z.string(), z.unknown()).nullish(),
  createdAt: z.coerce.date(),
});

// ──────────────────────────────── execution ─────────────────────────────────

export const runStatusSchema = z.enum([
  "queued",
  "running",
  "awaiting_approval",
  "succeeded",
  "failed",
  "canceled",
]);

export const runStepStatusSchema = z.enum(["pending", "running", "succeeded", "failed", "skipped"]);

export const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);

/** Node-type ids are kebab-case: `agent`, `open-pr`, `task-trigger`. */
export const nodeTypeIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, "node-type ids must be kebab-case");

export const pipelineNodeSchema = z.object({
  id: z.string().min(1),
  type: nodeTypeIdSchema,
  label: z.string().min(1),
  config: z.record(z.string(), z.unknown()).default({}),
  x: z.number(),
  y: z.number(),
});

export const pipelineEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: z.string().min(1).optional(),
  /** A deliberate way back to an earlier node — the reviewer loop. */
  loop: z.boolean().optional(),
  /** How many times that loop may be taken before the run fails. */
  maxIterations: z.number().int().positive().optional(),
});

export const pipelineSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  nodes: z.array(pipelineNodeSchema).default([]),
  edges: z.array(pipelineEdgeSchema).default([]),
});

export const runStepSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  nodeId: z.string().min(1),
  status: runStepStatusSchema,
  output: z.unknown().optional(),
  error: z.string().optional(),
});

export const runSchema = z.object({
  id: z.string().min(1),
  pipelineId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  status: runStatusSchema,
  trigger: z.unknown(),
  steps: z.array(runStepSchema).default([]),
  error: z.string().optional(),
});

/**
 * An agent's model choice. Both halves are REQUIRED and neither has a default —
 * an unconfigured agent node must fail validation, not silently pick a model.
 */
export const agentModelChoiceSchema = z.object({
  provider: z.string().min(1, "pick a provider"),
  model: z.string().min(1, "pick a model"),
});

export const agentEffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);

export const agentProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  provider: z.string().min(1, "pick a provider"),
  model: z.string().min(1, "pick a model"),
  effort: agentEffortSchema.default("high"),
  systemPrompt: z.string().default(""),
  allowedTools: z.array(z.string().min(1)).default([]),
  maxTokens: z.number().int().positive().nullish(),
  version: z.number().int().positive().default(1),
});

/** A provider credential as the UI submits it. The key is write-only. */
export const providerCredentialInputSchema = z
  .object({
    pipelineId: z.string().min(1),
    provider: z.string().min(1),
    label: z.string().min(1).nullish(),
    apiKey: z.string().min(1).nullish(),
    baseUrl: z.string().url().nullish(),
  })
  .refine((c) => Boolean(c.apiKey) || Boolean(c.baseUrl), {
    message: "provide an API key, or a base URL for a local model",
  });
