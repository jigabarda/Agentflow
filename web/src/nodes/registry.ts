import { z } from "zod";
import { fieldsFromSchema } from "./fields";

/**
 * The node registry — the ONE place a node type is declared for the editor.
 *
 * Adding a node type = adding an entry here (and a handler in the worker, keyed
 * by the same `id`). Nothing else in the editor needs editing: the palette, the
 * config form, and validation are all driven off this list. See docs/NODES.md.
 */

export type NodeCategory = "trigger" | "flow" | "agent" | "board" | "github" | "deploy";

export interface NodeTypeDef {
  id: string;
  label: string;
  category: NodeCategory;
  /** 🟢 mvp (Phases 0–7) or 🔵 later (Phases 8–12). */
  phase: "mvp" | "later";
  /** One line, shown in the palette and at the top of the config panel. */
  description: string;
  /** Drives both the config form and validation. */
  configSchema: z.ZodObject<z.ZodRawShape>;
  /** Run-context paths this node reads — documentation for the user. */
  inputs: string[];
  /** Keys this node writes to `nodes.<id>.output`. */
  outputs: string[];
}

/** `{{ interpolatable }}` free text. Kept as a marker so the form can hint it. */
const interpolatable = (description: string) => z.string().describe(description);

export const NODE_TYPES: readonly NodeTypeDef[] = [
  // ───────────────────────────── triggers ─────────────────────────────
  {
    id: "task-trigger",
    label: "Task card",
    category: "trigger",
    phase: "mvp",
    description: "A card entering this pipeline's column starts the run. The primary trigger.",
    configSchema: z.object({
      requireLabels: z
        .array(z.string())
        .default([])
        .describe("Only run for cards with these labels"),
    }),
    inputs: [],
    outputs: ["task"],
  },
  {
    id: "manual-trigger",
    label: "Manual",
    category: "trigger",
    phase: "mvp",
    description: "Starts a run from a payload you supply. Useful for testing a pipeline.",
    configSchema: z.object({}),
    inputs: [],
    outputs: ["input"],
  },
  {
    id: "github-issue-trigger",
    label: "GitHub issue",
    category: "trigger",
    phase: "mvp",
    description: "Starts a run from a GitHub issue.",
    configSchema: z.object({
      repo: interpolatable("owner/name"),
      issueNumber: z.number().int().positive().optional().describe("Leave blank for webhooks"),
    }),
    inputs: [],
    outputs: ["issue"],
  },
  {
    id: "schedule-trigger",
    label: "Schedule",
    category: "trigger",
    phase: "later",
    description: "Runs on a clock, with no card at all. For nightly audits and morning digests.",
    configSchema: z.object({
      cron: z.string().describe("e.g. 0 9 * * 1-5"),
      timezone: z.string().default("UTC"),
    }),
    inputs: [],
    outputs: ["scheduledFor"],
  },

  // ─────────────────────────────── flow ───────────────────────────────
  {
    id: "echo",
    label: "Echo",
    category: "flow",
    phase: "mvp",
    description: "Returns its own config. Proves the engine works without agents or GitHub.",
    configSchema: z.object({
      value: interpolatable("Any text, with {{ variables }}"),
    }),
    inputs: [],
    outputs: ["value"],
  },
  {
    id: "condition",
    label: "Condition",
    category: "flow",
    phase: "later",
    description: "Routes the run down one branch based on a value.",
    configSchema: z.object({
      expression: interpolatable("e.g. {{ nodes.reviewer.output.result }}"),
      cases: z
        .array(z.string())
        .default([])
        .describe("Handles to try, in order. The first one found in the value wins"),
      default: z.string().default("false").describe("Handle to follow when nothing matches"),
    }),
    inputs: [],
    outputs: ["branch", "matched", "value"],
  },
  {
    id: "http-request",
    label: "HTTP request",
    category: "flow",
    phase: "later",
    description: "Calls any API or endpoint. The escape hatch for anything not built in.",
    configSchema: z.object({
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
      url: interpolatable("https://…"),
      body: z.string().optional().describe("JSON body, interpolatable"),
      secretRefs: z
        .array(z.string())
        .default([])
        .describe("Secret names injected at call time, never logged"),
    }),
    inputs: [],
    outputs: ["status", "headers", "body"],
  },

  // ─────────────────────────────── agent ──────────────────────────────
  {
    id: "agent",
    label: "AI agent",
    category: "agent",
    phase: "mvp",
    description: "Runs an AI agent in this run's isolated workspace. You choose the model.",
    configSchema: z.object({
      agentProfileId: z.string().optional().describe("Use a saved agent"),
      // provider + model are REQUIRED with NO default — an unconfigured agent
      // node makes the whole pipeline invalid. See docs/AGENTS.md.
      provider: z.string().optional().describe("Required unless a profile is assigned"),
      model: z.string().optional().describe("Required unless a profile is assigned"),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
      systemPrompt: z.string().optional().describe("The agent's instructions, interpolatable"),
      allowedTools: z.array(z.string()).default([]).describe("Tools this agent may use"),
      maxTokens: z.number().int().positive().optional().describe("Per-node cost guard"),
    }),
    inputs: ["trigger", "nodes"],
    outputs: ["result", "filesChanged", "usage"],
  },

  // ─────────────────────────────── board ──────────────────────────────
  {
    id: "update-task",
    label: "Update card",
    category: "board",
    phase: "mvp",
    description: "Moves the card, sets fields, or posts to its timeline mid-run.",
    configSchema: z.object({
      columnId: z.string().optional().describe("Move the card to this column"),
      comment: z.string().optional().describe("Posted to the card's timeline, interpolatable"),
      addLabels: z.array(z.string()).default([]),
      priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
      prNumber: interpolatable("e.g. {{ nodes.pr.output.prNumber }}").optional(),
      prUrl: interpolatable("e.g. {{ nodes.pr.output.prUrl }}").optional(),
      taskId: z.string().optional().describe("Defaults to the card that started this run"),
    }),
    inputs: ["trigger.task"],
    outputs: ["task"],
  },
  {
    id: "create-task",
    label: "Create cards",
    category: "board",
    phase: "mvp",
    description: "Turns a plan into subtask cards on the board.",
    configSchema: z.object({
      boardId: z.string().describe("Board to create the cards on"),
      columnId: z.string().describe("Column to create them in"),
      tasks: interpolatable("e.g. {{ nodes.planner.output.tasks }}"),
    }),
    inputs: ["nodes"],
    outputs: ["createdTaskIds"],
  },
  {
    id: "require-approval",
    label: "Wait for approval",
    category: "board",
    phase: "mvp",
    description: "Parks the run and puts Approve / Reject on the card. Use before anything risky.",
    configSchema: z.object({
      columnId: z
        .string()
        .optional()
        .describe("Column the card waits in. Blank = the board's first waiting column"),
      message: z.string().describe("What you are being asked to approve"),
      showDiff: z.boolean().default(true),
      timeoutHours: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("After this, the run FAILS — it never auto-approves"),
    }),
    inputs: ["trigger.task"],
    outputs: ["approved", "comment"],
  },

  // ─────────────────────────────── github ─────────────────────────────
  {
    id: "read-issue",
    label: "Read issue",
    category: "github",
    phase: "mvp",
    description: "Fetches an issue's data into the run context.",
    configSchema: z.object({
      repo: interpolatable("owner/name"),
      issueNumber: interpolatable("e.g. {{ trigger.task.issueNumber }}"),
    }),
    inputs: [],
    outputs: ["issue"],
  },
  {
    id: "clone-repo",
    label: "Clone repo",
    category: "github",
    phase: "mvp",
    description: "Clones the repo into this run's isolated workspace.",
    configSchema: z.object({
      repo: interpolatable("owner/name"),
      ref: z.string().optional().describe("Branch or SHA to start from"),
    }),
    inputs: [],
    outputs: ["path", "headSha"],
  },
  {
    id: "create-branch",
    label: "Create branch",
    category: "github",
    phase: "mvp",
    description: "Creates and checks out a branch, usually named from the card.",
    configSchema: z.object({
      repo: interpolatable("owner/name"),
      branchName: interpolatable("e.g. task/{{ trigger.task.id }}"),
      fromRef: z.string().optional(),
    }),
    inputs: [],
    outputs: ["branch"],
  },
  {
    id: "commit-changes",
    label: "Commit & push",
    category: "github",
    phase: "mvp",
    description: "Commits the agent's changes and pushes the branch.",
    configSchema: z.object({
      repo: interpolatable("owner/name"),
      branch: interpolatable("Branch to push"),
      message: interpolatable("Commit message"),
    }),
    inputs: [],
    outputs: ["commitSha", "pushed"],
  },
  {
    id: "open-pr",
    label: "Open PR",
    category: "github",
    phase: "mvp",
    description: "Opens a pull request for the pushed branch.",
    configSchema: z.object({
      repo: interpolatable("owner/name"),
      head: interpolatable("Branch with the changes"),
      base: z.string().default("main"),
      title: interpolatable("PR title"),
      body: z.string().optional().describe("PR body, interpolatable"),
    }),
    inputs: [],
    outputs: ["prNumber", "prUrl"],
  },
  {
    id: "wait-for-checks",
    label: "Wait for checks",
    category: "github",
    phase: "later",
    description: "Waits for GitHub Actions to finish. This is how agents run tests.",
    configSchema: z.object({
      repo: interpolatable("owner/name"),
      ref: interpolatable("Commit SHA or branch"),
      requiredChecks: z
        .array(z.string())
        .optional()
        .describe("Only these checks gate the run. Blank = every check must pass."),
      timeoutSec: z.number().int().positive().default(1800),
    }),
    inputs: [],
    outputs: ["conclusion", "checks"],
  },
  {
    id: "merge-pr",
    label: "Merge PR",
    category: "github",
    phase: "later",
    description: "Merges a PR — only with green checks. Put an approval gate before this.",
    configSchema: z.object({
      repo: interpolatable("owner/name"),
      prNumber: interpolatable("PR number"),
      method: z.enum(["merge", "squash", "rebase"]).default("squash"),
    }),
    inputs: [],
    outputs: ["merged", "mergeSha"],
  },

  // ─────────────────────────────── deploy ─────────────────────────────
  {
    id: "deploy-vercel",
    label: "Deploy to Vercel",
    category: "deploy",
    phase: "later",
    description: "Triggers a Vercel deployment.",
    configSchema: z.object({
      projectId: z.string().optional(),
      target: z.enum(["preview", "production"]).default("preview"),
    }),
    inputs: [],
    outputs: ["deploymentUrl", "state"],
  },
  {
    id: "deploy-netlify",
    label: "Deploy to Netlify",
    category: "deploy",
    phase: "later",
    description: "Triggers a Netlify deploy.",
    configSchema: z.object({
      siteId: z.string(),
      prod: z.boolean().default(false),
    }),
    inputs: [],
    outputs: ["deployUrl", "state"],
  },
] as const;

