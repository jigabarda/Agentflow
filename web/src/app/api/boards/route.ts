import { NextResponse } from "next/server";
import { z } from "zod";
import { createBoard, listBoards } from "@/data/boards";

export async function GET() {
  return NextResponse.json(await listBoards());
}

const createSchema = z.object({ name: z.string().min(1) });

export async function POST(request: Request) {
  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "A board needs a name." }, { status: 400 });
  }

  const board = await createBoard(parsed.data.name);
  return NextResponse.json(board, { status: 201 });
}
