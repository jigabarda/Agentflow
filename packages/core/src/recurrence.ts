/**
 * Recurrence — when a repeating card is next due.
 *
 * Pure, and takes its clock as an argument: a scheduler that cannot be tested
 * without waiting an hour is a scheduler nobody tests (CLAUDE.md guardrail 13).
 *
 * Five-field cron (`minute hour day-of-month month day-of-week`), evaluated in
 * a named timezone. There is no cron dependency here on purpose: what we need
 * is small, and the part that is genuinely hard — DST — is handled by working
 * in absolute instants and asking `Intl` what the local wall clock reads. An
 * hour that does not exist is never matched; an hour that happens twice fires
 * once per real minute, which is the honest reading of "09:00 local".
 */

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronError";
  }
}

export interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** True when the expression names specific days of the month. */
  restrictsDayOfMonth: boolean;
  /** True when the expression names specific days of the week. */
  restrictsDayOfWeek: boolean;
}

const RANGES: Record<string, { min: number; max: number }> = {
  minutes: { min: 0, max: 59 },
  hours: { min: 0, max: 23 },
  daysOfMonth: { min: 1, max: 31 },
  months: { min: 1, max: 12 },
  daysOfWeek: { min: 0, max: 6 },
};

const NAMED_MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const NAMED_DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseField(
  raw: string,
  field: keyof typeof RANGES,
): { values: Set<number>; any: boolean } {
  const { min, max } = RANGES[field]!;
  const values = new Set<number>();
  let any = false;

  for (const part of raw.split(",")) {
    const piece = part.trim().toLowerCase();
    if (!piece) throw new CronError(`Empty value in the ${field} field.`);

    // `*/15` and `1-5/2` — a step over a range.
    const [rangePart, stepPart] = piece.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) {
      throw new CronError(`"${piece}" has a step that is not a whole number.`);
    }

    let from: number;
    let to: number;

    if (rangePart === "*" || rangePart === "?") {
      any = stepPart === undefined;
      from = min;
      to = max;
    } else if (rangePart!.includes("-")) {
      const [start, end] = rangePart!.split("-");
      from = named(start!, field);
      to = named(end!, field);
    } else {
      from = named(rangePart!, field);
      to = from;
    }

    if (from < min || to > max || from > to) {
      throw new CronError(`"${piece}" is out of range for the ${field} field (${min}-${max}).`);
    }

    for (let value = from; value <= to; value += step) values.add(value);
  }

  return { values, any };
}

function named(token: string, field: keyof typeof RANGES): number {
  if (field === "months") {
    const index = NAMED_MONTHS.indexOf(token);
    if (index >= 0) return index + 1;
  }
  if (field === "daysOfWeek") {
    const index = NAMED_DAYS.indexOf(token);
    if (index >= 0) return index;
    // Both 0 and 7 mean Sunday, as everywhere else that speaks cron.
    if (token === "7") return 0;
  }

  const value = Number(token);
  if (!Number.isInteger(value)) throw new CronError(`"${token}" is not a number.`);
  return value;
}

export function parseCron(expression: string): CronFields {
  const parts = (expression ?? "").trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new CronError(
      `A cron expression has five fields (minute hour day-of-month month day-of-week), but "${expression}" has ${parts.length}.`,
    );
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  const dom = parseField(dayOfMonth, "daysOfMonth");
  const dow = parseField(dayOfWeek, "daysOfWeek");

  return {
    minutes: parseField(minute, "minutes").values,
    hours: parseField(hour, "hours").values,
    daysOfMonth: dom.values,
    months: parseField(month, "months").values,
    daysOfWeek: dow.values,
    restrictsDayOfMonth: !dom.any,
    restrictsDayOfWeek: !dow.any,
  };
}

/** True when `expression` is usable. For validating user input. */
export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

interface LocalTime {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = FORMATTERS.get(timezone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        weekday: "short",
      });
    } catch {
      throw new CronError(`"${timezone}" is not a timezone this system knows.`);
    }
    FORMATTERS.set(timezone, formatter);
  }
  return formatter;
}

/** What the wall clock reads in `timezone` at this instant. */
function localTime(instant: Date, timezone: string): LocalTime {
  const parts = formatterFor(timezone).formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";

  return {
    minute: Number(get("minute")),
    // Some locales render midnight as 24 under hour12:false.
    hour: Number(get("hour")) % 24,
    dayOfMonth: Number(get("day")),
    month: Number(get("month")),
    dayOfWeek: NAMED_DAYS.indexOf(get("weekday").toLowerCase().slice(0, 3)),
  };
}

function matches(fields: CronFields, time: LocalTime): boolean {
  if (!fields.minutes.has(time.minute)) return false;
  if (!fields.hours.has(time.hour)) return false;
  return matchesDay(fields, time);
}

/** The date half of the match: month and the two day fields. */
function matchesDay(fields: CronFields, time: LocalTime): boolean {
  if (!fields.months.has(time.month)) return false;

  const dayOfMonthMatches = fields.daysOfMonth.has(time.dayOfMonth);
  const dayOfWeekMatches = fields.daysOfWeek.has(time.dayOfWeek);

  // Cron's one genuine oddity: when BOTH day fields are restricted, either one
  // matching is enough. `0 9 1 * mon` means the 1st *or* any Monday.
  if (fields.restrictsDayOfMonth && fields.restrictsDayOfWeek) {
    return dayOfMonthMatches || dayOfWeekMatches;
  }
  if (fields.restrictsDayOfMonth) return dayOfMonthMatches;
  if (fields.restrictsDayOfWeek) return dayOfWeekMatches;
  return true;
}

