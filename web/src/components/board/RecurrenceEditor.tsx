"use client";

import { useMemo, useState } from "react";
import { describeCron, isValidCron, nextFireTimes, RECURRENCE_PRESETS } from "@agentflow/core";

/**
 * Setting a card to repeat, without anyone having to know cron.
 *
 * Presets cover what people actually want; the expression stays editable for
 * the case they do not. Either way the next three fire times are shown, because
 * a schedule you cannot check is a schedule you do not trust.
 */

/** The browser's own zone: "09:00" should mean 09:00 where the user is. */
function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function RecurrenceEditor({
  recurrence,
  timezone,
  onChange,
}: {
  recurrence: string | null;
  timezone: string | null;
  onChange: (recurrence: string | null, timezone: string | null) => void;
}) {
  const zone = timezone ?? localTimezone();
  const [draft, setDraft] = useState(recurrence ?? "");

  const valid = draft.trim() === "" || isValidCron(draft);

  const preview = useMemo(() => {
    if (!draft.trim() || !isValidCron(draft)) return [];
    try {
      return nextFireTimes(draft, zone, new Date(), 3);
    } catch {
      return [];
    }
  }, [draft, zone]);

  function commit(value: string) {
    setDraft(value);
    const trimmed = value.trim();
    if (trimmed === "") {
      onChange(null, null);
      return;
    }
    if (isValidCron(trimmed)) onChange(trimmed, zone);
  }

  return (
    <section
      data-testid="drawer-recurrence"
      className="mb-4 rounded border border-neutral-200 p-2 dark:border-neutral-800"
    >
      <h3 className="mb-1 text-xs font-medium text-neutral-600 dark:text-neutral-400">Repeats</h3>

      <select
        data-testid="recurrence-preset"
        value={RECURRENCE_PRESETS.some((preset) => preset.cron === draft) ? draft : ""}
        onChange={(event) => commit(event.target.value)}
        className="w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
      >
        <option value="">Does not repeat</option>
        {RECURRENCE_PRESETS.map((preset) => (
          <option key={preset.id} value={preset.cron}>
            {preset.label}
          </option>
        ))}
      </select>

      <input
        data-testid="recurrence-cron"
        value={draft}
        placeholder="or a cron expression, e.g. 0 9 * * 1-5"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => commit(draft)}
        className={[
          "mt-1 w-full rounded border bg-white px-2 py-1 font-mono text-xs dark:bg-neutral-900",
          valid
            ? "border-neutral-300 dark:border-neutral-700"
            : "border-red-500 dark:border-red-500",
        ].join(" ")}
      />

      {!valid && (
        <p data-testid="recurrence-invalid" className="mt-1 text-[11px] text-red-600">
          That is not a schedule this understands. Five fields: minute hour day month weekday.
        </p>
      )}

      {draft.trim() && valid && (
        <p data-testid="recurrence-description" className="mt-1 text-[11px] text-neutral-500">
          {describeCron(draft)} · {zone}
        </p>
      )}

      {preview.length > 0 && (
        <ul data-testid="recurrence-preview" className="mt-1 space-y-0.5">
          {preview.map((time) => (
            <li key={time.toISOString()} className="text-[11px] text-neutral-500">
              {time.toLocaleString(undefined, {
                weekday: "short",
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </li>
          ))}
        </ul>
      )}

      {recurrence && (
        <p className="mt-1 text-[11px] text-neutral-500">
          This is a template. It stays put and spawns a fresh card each time.
        </p>
      )}
    </section>
  );
}
