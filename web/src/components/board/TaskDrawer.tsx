"use client";

import { useState } from "react";
import Link from "next/link";
import type { Task, TaskPriority } from "@agentflow/core";
import { ExternalLink, GitPullRequest, Play, Send, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { RecurrenceEditor } from "./RecurrenceEditor";
import { Timeline } from "./Timeline";
import { useBoardStore } from "./boardStore";

const PRIORITIES: TaskPriority[] = ["low", "normal", "high", "urgent"];

/**
 * A native <select> styled to match the rest.
 *
 * Deliberately not the Radix Select: a native control is what mobile and
 * keyboard users get for free, and it is what `selectOption` drives in the E2E
 * suite. The styling gap is not worth the churn.
 */
const selectClass = cn(
  "h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs",
  "outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
);

/** A small section heading, used down the drawer. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </h3>
  );
}

/**
 * The card, opened over the board so you never lose your place.
 *
 * Not a modal Sheet on purpose: the board stays visible and clickable behind
 * it. An overlay that dims the board would undo the reason this is a drawer
 * rather than a page (docs/BOARD.md).
 *
 * The body is labelled as the agent's brief on purpose: it IS the prompt input
 * a `task-trigger` pipeline hands to its agents.
 */
export function TaskDrawer({ task }: { task: Task }) {
  const events = useBoardStore((state) => state.events);
  const updateTask = useBoardStore((state) => state.updateTask);
  const openDrawer = useBoardStore((state) => state.openDrawer);
  const columns = useBoardStore((state) => state.columns);
  const runs = useBoardStore((state) => state.runs);
  const runNow = useBoardStore((state) => state.runNow);
  const decide = useBoardStore((state) => state.decide);

  const column = columns.find((item) => item.id === task.columnId);
  const run = runs[task.id];

  // Seeded once per card: the caller keys this component by task id, so opening
  // a different card remounts it rather than syncing state in an effect.
  const [title, setTitle] = useState(task.title);
  const [body, setBody] = useState(task.body ?? "");
  const [comment, setComment] = useState("");

  async function postComment() {
    if (comment.trim() === "") return;
    await fetch(`/api/tasks/${task.id}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: comment.trim() }),
    });
    setComment("");
    await useBoardStore.getState().reloadEvents(task.id);
  }

  return (
    <aside
      data-testid="task-drawer"
      aria-label={`Card: ${task.title}`}
      className="fixed top-0 right-0 z-20 flex h-full w-[27rem] flex-col overflow-y-auto border-l bg-background p-4 shadow-2xl"
    >
      <div className="mb-4 flex items-start gap-2">
        <Input
          data-testid="drawer-title"
          value={title}
          aria-label="Card title"
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => title !== task.title && void updateTask(task.id, { title })}
          className="h-auto border-transparent bg-transparent px-1.5 py-1 text-base font-semibold shadow-none hover:border-input"
        />
        <Button
          variant="ghost"
          size="icon"
          data-testid="close-drawer"
          onClick={() => void openDrawer(null)}
          aria-label="Close"
          className="shrink-0 text-muted-foreground"
        >
          <X className="size-4" aria-hidden />
        </Button>
      </div>

      <section data-testid="drawer-automation" className="mb-4 rounded-lg border p-3">
        <SectionLabel>Automation</SectionLabel>

        <p className="text-xs text-muted-foreground">
          {column?.pipelineId
            ? `Cards entering ${column.name} run a pipeline.`
            : `${column?.name ?? "This column"} does not run a pipeline.`}
        </p>

        {run && (
          <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            Latest run:
            <Badge variant="secondary" data-testid="drawer-run-status" className="font-normal">
              {run.status.replace("_", " ")}
            </Badge>
            {run.total > 0 && (
              <span>
                {run.done}/{run.total} steps
              </span>
            )}
            <Link
              href={`/runs/${run.runId}`}
              className="inline-flex items-center gap-0.5 text-primary hover:underline"
            >
              open run
              <ExternalLink className="size-3" aria-hidden />
            </Link>
          </p>
        )}

        {run?.error && (
          <p className="mt-1.5 rounded border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive">
            {run.error}
          </p>
        )}

        <div className="mt-2.5 flex flex-wrap gap-2">
          <Button
            size="sm"
            data-testid="drawer-run-now"
            disabled={!column?.pipelineId}
            onClick={() => void runNow(task.id)}
            className="h-7 gap-1.5 text-xs"
          >
            <Play className="size-3" aria-hidden />
            Run now
          </Button>

          {run?.awaitingApproval && (
            <>
              <Button
                size="sm"
                data-testid="drawer-approve"
                onClick={() => void decide(run.runId, "approve", comment.trim() || undefined)}
                className="h-7 bg-emerald-600 text-xs text-white hover:bg-emerald-700"
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                data-testid="drawer-reject"
                onClick={() => void decide(run.runId, "reject", comment.trim() || undefined)}
                className="h-7 text-xs"
              >
                Reject
              </Button>
            </>
          )}
        </div>

        {run?.awaitingApproval && (
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Your comment below is sent with the decision.
          </p>
        )}
      </section>

      <RecurrenceEditor
        recurrence={task.recurrence ?? null}
        timezone={task.recurrenceTz ?? null}
        onChange={(recurrence, recurrenceTz) =>
          void updateTask(task.id, { recurrence, recurrenceTz })
        }
      />

      {task.prUrl && (
        <section className="mb-4">
          <SectionLabel>Artifacts</SectionLabel>
          <a
            data-testid="drawer-pr-link"
            href={task.prUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
          >
            <GitPullRequest className="size-3.5" aria-hidden />
            Pull request {task.prNumber ? `#${task.prNumber}` : ""}
            <ExternalLink className="size-3 opacity-60" aria-hidden />
          </a>
        </section>
      )}

      <section className="mb-4">
        <Label htmlFor="drawer-body" className="mb-1.5 text-xs text-muted-foreground">
          Brief — this is what the agent reads
        </Label>
        <Textarea
          id="drawer-body"
          data-testid="drawer-body"
          rows={8}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          onBlur={() => body !== (task.body ?? "") && void updateTask(task.id, { body })}
          placeholder={"## What to do\n1. …"}
          className="font-mono text-xs"
        />
      </section>

      <section className="mb-4 grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="drawer-priority" className="mb-1.5 text-xs text-muted-foreground">
            Priority
          </Label>
          <select
            id="drawer-priority"
            data-testid="drawer-priority"
            value={task.priority}
            onChange={(event) => void updateTask(task.id, { priority: event.target.value })}
            className={selectClass}
          >
            {PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {priority}
              </option>
            ))}
          </select>
        </div>

        <div>
          <Label htmlFor="drawer-repo" className="mb-1.5 text-xs text-muted-foreground">
            Repo
          </Label>
          <Input
            id="drawer-repo"
            data-testid="drawer-repo"
            defaultValue={task.repo ?? ""}
            placeholder="owner/name"
            onBlur={(event) => {
              const next = event.target.value.trim();
              if (next !== (task.repo ?? "")) void updateTask(task.id, { repo: next || null });
            }}
          />
        </div>

        <div className="col-span-2">
          <Label htmlFor="drawer-labels" className="mb-1.5 text-xs text-muted-foreground">
            Labels
          </Label>
          <Input
            id="drawer-labels"
            data-testid="drawer-labels"
            defaultValue={task.labels.join(", ")}
            placeholder="bug, auth"
            onBlur={(event) => {
              const labels = event.target.value
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean);
              if (labels.join() !== task.labels.join()) void updateTask(task.id, { labels });
            }}
          />
        </div>
      </section>

      <Separator className="mb-4" />

      <section className="flex min-h-0 flex-1 flex-col">
        <SectionLabel>Timeline</SectionLabel>
        <Timeline events={events} />

        <div className="mt-3 flex gap-2">
          <Input
            data-testid="drawer-comment"
            value={comment}
            aria-label="Add a note"
            onChange={(event) => setComment(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void postComment();
              }
            }}
            placeholder="Add a note…"
          />
          <Button
            size="icon"
            data-testid="post-comment"
            onClick={() => void postComment()}
            aria-label="Post note"
            className="shrink-0"
          >
            <Send className="size-4" aria-hidden />
          </Button>
        </div>
      </section>
    </aside>
  );
}
