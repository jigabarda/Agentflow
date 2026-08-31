import { NextResponse } from "next/server";
import { z } from "zod";
import { decideApproval } from "@/data/approvals";

const decisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  comment: z.string().max(2000).optional(),
});

/**
 * Approve or reject a parked run.
 *
 * Approving re-queues the run — the worker picks it up and resumes at the gate
 * with its context intact. Rejecting records the verdict and re-queues too, so
 * the run fails through the normal path with your comment as its reason (and
 * the card's failure rule still applies).
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  const parsed = decisionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Approve or reject?" }, { status: 400 });
  }

  const result = await decideApproval(id, parsed.data.decision, parsed.data.comment ?? null);

  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: result.status });
  }

  return NextResponse.json({ runId: id, state: result.state });
}
