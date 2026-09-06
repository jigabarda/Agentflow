import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/data/client";
import { listLogs } from "@/data/runs";
import { Badge } from "@/components/ui/badge";
import { RunLive } from "./RunLive";

export const dynamic = "force-dynamic";

/**
 * One run, in detail: every step, every log line, and the PR it produced.
 *
 * Reachable from the card (the drawer links here), not only from a runs list —
 * a failure on the board must be one click from the reason for it.
 */
export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const run = await prisma.run.findUnique({
    where: { id },
    include: {
      steps: { orderBy: { startedAt: "asc" } },
      pipeline: { select: { id: true, name: true, maxTokensPerRun: true } },
      task: { select: { id: true, title: true, boardId: true, prUrl: true, prNumber: true } },
    },
  });
  if (!run) notFound();

  const logs = await listLogs(id);

  return (
    <main className="mx-auto max-w-4xl p-6">
      <nav className="mb-4 text-xs text-muted-foreground">
        <Link href={run.task ? `/?board=${run.task.boardId}` : "/"} className="hover:underline">
          ← Board
        </Link>
        {" · "}
        <Link href="/runs" className="hover:underline">
          All runs
        </Link>
        {run.task && (
          <>
            {" · "}
            <span className="text-foreground">{run.task.title}</span>
          </>
        )}
      </nav>

      <header className="mb-6 flex flex-wrap items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-tight">{run.pipeline.name}</h1>
        <Badge variant="secondary" data-testid="run-status" className="font-normal">
          {run.status}
        </Badge>
        <Link
          href={`/pipelines/${run.pipeline.id}`}
          className="text-xs text-primary hover:underline"
        >
          open pipeline
        </Link>
        <span data-testid="run-tokens" className="text-xs text-muted-foreground">
          {run.tokensUsed.toLocaleString()} tokens
          {run.pipeline.maxTokensPerRun
            ? ` of ${run.pipeline.maxTokensPerRun.toLocaleString()}`
            : ""}
        </span>
        {run.task?.prUrl && (
          <a
            data-testid="run-pr-link"
            href={run.task.prUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-emerald-700 hover:underline dark:text-emerald-400"
          >
            🔗 PR {run.task.prNumber ? `#${run.task.prNumber}` : ""}
          </a>
        )}
      </header>

      {run.error && (
        <p
          data-testid="run-error"
          className="mb-6 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {run.error}
        </p>
      )}

      {/* Steps and logs refresh themselves while the run is still moving. */}
      <RunLive
        canRetry={run.status === "failed"}
        runId={run.id}
        live={run.status === "running" || run.status === "queued"}
        steps={run.steps.map((step) => ({
          id: step.id,
          nodeId: step.nodeId,
          status: step.status,
          error: step.error,
        }))}
        logs={logs.map((entry) => ({
          id: entry.id,
          level: entry.level,
          message: entry.message,
          nodeId: entry.nodeId,
          createdAt: entry.createdAt.toISOString(),
        }))}
      />
    </main>
  );
}
