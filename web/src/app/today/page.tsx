import { TODAY_BUCKET_LABELS, TODAY_BUCKET_ORDER } from "@agentflow/core";
import { todayItems } from "@/data/today";
import { TodayList } from "./TodayList";

export const dynamic = "force-dynamic";

/**
 * Today — the screen to open at 9am.
 *
 * Deliberately board-agnostic: the question is "what should I do now?", and
 * that answer does not respect which board something happens to live on.
 */
export default async function TodayPage() {
  const items = await todayItems();

  const counts = TODAY_BUCKET_ORDER.map((bucket) => ({
    bucket,
    label: TODAY_BUCKET_LABELS[bucket],
    items: items.filter((item) => item.bucket === bucket),
  })).filter((group) => group.items.length > 0);

  const waiting = items.filter((item) => item.bucket === "waiting").length;

  return (
    <main className="mx-auto max-w-3xl p-6">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-2 border-b pb-3">
        <h1 className="text-lg font-semibold tracking-tight">Today</h1>
        <p data-testid="today-summary" className="text-xs text-muted-foreground">
          {items.length === 0
            ? "Nothing needs you right now."
            : `${items.length} item${items.length === 1 ? "" : "s"}${
                waiting > 0 ? ` · ${waiting} waiting on you` : ""
              }`}
        </p>
      </header>

      {counts.length === 0 ? (
        <p data-testid="today-empty" className="text-sm text-muted-foreground">
          Nothing is due, running, or waiting on you. Anything you add with a due date shows up
          here.
        </p>
      ) : (
        counts.map((group) => (
          <TodayList key={group.bucket} label={group.label} items={group.items} />
        ))
      )}
    </main>
  );
}
