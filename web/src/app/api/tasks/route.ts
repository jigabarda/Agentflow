import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { createTask } from "@/data/tasks";

export async function POST(request: Request) {
  try {
    const task = await createTask(await request.json());
    return NextResponse.json(task, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json({ error: error.issues[0]?.message }, { status: 400 });
    }
    throw error;
  }
}
