import { NextResponse } from "next/server";
import { z } from "zod";
import { createPipeline, listPipelines } from "@/data/pipelines";

export async function GET() {
  return NextResponse.json(await listPipelines());
}

const createSchema = z.object({ name: z.string().min(1) });

export async function POST(request: Request) {
  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "A pipeline needs a name." }, { status: 400 });
  }

  const pipeline = await createPipeline({ name: parsed.data.name });
  return NextResponse.json(pipeline, { status: 201 });
}
