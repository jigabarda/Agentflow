import Link from "next/link";
import { costFraction } from "@agentflow/core";
import { listRuns, runTotals } from "@/data/runHistory";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, string> = {
  queued: "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  running: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  awaiting_approval: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300",
  succeeded: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  canceled: "bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400",
};

/**
 * Queued is included deliberately: when nothing seems to be happening, "is the
 * worker running?" is the first question, and a pile of queued runs is the
 * answer.
 */
const FILTERS = ["all", "queued", "running", "awaiting_approval", "failed", "succeeded"] as const;

/**
 * The run dashboard.
 *
 * Three questions, three columns: what is happening now, what went wrong, and
 * what did it cost. Anything else belongs on the run's own page.
 */
export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const filter = status && status !== "all" ? status : undefined;

  const [runs, totals] = await Promise.all([
    listRuns(filter ? { status: filter } : {}),
    runTotals(),
  ]);

  return (
    <main className="mx-auto max-w-5xl p-6">
      <header className="mb-4 flex flex-wrap items-baseline justify-between gap-3 border-b border-neutral-200 pb-3 dark:border-neutral-800">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold">Runs</h1>
          <Link href="/" className="text-xs text-sky-600 hover:underline">
            board
          </Link>
          <Link href="/settings/secrets" className="text-xs text-sky-600 hover:underline">
            secrets
          </Link>
        </div>
        <p data-testid="runs-totals" className="text-xs text-neutral-500">
          {totals.tokensToday.toLocaleString()} tokens today
        </p>
      </header>

      <nav className="mb-4 flex flex-wrap gap-1">
        {FILTERS.map((option) => {
          const active = (status ?? "all") === option;
          return (
            <Link
              key={option}
              href={option === "all" ? "/runs" : `/runs?status=${option}`}
              data-testid={`runs-filter-${option}`}
              className={[
                "rounded px-2 py-0.5 text-xs",
                active
                  ? "bg-sky-600 text-white"
                  : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300",
              ].join(" ")}
            >
              {option.replace("_", " ")}
              {totals.byStatus[option] ? ` (${totals.byStatus[option]})` : ""}
            </Link>
          );
        })}
      </nav>

      {runs.length === 0 ? (
        <p data-testid="runs-empty" className="text-sm text-neutral-500">
          No runs{filter ? ` with status "${filter}"` : " yet"}. Drag a card into an automated
          column to start one.
        </p>
      ) : (
        <ul data-testid="runs-list" className="space-y-1">
          {runs.map((run) => {
            const fraction = costFraction(run.tokensUsed, run.maxTokensPerRun);

            return (
              <li
                key={run.id}
                data-testid={`run-row-${run.id}`}
                data-run-status={run.status}
                className="flex flex-wrap items-center gap-2 rounded border border-neutral-200 bg-white px-2 py-1.5 text-sm dark:border-neutral-800 dark:bg-neutral-900"
              >
                <span className={`rounded px-1 text-[10px] ${STATUS_TONE[run.status] ?? ""}`}>
                  {run.status.replace("_", " ")}
                </span>

                <Link href={`/runs/${run.id}`} className="min-w-0 flex-1 truncate hover:underline">
                  {run.taskTitle ?? run.pipelineName}
                </Link>

                <span className="text-[11px] text-neutral-500">
                  {run.stepsDone}/{run.stepsTotal} steps
                </span>

                <span
                  data-testid={`run-tokens-${run.id}`}
                  title={
                    run.maxTokensPerRun
                      ? `Limit ${run.maxTokensPerRun.toLocaleString()} tokens`
                      : "This pipeline has no token limit"
                  }
                  className={[
                    "text-[11px]",
                    fraction !== null && fraction >= 0.9 ? "text-amber-600" : "text-neutral-500",
                  ].join(" ")}
                >
                  {run.tokensUsed.toLocaleString()}
                  {run.maxTokensPerRun ? ` / ${run.maxTokensPerRun.toLocaleString()}` : ""} tokens
                </span>

                <span className="text-[11px] text-neutral-400">
                  {run.createdAt.toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>

                {run.error && (
                  <span className="w-full truncate text-[11px] text-red-600" title={run.error}>
                    {run.error}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
