import { NextResponse } from "next/server";
import { getRun, listLogs } from "@/data/runs";

/** Run detail: status, per-step state, and the log stream. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  const run = await getRun(id);
  if (!run) return NextResponse.json({ error: "Run not found." }, { status: 404 });

  return NextResponse.json({ ...run, logs: await listLogs(id) });
}
