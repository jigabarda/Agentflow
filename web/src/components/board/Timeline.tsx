"use client";

import type { TaskEvent } from "@agentflow/core";

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
 * The card's activity feed — your comments and the agents' steps in ONE list.
 * From Phase 7 the run's every step lands here too.
 */
export function Timeline({ events }: { events: TaskEvent[] }) {
  if (events.length === 0) {
    return <p className="text-xs text-neutral-500">Nothing has happened yet.</p>;
  }

  return (
    <ol data-testid="timeline" className="space-y-2">
      {events.map((event) => (
        <li key={event.id} className="border-l-2 border-neutral-200 pl-2 dark:border-neutral-800">
          <p className="text-xs text-neutral-800 dark:text-neutral-200">{event.message}</p>
          <p className="text-[10px] text-neutral-500">
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
