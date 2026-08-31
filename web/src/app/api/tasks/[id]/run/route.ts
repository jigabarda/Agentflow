import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/data/client";
import { startRunForTask } from "@/data/automation";
import { getTask } from "@/data/tasks";

const runSchema = z.object({
  /** Defaults to whatever the card's own column automates. */
  pipelineId: z.string().min(1).optional(),
});

/**
 * ▶ Run now — the drawer's button.
 *
 * Same path as a drag into an automated column, just started deliberately.
 * Like every board action, this writes a `queued` row and nothing else.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  const body = await request.json().catch(() => ({}));
  const parsed = runSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "Which pipeline should run?" }, { status: 400 });
  }

  const task = await getTask(id);
  if (!task) return NextResponse.json({ error: "Card not found." }, { status: 404 });

  let pipelineId = parsed.data.pipelineId;
  if (!pipelineId) {
    const column = await prisma.boardColumn.findUnique({
      where: { id: task.columnId },
      select: { pipelineId: true, name: true },
    });
    if (!column?.pipelineId) {
      return NextResponse.json(
        { error: `${column?.name ?? "This column"} does not run a pipeline.` },
        { status: 422 },
      );
    }
    pipelineId = column.pipelineId;
  }

  const outcome = await startRunForTask(task, pipelineId, { via: "manual" });
  if (!outcome.started) {
    return NextResponse.json({ error: outcome.reason }, { status: 422 });
  }

  return NextResponse.json({ runId: outcome.runId }, { status: 201 });
}
