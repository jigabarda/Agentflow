import { NextResponse } from "next/server";
import { z } from "zod";
import { seedCrew } from "@/data/crew";

const seedSchema = z.object({
  repo: z.string().min(3),
  // No defaults: the user picks the provider and every model (docs/AGENTS.md).
  provider: z.string().min(1),
  models: z.object({
    triager: z.string().min(1),
    planner: z.string().min(1),
    implementer: z.string().min(1),
    reviewer: z.string().min(1),
  }),
  maxReviewRounds: z.number().int().positive().max(10).optional(),
  name: z.string().min(1).optional(),
});

/** Build the four-role crew pipeline and bind it to this board's working column. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  const parsed = seedSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "A repo, a provider and a model for each of the four roles are required." },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(await seedCrew({ boardId: id, ...parsed.data }), { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not seed the crew." },
      { status: 422 },
    );
  }
}
