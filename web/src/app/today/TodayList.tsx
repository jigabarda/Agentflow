"use client";

import { useState } from "react";
import Link from "next/link";
import type { TodayItem } from "@/data/today";

/**
 * One pile on the Today screen.
 *
 * Every row is one click from doing something about it: run it, approve it, or
 * open the card where it lives. A list you can only read is a worse version of
 * the board.
 */

const PRIORITY_TONE: Record<string, string> = {
  low: "text-neutral-400",
  normal: "text-sky-500",
  high: "text-amber-500",
  urgent: "text-red-500",
};

function formatDue(dueAt: Date | null): string {
  if (!dueAt) return "";
  return new Date(dueAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function TodayList({ label, items }: { label: string; items: TodayItem[] }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500">
        {label} <span className="text-neutral-400">({items.length})</span>
      </h2>

      <ul
        data-testid={`today-group-${label.toLowerCase().replace(/\s+/g, "-")}`}
        className="space-y-1"
      >
        {items.map((item) => (
          <TodayRow key={item.taskId} item={item} />
        ))}
      </ul>
    </section>
  );
}

function TodayRow({ item }: { item: TodayItem }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function post(url: string, body: unknown) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setMessage(payload.error ?? "That did not work.");
        return;
      }
      // The page is server-rendered; a reload is the simplest honest refresh.
      window.location.reload();
    } catch {
      setMessage("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li
      data-testid={`today-${item.taskId}`}
      data-task-title={item.title}
      className="flex flex-wrap items-center gap-2 rounded border border-neutral-200 bg-white px-2 py-1.5 text-sm dark:border-neutral-800 dark:bg-neutral-900"
    >
      <span aria-hidden className={PRIORITY_TONE[item.priority] ?? PRIORITY_TONE.normal}>
        ●
      </span>

      <Link
        href={`/?board=${item.boardId}`}
        className="min-w-0 flex-1 truncate hover:underline"
        title={item.title}
      >
        {item.title}
      </Link>

      {item.isTemplate && (
        <span className="rounded bg-neutral-100 px-1 text-[10px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
          repeats
        </span>
      )}

      <span className="text-[11px] text-neutral-500">
        {item.boardName} · {item.columnName}
      </span>

      {item.dueAt && <span className="text-[11px] text-neutral-500">{formatDue(item.dueAt)}</span>}

      {item.runStatus && (
        <span data-run-status={item.runStatus} className="text-[11px] text-neutral-500">
          {item.runStatus}
        </span>
      )}

      {item.bucket === "waiting" && item.runId ? (
        <span className="flex gap-1">
          <button
            type="button"
            data-testid={`today-approve-${item.taskId}`}
            disabled={busy}
            onClick={() => void post(`/api/runs/${item.runId}/approve`, { decision: "approve" })}
            className="rounded bg-emerald-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            Approve
          </button>
          <button
            type="button"
            data-testid={`today-reject-${item.taskId}`}
            disabled={busy}
            onClick={() => void post(`/api/runs/${item.runId}/approve`, { decision: "reject" })}
            className="rounded border border-neutral-300 px-2 py-0.5 text-[11px] hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            Reject
          </button>
        </span>
      ) : (
        <button
          type="button"
          data-testid={`today-run-${item.taskId}`}
          disabled={busy || !item.runnable}
          title={item.runnable ? "Run this card's pipeline" : "This column runs no pipeline"}
          onClick={() => void post(`/api/tasks/${item.taskId}/run`, {})}
          className="rounded bg-sky-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-neutral-300 dark:disabled:bg-neutral-700"
        >
          ▶ Run
        </button>
      )}

      {message && <span className="w-full text-[11px] text-red-600">{message}</span>}
    </li>
  );
}
