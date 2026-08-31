import { NextResponse } from "next/server";
import { checkRunReadiness } from "@agentflow/core";
import { z } from "zod";
import { agentProfileChoices } from "@/data/agentProfiles";
import { getPipeline } from "@/data/pipelines";
import { enqueueRun } from "@/data/runs";
import { listCredentialStates } from "@/data/secrets";
import { getTask } from "@/data/tasks";

const enqueueSchema = z.object({
  pipelineId: z.string().min(1),
  taskId: z.string().min(1).nullish(),
  trigger: z.unknown().optional(),
});

/**
 * Enqueue a run. The web app NEVER executes — it writes a `queued` row and the
 * worker picks it up (docs/ARCHITECTURE.md, boundary 6).
 */
export async function POST(request: Request) {
  const parsed = enqueueSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Which pipeline should run?" }, { status: 400 });
  }

  const pipeline = await getPipeline(parsed.data.pipelineId);
  if (!pipeline) return NextResponse.json({ error: "Pipeline not found." }, { status: 404 });

  // Refuse before spending anything: an invalid graph, or a provider with no
  // key on this pipeline, makes the run impossible (docs/AGENTS.md).
  const readiness = checkRunReadiness(
    pipeline,
    await listCredentialStates(pipeline.id),
    await agentProfileChoices(),
  );
  if (!readiness.ready) {
    return NextResponse.json(
      { error: readiness.problems[0]!.message, problems: readiness.problems },
      { status: 422 },
    );
  }

  // A board-triggered run carries the card as its trigger: the card IS the brief.
  let trigger = parsed.data.trigger ?? {};
  if (parsed.data.taskId) {
    const task = await getTask(parsed.data.taskId);
    if (!task) return NextResponse.json({ error: "Card not found." }, { status: 404 });
    trigger = {
      task: {
        id: task.id,
        title: task.title,
        body: task.body,
        labels: task.labels,
        priority: task.priority,
        repo: task.repo,
        issueNumber: task.issueNumber,
        dueAt: task.dueAt,
      },
    };
  }

  const run = await enqueueRun({
    pipelineId: pipeline.id,
    taskId: parsed.data.taskId ?? null,
    trigger,
  });
  return NextResponse.json(run, { status: 201 });
}
