import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { archiveTask, getTask, updateTask } from "@/data/tasks";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const task = await getTask(id);
  if (!task) return NextResponse.json({ error: "Card not found." }, { status: 404 });
  return NextResponse.json(task);
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    return NextResponse.json(await updateTask(id, await request.json()));
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json({ error: error.issues[0]?.message }, { status: 400 });
    }
    throw error;
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return NextResponse.json(await archiveTask(id));
}
