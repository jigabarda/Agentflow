"use client";

import { useState } from "react";
import Link from "next/link";
import { Play } from "lucide-react";
import type { TodayItem } from "@/data/today";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * One pile on the Today screen.
 *
 * Every row is one click from doing something about it: run it, approve it, or
 * open the card where it lives. A list you can only read is a worse version of
 * the board.
 */

const PRIORITY_TONE: Record<string, string> = {
  low: "text-muted-foreground/50",
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
      <h2 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {label} <span className="text-muted-foreground/60">({items.length})</span>
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
      className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-2.5 py-2 text-sm shadow-xs transition-shadow hover:shadow-md"
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
        <Badge variant="secondary" className="font-normal">
          repeats
        </Badge>
      )}

      <span className="text-[11px] text-muted-foreground">
        {item.boardName} · {item.columnName}
      </span>

      {item.dueAt && (
        <span className="text-[11px] text-muted-foreground">{formatDue(item.dueAt)}</span>
      )}

      {item.runStatus && (
        <Badge variant="outline" data-run-status={item.runStatus} className="font-normal">
          {item.runStatus.replace("_", " ")}
        </Badge>
      )}

      {item.bucket === "waiting" && item.runId ? (
        <span className="flex gap-1">
          <Button
            size="sm"
            data-testid={`today-approve-${item.taskId}`}
            disabled={busy}
            onClick={() => void post(`/api/runs/${item.runId}/approve`, { decision: "approve" })}
            className="h-6 bg-emerald-600 px-2 text-[11px] text-white hover:bg-emerald-700"
          >
            Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid={`today-reject-${item.taskId}`}
            disabled={busy}
            onClick={() => void post(`/api/runs/${item.runId}/approve`, { decision: "reject" })}
            className="h-6 px-2 text-[11px]"
          >
            Reject
          </Button>
        </span>
      ) : (
        <Button
          size="sm"
          data-testid={`today-run-${item.taskId}`}
          disabled={busy || !item.runnable}
          title={item.runnable ? "Run this card's pipeline" : "This column runs no pipeline"}
          onClick={() => void post(`/api/tasks/${item.taskId}/run`, {})}
          className="h-6 gap-1 px-2 text-[11px]"
        >
          <Play className="size-2.5" aria-hidden />
          Run
        </Button>
      )}

      {message && <span className="w-full text-[11px] text-destructive">{message}</span>}
    </li>
  );
}
