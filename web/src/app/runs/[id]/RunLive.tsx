"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The moving parts of the run page.
 *
 * A finished run is static, so this refreshes only while one is still going —
 * a completed run costs nothing to look at.
 */

export interface StepView {
  id: string;
  nodeId: string;
  status: string;
  error: string | null;
}

export interface LogView {
  id: string;
  level: string;
  message: string;
  nodeId: string | null;
  createdAt: string;
}

const STEP_TONE: Record<string, string> = {
  pending: "text-muted-foreground",
  running: "text-sky-600 dark:text-sky-400",
  succeeded: "text-emerald-600 dark:text-emerald-400",
  failed: "text-destructive",
  skipped: "text-muted-foreground/60",
};

const STEP_ICON: Record<string, string> = {
  pending: "○",
  running: "⚙",
  succeeded: "✓",
  failed: "✗",
  skipped: "–",
};

const LOG_TONE: Record<string, string> = {
  debug: "text-muted-foreground/70",
  info: "text-foreground/80",
  warn: "text-amber-600 dark:text-amber-400",
  error: "text-destructive",
};

const REFRESH_MS = 1000;

export function RunLive({
  runId,
  live,
  canRetry,
  steps,
  logs,
}: {
  runId: string;
  live: boolean;
  /** Only a failed run can be retried. */
  canRetry: boolean;
  steps: StepView[];
  logs: LogView[];
}) {
  const router = useRouter();
  const [showLogs, setShowLogs] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  async function retry() {
    setRetrying(true);
    setRetryError(null);
    try {
      const response = await fetch(`/api/runs/${runId}/retry`, { method: "POST" });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setRetryError(payload.error ?? "That did not work.");
        return;
      }
      router.refresh();
    } finally {
      setRetrying(false);
    }
  }

  useEffect(() => {
    if (!live) return;
    // The server component re-renders with fresh rows; no client fetching.
    const timer = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [live, router, runId]);

  return (
    <>
      {canRetry && (
        <section className="mb-6">
          <Button
            size="sm"
            data-testid="run-retry"
            disabled={retrying}
            onClick={() => void retry()}
            className="h-7 text-xs"
          >
            Retry from the failed step
          </Button>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Everything that already succeeded is kept, so this re-runs the step that broke and
            nothing before it.
          </p>
          {retryError && <p className="mt-1 text-[11px] text-destructive">{retryError}</p>}
        </section>
      )}

      <section className="mb-6">
        <h2 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Steps
        </h2>
        <ol data-testid="run-steps" className="space-y-1">
          {steps.map((step) => (
            <li key={step.id} className="flex items-baseline gap-2 text-sm">
              <span className={STEP_TONE[step.status] ?? ""}>{STEP_ICON[step.status] ?? "○"}</span>
              <span className="font-mono text-xs">{step.nodeId}</span>
              <span className={cn("text-xs", STEP_TONE[step.status])}>{step.status}</span>
              {step.error && <span className="text-xs text-destructive">{step.error}</span>}
            </li>
          ))}
          {steps.length === 0 && (
            <li className="text-xs text-muted-foreground">Not started yet.</li>
          )}
        </ol>
      </section>

      <section>
        <button
          type="button"
          onClick={() => setShowLogs((open) => !open)}
          className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase hover:underline"
        >
          {showLogs ? "▾" : "▸"} Logs ({logs.length})
        </button>

        {showLogs && (
          <ol
            data-testid="run-logs"
            className="max-h-96 space-y-0.5 overflow-y-auto rounded-lg border bg-muted/40 p-2 font-mono text-[11px]"
          >
            {logs.map((entry) => (
              <li key={entry.id} className={LOG_TONE[entry.level] ?? ""}>
                {entry.nodeId ? `[${entry.nodeId}] ` : ""}
                {entry.message}
              </li>
            ))}
            {logs.length === 0 && <li className="text-muted-foreground">No output yet.</li>}
          </ol>
        )}
      </section>
    </>
  );
}
