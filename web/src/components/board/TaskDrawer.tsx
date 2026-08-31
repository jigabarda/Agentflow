"use client";

import { useState } from "react";
import Link from "next/link";
import type { Task, TaskPriority } from "@agentflow/core";
import { RecurrenceEditor } from "./RecurrenceEditor";
import { Timeline } from "./Timeline";
import { useBoardStore } from "./boardStore";

const inputClass =
  "w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-900 " +
  "focus:border-sky-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100";

const PRIORITIES: TaskPriority[] = ["low", "normal", "high", "urgent"];

/**
 * The card, opened over the board so you never lose your place.
 *
 * The body is labelled as the agent's brief on purpose: it IS the prompt input
 * a `task-trigger` pipeline hands to its agents (docs/BOARD.md).
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
      className="fixed right-0 top-0 z-20 flex h-full w-[26rem] flex-col overflow-y-auto border-l border-neutral-200 bg-white p-4 shadow-xl dark:border-neutral-800 dark:bg-neutral-900"
    >
      <div className="mb-3 flex items-start gap-2">
        <input
          data-testid="drawer-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => title !== task.title && void updateTask(task.id, { title })}
          className="flex-1 rounded border border-transparent px-1 py-1 text-base font-semibold hover:border-neutral-300 focus:border-sky-500 focus:outline-none dark:bg-neutral-900 dark:hover:border-neutral-700"
        />
        <button
          type="button"
          data-testid="close-drawer"
          onClick={() => void openDrawer(null)}
          aria-label="Close"
          className="rounded px-2 py-1 text-sm text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          ✕
        </button>
      </div>

      <section
        data-testid="drawer-automation"
        className="mb-4 rounded border border-neutral-200 p-2 dark:border-neutral-800"
      >
        <h3 className="mb-1 text-xs font-medium text-neutral-600 dark:text-neutral-400">
          Automation
        </h3>

        <p className="text-xs text-neutral-500">
          {column?.pipelineId
            ? `Cards entering ${column.name} run a pipeline.`
            : `${column?.name ?? "This column"} does not run a pipeline.`}
        </p>

        {run && (
          <p className="mt-1 text-xs text-neutral-500">
            Latest run: <span data-testid="drawer-run-status">{run.status}</span>{" "}
            {run.total > 0 && `· ${run.done}/${run.total} steps`}{" "}
            <Link href={`/runs/${run.runId}`} className="text-sky-600 hover:underline">
              open run
            </Link>
          </p>
        )}

        {run?.error && <p className="mt-1 text-xs text-red-600">{run.error}</p>}

        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="drawer-run-now"
            disabled={!column?.pipelineId}
            onClick={() => void runNow(task.id)}
            className="rounded bg-sky-600 px-2 py-1 text-xs font-medium text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-neutral-300 dark:disabled:bg-neutral-700"
          >
            ▶ Run now
          </button>

          {run?.awaitingApproval && (
            <>
              <button
                type="button"
                data-testid="drawer-approve"
                onClick={() => void decide(run.runId, "approve", comment.trim() || undefined)}
                className="rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-700"
              >
                Approve
              </button>
              <button
                type="button"
                data-testid="drawer-reject"
                onClick={() => void decide(run.runId, "reject", comment.trim() || undefined)}
                className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                Reject
              </button>
            </>
          )}
        </div>

        {run?.awaitingApproval && (
          <p className="mt-1 text-[11px] text-neutral-500">
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
          <h3 className="mb-1 text-xs font-medium text-neutral-600 dark:text-neutral-400">
            Artifacts
          </h3>
          <a
            data-testid="drawer-pr-link"
            href={task.prUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-sky-600 hover:underline"
          >
            🔗 Pull request {task.prNumber ? `#${task.prNumber}` : ""}
          </a>
        </section>
      )}

      <section className="mb-4">
        <label
          htmlFor="drawer-body"
          className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-400"
        >
          Brief — this is what the agent reads
        </label>
        <textarea
          id="drawer-body"
          data-testid="drawer-body"
          rows={8}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          onBlur={() => body !== (task.body ?? "") && void updateTask(task.id, { body })}
          placeholder={"## What to do\n1. …"}
          className={`${inputClass} font-mono text-xs`}
        />
      </section>

      <section className="mb-4 grid grid-cols-2 gap-2">
        <div>
          <label
            htmlFor="drawer-priority"
            className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-400"
          >
            Priority
          </label>
          <select
            id="drawer-priority"
            data-testid="drawer-priority"
            value={task.priority}
            onChange={(event) => void updateTask(task.id, { priority: event.target.value })}
            className={inputClass}
          >
            {PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {priority}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label
            htmlFor="drawer-repo"
            className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-400"
          >
            Repo
          </label>
          <input
            id="drawer-repo"
            data-testid="drawer-repo"
            defaultValue={task.repo ?? ""}
            placeholder="owner/name"
            onBlur={(event) => {
              const next = event.target.value.trim();
              if (next !== (task.repo ?? "")) void updateTask(task.id, { repo: next || null });
            }}
            className={inputClass}
          />
        </div>

        <div className="col-span-2">
          <label
            htmlFor="drawer-labels"
            className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-400"
          >
            Labels
          </label>
          <input
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
            className={inputClass}
          />
        </div>
      </section>

      <section className="mb-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Automation
        </h3>
        <p className="text-xs text-neutral-500">
          Bind a pipeline to a column and cards entering it run automatically. Coming in Phase 7.
        </p>
      </section>

      <section className="min-h-0 flex-1">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Timeline
        </h3>
        <Timeline events={events} />

        <div className="mt-3 flex gap-2">
          <input
            data-testid="drawer-comment"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void postComment();
              }
            }}
            placeholder="Add a note…"
            className={inputClass}
          />
          <button
            type="button"
            data-testid="post-comment"
            onClick={() => void postComment()}
            className="rounded bg-sky-600 px-2 py-1 text-sm text-white"
          >
            Post
          </button>
        </div>
      </section>
    </aside>
  );
}
