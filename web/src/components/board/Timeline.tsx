"use client";

import type { TaskEvent } from "@agentflow/core";
import { cn } from "@/lib/utils";

const ACTOR_LABEL: Record<string, string> = {
  user: "You",
  system: "System",
  github: "GitHub",
};

function actorName(actor: string): string {
  if (actor.startsWith("agent:")) return `Agent · ${actor.slice("agent:".length)}`;
  return ACTOR_LABEL[actor] ?? actor;
}

/**
 * The dot colour carries the outcome, so failures and decisions stand out when
 * you are scanning a long feed rather than reading it.
 */
const KIND_DOT: Record<string, string> = {
  run_failed: "bg-destructive",
  rejected: "bg-destructive",
  run_succeeded: "bg-emerald-500",
  approved: "bg-emerald-500",
  pr_opened: "bg-emerald-500",
  run_started: "bg-sky-500",
  run_step: "bg-sky-500",
  moved: "bg-muted-foreground/50",
};

/**
 * The card's activity feed — your comments and the agents' steps in ONE list.
 */
export function Timeline({ events }: { events: TaskEvent[] }) {
  if (events.length === 0) {
    return <p className="text-xs text-muted-foreground">Nothing has happened yet.</p>;
  }

  return (
    <ol data-testid="timeline" className="relative space-y-3 pl-4">
      {/* One continuous rail behind the dots, rather than a border per row. */}
      <span aria-hidden className="absolute top-1 bottom-1 left-[3px] w-px bg-border" />

      {events.map((event) => (
        <li key={event.id} data-event-kind={event.kind} className="relative">
          <span
            aria-hidden
            className={cn(
              "absolute top-1 -left-4 size-[7px] rounded-full ring-2 ring-background",
              KIND_DOT[event.kind] ?? "bg-muted-foreground/50",
            )}
          />
          <p className="text-xs leading-snug text-foreground">{event.message}</p>
          <p className="text-[10px] text-muted-foreground">
            {actorName(event.actor)} ·{" "}
            {new Date(event.createdAt).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
        </li>
      ))}
    </ol>
  );
}