const BY_ID = new Map(NODE_TYPES.map((type) => [type.id, type]));

export function getNodeType(id: string): NodeTypeDef | undefined {
  return BY_ID.get(id);
}

export function nodeTypesByCategory(): Map<NodeCategory, NodeTypeDef[]> {
  const grouped = new Map<NodeCategory, NodeTypeDef[]>();
  for (const type of NODE_TYPES) {
    const list = grouped.get(type.category) ?? [];
    list.push(type);
    grouped.set(type.category, list);
  }
  return grouped;
}

export const CATEGORY_LABELS: Record<NodeCategory, string> = {
  trigger: "Triggers",
  flow: "Flow",
  agent: "Agent",
  board: "Board",
  github: "GitHub",
  deploy: "Deploy",
};

/**
 * A new node's starting config: every schema default, nothing invented.
 *
 * Parsing `{}` would not do — a schema with any required field fails outright
 * and we would lose the optional fields' defaults with it. Required fields
 * simply start absent, and the editor flags them.
 */
export function defaultConfigFor(typeId: string): Record<string, unknown> {
  const type = getNodeType(typeId);
  if (!type) return {};

  const config: Record<string, unknown> = {};
  for (const field of fieldsFromSchema(type.configSchema)) {
    if (field.defaultValue !== undefined) config[field.name] = field.defaultValue;
  }
  return config;
}
