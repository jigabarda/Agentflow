"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

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
  pending: "text-neutral-400",
  running: "text-sky-600",
  succeeded: "text-emerald-600",
  failed: "text-red-600",
  skipped: "text-neutral-400",
};

const STEP_ICON: Record<string, string> = {
  pending: "○",
  running: "⚙",
  succeeded: "✓",
  failed: "✗",
  skipped: "–",
};

const LOG_TONE: Record<string, string> = {
  debug: "text-neutral-400",
  info: "text-neutral-600 dark:text-neutral-300",
  warn: "text-amber-600",
  error: "text-red-600",
};

const REFRESH_MS = 1000;

export function RunLive({
  runId,
  live,
  steps,
  logs,
}: {
  runId: string;
  live: boolean;
  steps: StepView[];
  logs: LogView[];
}) {
  const router = useRouter();
  const [showLogs, setShowLogs] = useState(true);

  useEffect(() => {
    if (!live) return;
    // The server component re-renders with fresh rows; no client fetching.
    const timer = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [live, router, runId]);

  return (
    <>
      <section className="mb-6">
        <h2 className="mb-2 text-xs font-medium text-neutral-600 dark:text-neutral-400">Steps</h2>
        <ol data-testid="run-steps" className="space-y-1">
          {steps.map((step) => (
            <li key={step.id} className="flex items-baseline gap-2 text-sm">
              <span className={STEP_TONE[step.status] ?? ""}>{STEP_ICON[step.status] ?? "○"}</span>
              <span className="font-mono text-xs">{step.nodeId}</span>
              <span className={`text-xs ${STEP_TONE[step.status] ?? ""}`}>{step.status}</span>
              {step.error && <span className="text-xs text-red-600">{step.error}</span>}
            </li>
          ))}
          {steps.length === 0 && <li className="text-xs text-neutral-500">Not started yet.</li>}
        </ol>
      </section>

      <section>
        <button
          type="button"
          onClick={() => setShowLogs((open) => !open)}
          className="mb-2 text-xs font-medium text-neutral-600 hover:underline dark:text-neutral-400"
        >
          {showLogs ? "▾" : "▸"} Logs ({logs.length})
        </button>

        {showLogs && (
          <ol
            data-testid="run-logs"
            className="max-h-96 space-y-0.5 overflow-y-auto rounded bg-neutral-50 p-2 font-mono text-[11px] dark:bg-neutral-950"
          >
            {logs.map((entry) => (
              <li key={entry.id} className={LOG_TONE[entry.level] ?? ""}>
                {entry.nodeId ? `[${entry.nodeId}] ` : ""}
                {entry.message}
              </li>
            ))}
            {logs.length === 0 && <li className="text-neutral-500">No output yet.</li>}
          </ol>
        )}
      </section>
    </>
  );
}
