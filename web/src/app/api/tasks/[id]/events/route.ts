import { NextResponse } from "next/server";
import { appendTaskEvent, listTaskEvents } from "@/data/tasks";
import { z } from "zod";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return NextResponse.json(await listTaskEvents(id));
}

const commentSchema = z.object({ message: z.string().min(1) });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  const parsed = commentSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Say something first." }, { status: 400 });
  }

  const event = await appendTaskEvent(id, {
    actor: "user",
    kind: "commented",
    message: parsed.data.message,
  });
  return NextResponse.json(event, { status: 201 });
}
