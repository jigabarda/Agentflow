import { NextResponse } from "next/server";
import { z } from "zod";
import { seedGoldenLoop } from "@/data/goldenLoop";

const seedSchema = z.object({
  repo: z.string().min(3),
  // No defaults: the user picks the provider and model, always (docs/AGENTS.md).
  provider: z.string().min(1),
  model: z.string().min(1),
  effort: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
});

/** Build the golden-loop pipeline and bind it to this board's working column. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  const parsed = seedSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "A repo, a provider and a model are all required." },
      { status: 400 },
    );
  }

  try {
    const result = await seedGoldenLoop({ boardId: id, ...parsed.data });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not seed the loop." },
      { status: 422 },
    );
  }
}
