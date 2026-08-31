import { NextResponse } from "next/server";
import { z } from "zod";
import { ColumnEntryRejected, moveTask } from "@/data/tasks";

const moveSchema = z.object({
  columnId: z.string().min(1),
  afterTaskId: z.string().min(1).nullish(),
  beforeTaskId: z.string().min(1).nullish(),
});

/**
 * Move a card.
 *
 * A move the board rules refuse is a 409 with a human reason — the client
 * rolls its optimistic move back and shows it. This route only writes rows;
 * the worker is what starts any run the destination column triggers.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  const parsed = moveSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Where should the card go?" }, { status: 400 });
  }

  try {
    const result = await moveTask(id, parsed.data);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ColumnEntryRejected) {
      return NextResponse.json({ error: error.reason }, { status: 409 });
    }
    throw error;
  }
}
