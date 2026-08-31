import { getRolePreset, REVIEW_BRANCHES } from "@/nodes/presets";
import { prisma } from "./client";

/**
 * The crew, as a seed.
 *
 * The golden loop has one implementer. This is the same shape with a team:
 * triage classifies, the planner splits the card into subtasks on the board,
 * the implementer writes the code, and the reviewer either approves or sends it
 * back — bounded, so it cannot argue with itself forever.
 *
 * The canvas has no control for marking an edge as a loop yet, so this seed is
 * currently the only way to build one. That is a gap worth closing, not a
 * design decision.
 */

export interface SeedCrewInput {
  boardId: string;
  repo: string;
  /** One provider for the whole crew; each role can be re-pointed afterwards. */
  provider: string;
  /** Per-role models. A cheap model for triage is the usual reason to differ. */
  models: {
    triager: string;
    planner: string;
    implementer: string;
    reviewer: string;
  };
  /** How many times the reviewer may send the work back. */
  maxReviewRounds?: number;
  name?: string;
}

export interface SeedCrewResult {
  pipelineId: string;
  workingColumnId: string;
  reviewColumnId: string;
  backlogColumnId: string;
}

function agentNode(
  id: string,
  role: "triager" | "planner" | "implementer" | "reviewer",
  provider: string,
  model: string,
  x: number,
) {
  const preset = getRolePreset(role)!;

  return {
    id,
    type: "agent",
    label: preset.label,
    config: {
      provider,
      model,
      effort: preset.suggestedEffort,
      systemPrompt: preset.systemPrompt,
      prompt: preset.prompt,
      allowedTools: [...preset.allowedTools],
    },
    x,
    y: 0,
  };
}

/**
 * The reviewer, wired to this pipeline.
 *
 * The preset's prompt is deliberately generic — it cannot know what the
 * implementer node is called. The seed does, so the seed is what hands the
 * reviewer the implementer's own report.
 */
function reviewerNode(provider: string, model: string) {
  const node = agentNode("review", "reviewer", provider, model, 1400);

  return {
    ...node,
    config: {
      ...node.config,
      prompt: [
        node.config.prompt,
        "",
        "What the implementer reported:",
        "{{ nodes.implement.output.result }}",
      ].join("\n"),
    },
  };
}

export async function seedCrew(input: SeedCrewInput): Promise<SeedCrewResult> {
  const columns = await prisma.boardColumn.findMany({
    where: { boardId: input.boardId },
    orderBy: { order: "asc" },
  });

  const working = columns.find((column) => column.kind === "working");
  const review = columns.find((column) => column.kind === "waiting");
  const backlog = columns.find((column) => column.kind === "backlog") ?? working;
  const todo = columns.find((column) => column.kind === "ready");

  if (!working || !review || !backlog) {
    throw new Error(
      "The crew needs a `working` column to run in, a `waiting` column to return to, and somewhere to put subtasks.",
    );
  }

  const pipeline = await prisma.pipeline.create({
    data: {
      name: input.name ?? "The crew",
      variables: { create: [{ key: "repo", value: input.repo }] },
      nodes: {
        create: [
          { id: "trigger", type: "task-trigger", label: "Card enters", config: {}, x: 0, y: 0 },
          agentNode("triage", "triager", input.provider, input.models.triager, 200),
          agentNode("plan", "planner", input.provider, input.models.planner, 400),
          {
            id: "subtasks",
            type: "create-task",
            label: "Create cards",
            config: { columnId: backlog.id, tasks: "{{ nodes.plan.output.result }}" },
            x: 600,
            y: 0,
          },
          {
            id: "clone",
            type: "clone-repo",
            label: "Clone repo",
            config: { repo: "{{ pipeline.vars.repo }}" },
            x: 800,
            y: 0,
          },
          {
            id: "branch",
            type: "create-branch",
            label: "Create branch",
            config: {
              repo: "{{ pipeline.vars.repo }}",
              branchName: "crew/{{ trigger.task.id }}",
            },
            x: 1000,
            y: 0,
          },
          agentNode("implement", "implementer", input.provider, input.models.implementer, 1200),
          reviewerNode(input.provider, input.models.reviewer),
          {
            id: "verdict",
            type: "condition",
            label: "Verdict",
            config: {
              expression: "{{ nodes.review.output.result }}",
              cases: [...REVIEW_BRANCHES],
              // An answer nobody can parse is treated as "not approved". The
              // safe default is more work, never a merge.
              default: "CHANGES",
            },
            x: 1600,
            y: 0,
          },
          {
            id: "commit",
            type: "commit-changes",
            label: "Commit & push",
            config: {
              repo: "{{ pipeline.vars.repo }}",
              branch: "{{ nodes.branch.output.branch }}",
              message: "{{ trigger.task.title }}",
            },
            x: 1800,
            y: 0,
          },
          {
            id: "pr",
            type: "open-pr",
            label: "Open PR",
            config: {
              repo: "{{ pipeline.vars.repo }}",
              head: "{{ nodes.branch.output.branch }}",
              title: "{{ trigger.task.title }}",
              body: "{{ nodes.implement.output.result }}",
            },
            x: 2000,
            y: 0,
          },
          {
            id: "handback",
            type: "update-task",
            label: "Back to you",
            config: {
              columnId: review.id,
              prNumber: "{{ nodes.pr.output.prNumber }}",
              prUrl: "{{ nodes.pr.output.prUrl }}",
              comment: "Reviewed and ready: {{ nodes.pr.output.prUrl }}",
              addLabels: [],
            },
            x: 2200,
            y: 0,
          },
        ],
      },
      edges: {
        create: [
          { id: "e1", source: "trigger", target: "triage" },
          { id: "e2", source: "triage", target: "plan" },
          { id: "e3", source: "plan", target: "subtasks" },
          { id: "e4", source: "subtasks", target: "clone" },
          { id: "e5", source: "clone", target: "branch" },
          { id: "e6", source: "branch", target: "implement" },
          { id: "e7", source: "implement", target: "review" },
          { id: "e8", source: "review", target: "verdict" },
          { id: "e9", source: "verdict", target: "commit", sourceHandle: "APPROVED" },
          {
            id: "e10",
            source: "verdict",
            target: "implement",
            sourceHandle: "CHANGES",
            loop: true,
            maxIterations: input.maxReviewRounds ?? 2,
          },
          { id: "e11", source: "commit", target: "pr" },
          { id: "e12", source: "pr", target: "handback" },
        ],
      },
    },
    select: { id: true },
  });

  await prisma.boardColumn.update({
    where: { id: working.id },
    data: {
      pipelineId: pipeline.id,
      autoAdvance: {
        onRunSucceeded: review.id,
        ...(todo ? { onRunFailed: todo.id } : {}),
      },
    },
  });

  return {
    pipelineId: pipeline.id,
    workingColumnId: working.id,
    reviewColumnId: review.id,
    backlogColumnId: backlog.id,
  };
}
