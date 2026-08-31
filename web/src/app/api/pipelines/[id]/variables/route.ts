import { NextResponse } from "next/server";
import { z } from "zod";
import { getVariables, setVariable } from "@/data/pipelines";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return NextResponse.json(await getVariables(id));
}

const setSchema = z.object({ key: z.string().min(1), value: z.string() });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  const parsed = setSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "A variable needs a key." }, { status: 400 });
  }

  await setVariable(id, parsed.data.key, parsed.data.value);
  return NextResponse.json(await getVariables(id), { status: 201 });
}
