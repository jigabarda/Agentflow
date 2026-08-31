import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/data/client";
import { listLogs } from "@/data/runs";
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
      pipeline: { select: { id: true, name: true } },
      task: { select: { id: true, title: true, boardId: true, prUrl: true, prNumber: true } },
    },
  });
  if (!run) notFound();

  const logs = await listLogs(id);

  return (
    <main className="mx-auto max-w-4xl p-6">
      <nav className="mb-4 text-xs text-neutral-500">
        <Link href={run.task ? `/?board=${run.task.boardId}` : "/"} className="hover:underline">
          ← Board
        </Link>
        {run.task && (
          <>
            {" · "}
            <span className="text-neutral-700 dark:text-neutral-300">{run.task.title}</span>
          </>
        )}
      </nav>

      <header className="mb-6 flex flex-wrap items-baseline gap-3">
        <h1 className="text-lg font-semibold">{run.pipeline.name}</h1>
        <span
          data-testid="run-status"
          className="rounded bg-neutral-100 px-2 py-0.5 text-xs dark:bg-neutral-800"
        >
          {run.status}
        </span>
        <Link
          href={`/pipelines/${run.pipeline.id}`}
          className="text-xs text-sky-600 hover:underline"
        >
          open pipeline
        </Link>
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
          className="mb-6 rounded border border-red-200 bg-red-50 p-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        >
          {run.error}
        </p>
      )}

      {/* Steps and logs refresh themselves while the run is still moving. */}
      <RunLive
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