const MINUTE_MS = 60_000;
/** A catch-up window longer than this is clamped; see `dueSlots`. */
export const MAX_CATCHUP_MINUTES = 7 * 24 * 60;

/** Round an instant down to the start of its minute. */
function floorToMinute(instant: Date): number {
  return Math.floor(instant.getTime() / MINUTE_MS) * MINUTE_MS;
}

/**
 * Every slot in `(after, until]` the expression fires on.
 *
 * `after` is exclusive so that re-running a tick over the same window yields
 * nothing new — the caller passes the last slot it handled. A worker that was
 * down for three hours passes a three-hour-old `after` and gets back exactly
 * the slots it missed, in order, rather than one lump or 180 duplicates.
 *
 * The window is clamped to a week: coming back after a month of downtime
 * should not spawn a month of cards.
 */
export function dueSlots(
  expression: string,
  timezone: string,
  after: Date,
  until: Date,
  options: { maxSlots?: number } = {},
): Date[] {
  const fields = parseCron(expression);
  const maxSlots = options.maxSlots ?? 500;

  const end = floorToMinute(until);
  const earliest = end - MAX_CATCHUP_MINUTES * MINUTE_MS;
  let cursor = Math.max(floorToMinute(after) + MINUTE_MS, earliest);

  const slots: Date[] = [];

  while (cursor <= end && slots.length < maxSlots) {
    if (matches(fields, localTime(new Date(cursor), timezone))) {
      slots.push(new Date(cursor));
    }
    cursor += MINUTE_MS;
  }

  return slots;
}

const HOUR_MS = 60 * MINUTE_MS;
/** How far ahead the preview will look. Long enough for `0 0 29 2 *`. */
const PREVIEW_HORIZON_MS = 5 * 366 * 24 * HOUR_MS;

/**
 * The next `count` times this expression fires after `from`. For the UI preview.
 *
 * Scans minute by minute only inside hours that can match; every other hour is
 * skipped whole. Without that, previewing something like "29 February" would
 * mean testing two million minutes.
 */
export function nextFireTimes(expression: string, timezone: string, from: Date, count = 3): Date[] {
  const fields = parseCron(expression);
  const found: Date[] = [];

  let cursor = floorToMinute(from) + MINUTE_MS;
  const limit = cursor + PREVIEW_HORIZON_MS;

  while (cursor <= limit && found.length < count) {
    const time = localTime(new Date(cursor), timezone);

    if (matchesDay(fields, time) && fields.hours.has(time.hour)) {
      if (fields.minutes.has(time.minute)) found.push(new Date(cursor));
      cursor += MINUTE_MS;
      continue;
    }

    // Nothing in this hour can match: jump to the next hour boundary.
    cursor = Math.floor(cursor / HOUR_MS) * HOUR_MS + HOUR_MS;
  }

  return found;
}

// ─────────────────────────── plain language ────────────────────────────────

export interface RecurrencePreset {
  id: string;
  label: string;
  cron: string;
}

/** The choices the drawer offers, so nobody has to know cron to use this. */
export const RECURRENCE_PRESETS: readonly RecurrencePreset[] = [
  { id: "weekday-9", label: "Every weekday at 9am", cron: "0 9 * * 1-5" },
  { id: "daily-9", label: "Every day at 9am", cron: "0 9 * * *" },
  { id: "monday-9", label: "Every Monday at 9am", cron: "0 9 * * 1" },
  { id: "monthly-1", label: "First of the month at 9am", cron: "0 9 1 * *" },
  { id: "hourly", label: "Every hour", cron: "0 * * * *" },
];

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function timeOfDay(fields: CronFields): string | null {
  if (fields.minutes.size !== 1 || fields.hours.size !== 1) return null;
  const minute = [...fields.minutes][0]!;
  const hour = [...fields.hours][0]!;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * A cron expression in words.
 *
 * Covers the shapes the presets produce and the common hand-written ones;
 * anything else is returned as the expression itself rather than a wrong
 * description. Being vague is fine, being wrong about when work appears is not.
 */
export function describeCron(expression: string): string {
  let fields: CronFields;
  try {
    fields = parseCron(expression);
  } catch {
    return expression;
  }

  const at = timeOfDay(fields);
  const everyDayOfMonth = !fields.restrictsDayOfMonth;
  const everyMonth = fields.months.size === 12;

  if (at && everyDayOfMonth && everyMonth) {
    if (!fields.restrictsDayOfWeek) return `Every day at ${at}`;

    const days = [...fields.daysOfWeek].sort();
    if (days.join(",") === "1,2,3,4,5") return `Every weekday at ${at}`;
    if (days.join(",") === "0,6") return `Every weekend day at ${at}`;
    if (days.length === 1) return `Every ${DAY_NAMES[days[0]!]} at ${at}`;
    return `Every ${days.map((day) => DAY_NAMES[day]).join(", ")} at ${at}`;
  }

  if (at && !everyDayOfMonth && everyMonth && !fields.restrictsDayOfWeek) {
    const days = [...fields.daysOfMonth].sort((a, b) => a - b);
    if (days.length === 1) return `On day ${days[0]} of every month at ${at}`;
  }

  if (fields.minutes.size === 1 && fields.hours.size === 24 && everyDayOfMonth && everyMonth) {
    const minute = [...fields.minutes][0]!;
    return minute === 0 ? "Every hour" : `Every hour at ${minute} past`;
  }

  return expression;
}
