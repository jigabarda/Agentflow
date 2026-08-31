import { NextResponse } from "next/server";
import { z } from "zod";
import { InvalidPipelineError, getPipeline, savePipelineGraph } from "@/data/pipelines";

const saveSchema = z.object({
  name: z.string().min(1),
  nodes: z
    .array(
      z.object({
        id: z.string().min(1),
        type: z.string().min(1),
        label: z.string().min(1),
        config: z.record(z.string(), z.unknown()).default({}),
        x: z.number(),
        y: z.number(),
      }),
    )
    .default([]),
  edges: z
    .array(
      z.object({
        id: z.string().min(1),
        source: z.string().min(1),
        target: z.string().min(1),
        sourceHandle: z.string().min(1).optional(),
      }),
    )
    .default([]),
});

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const pipeline = await getPipeline(id);
  if (!pipeline) return NextResponse.json({ error: "Pipeline not found." }, { status: 404 });
  return NextResponse.json(pipeline);
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  const parsed = saveSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  }

  try {
    return NextResponse.json(await savePipelineGraph(id, parsed.data));
  } catch (error) {
    // An invalid graph is a user-fixable problem, not a server fault: hand back
    // every issue so the editor can flag the exact nodes.
    if (error instanceof InvalidPipelineError) {
      return NextResponse.json(
        { error: error.message, issues: error.validation.issues },
        { status: 422 },
      );
    }
    throw error;
  }
}
