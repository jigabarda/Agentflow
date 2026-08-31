import { NextResponse } from "next/server";
import { retryRun } from "@/data/retry";

/**
 * Retry a failed run from the step that failed.
 *
 * Everything that already succeeded is kept, so a retry costs one step rather
 * than a whole pipeline — which matters when step three was an agent.
 */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const result = await retryRun(id);

  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: result.status });
  }

  return NextResponse.json({ runId: id, resumingFrom: result.resumingFrom });
}
