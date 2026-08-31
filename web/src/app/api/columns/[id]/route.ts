import { NextResponse } from "next/server";
import { updateColumn } from "@/data/boards";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return NextResponse.json(await updateColumn(id, await request.json()));
}
