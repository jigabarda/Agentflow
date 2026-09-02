import Link from "next/link";
import { costFraction } from "@agentflow/core";
import { listRuns, runTotals } from "@/data/runHistory";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, string> = {
  queued: "border-transparent bg-muted text-muted-foreground",
  running: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  awaiting_approval: "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  succeeded: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  failed: "border-destructive/30 bg-destructive/10 text-destructive",
  canceled: "border-transparent bg-muted text-muted-foreground",
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
      <header className="mb-4 flex flex-wrap items-baseline justify-between gap-3 border-b pb-3">
        <h1 className="text-lg font-semibold tracking-tight">Runs</h1>
        <p data-testid="runs-totals" className="text-xs text-muted-foreground">
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
              className={cn(
                "rounded-md px-2 py-1 text-xs transition-colors",
                active
                  ? "bg-primary font-medium text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {option.replace("_", " ")}
              {totals.byStatus[option] ? ` (${totals.byStatus[option]})` : ""}
            </Link>
          );
        })}
      </nav>

      {runs.length === 0 ? (
        <p data-testid="runs-empty" className="text-sm text-muted-foreground">
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
                className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-2.5 py-2 text-sm shadow-xs transition-shadow hover:shadow-md"
              >
                <Badge className={cn("font-normal", STATUS_TONE[run.status] ?? "")}>
                  {run.status.replace("_", " ")}
                </Badge>

                <Link href={`/runs/${run.id}`} className="min-w-0 flex-1 truncate hover:underline">
                  {run.taskTitle ?? run.pipelineName}
                </Link>

                <span className="text-[11px] text-muted-foreground">
                  {run.stepsDone}/{run.stepsTotal} steps
                </span>

                <span
                  data-testid={`run-tokens-${run.id}`}
                  title={
                    run.maxTokensPerRun
                      ? `Limit ${run.maxTokensPerRun.toLocaleString()} tokens`
                      : "This pipeline has no token limit"
                  }
                  className={cn(
                    "text-[11px]",
                    fraction !== null && fraction >= 0.9
                      ? "font-medium text-amber-600"
                      : "text-muted-foreground",
                  )}
                >
                  {run.tokensUsed.toLocaleString()}
                  {run.maxTokensPerRun ? ` / ${run.maxTokensPerRun.toLocaleString()}` : ""} tokens
                </span>

                <span className="text-[11px] text-muted-foreground/70">
                  {run.createdAt.toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>

                {run.error && (
                  <span className="w-full truncate text-[11px] text-destructive" title={run.error}>
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
