import { prisma } from "./client";

/**
 * The golden loop, as a seed.
 *
 * Drag a card into "In progress" → agents implement it in a clone → a branch is
 * pushed and a PR opened → the card moves itself to "Review" with the PR
 * attached. This function builds that pipeline and binds it to the column, so
 * the loop is one click away instead of fifteen minutes on the canvas.
 *
 * It is deliberately a *starting point*: the model, the prompt and the base
 * branch are all node config, and the canvas is where they get changed.
 */

export interface SeedGoldenLoopInput {
  boardId: string;
  /** "owner/name" — the repo the agents work in. */
  repo: string;
  /** Which provider/model the implementer uses. There is no default. */
  provider: string;
  model: string;
  /** Effort level for the implementer. */
  effort?: string;
  name?: string;
}

export interface SeedGoldenLoopResult {
  pipelineId: string;
  workingColumnId: string;
  reviewColumnId: string;
}

const IMPLEMENTER_PROMPT = [
  "You are a senior engineer working in the repository cloned into your workspace.",
  "Implement the task below. Make the smallest correct change, and match the",
  "surrounding code's style and testing conventions.",
  "",
  "Task: {{ trigger.task.title }}",
  "",
  "{{ trigger.task.body }}",
].join("\n");

export async function seedGoldenLoop(input: SeedGoldenLoopInput): Promise<SeedGoldenLoopResult> {
  const columns = await prisma.boardColumn.findMany({
    where: { boardId: input.boardId },
    orderBy: { order: "asc" },
  });

  const working = columns.find((column) => column.kind === "working");
  const review = columns.find((column) => column.kind === "waiting");
  const todo = columns.find((column) => column.kind === "ready");

  if (!working || !review) {
    throw new Error(
      "The golden loop needs a `working` column to run in and a `waiting` column to return to.",
    );
  }

  const pipeline = await prisma.pipeline.create({
    data: {
      name: input.name ?? "Card → PR",
      variables: { create: [{ key: "repo", value: input.repo }] },
      nodes: {
        create: [
          {
            id: "trigger",
            type: "task-trigger",
            label: "Card enters",
            config: { requireLabels: [] },
            x: 0,
            y: 0,
          },
          {
            id: "clone",
            type: "clone-repo",
            label: "Clone repo",
            config: { repo: "{{ pipeline.vars.repo }}" },
            x: 220,
            y: 0,
          },
          {
            id: "branch",
            type: "create-branch",
            label: "Create branch",
            config: {
              repo: "{{ pipeline.vars.repo }}",
              branchName: "agentflow/{{ trigger.task.id }}",
            },
            x: 440,
            y: 0,
          },
          {
            id: "implementer",
            type: "agent",
            label: "Implementer",
            config: {
              provider: input.provider,
              model: input.model,
              effort: input.effort ?? "high",
              systemPrompt: "You implement tasks in a real repository. Be careful and minimal.",
              prompt: IMPLEMENTER_PROMPT,
              allowedTools: ["Read", "Glob", "Grep", "Write", "Edit"],
            },
            x: 660,
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
            x: 880,
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
              body: "{{ nodes.implementer.output.result }}",
            },
            x: 1100,
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
              comment: "Ready for review: {{ nodes.pr.output.prUrl }}",
              addLabels: [],
            },
            x: 1320,
            y: 0,
          },
        ],
      },
      edges: {
        create: [
          { id: "e1", source: "trigger", target: "clone" },
          { id: "e2", source: "clone", target: "branch" },
          { id: "e3", source: "branch", target: "implementer" },
          { id: "e4", source: "implementer", target: "commit" },
          { id: "e5", source: "commit", target: "pr" },
          { id: "e6", source: "pr", target: "handback" },
        ],
      },
    },
    select: { id: true },
  });

  // Bind it to the column. This is what makes the drag start anything at all.
  await prisma.boardColumn.update({
    where: { id: working.id },
    data: {
      pipelineId: pipeline.id,
      autoAdvance: {
        onRunSucceeded: review.id,
        // A failed run goes back to where you would pick it up again.
        ...(todo ? { onRunFailed: todo.id } : {}),
      },
    },
  });

  return { pipelineId: pipeline.id, workingColumnId: working.id, reviewColumnId: review.id };
}
