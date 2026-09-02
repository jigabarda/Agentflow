import { cn } from "@/lib/utils";

/**
 * The editor's form controls.
 *
 * Five panels each carried their own copy of this string, which is how they
 * drifted apart. The editor generates its inputs from Zod schemas — native
 * `select` and `textarea` included — so it needs a class rather than a
 * component, and this is the one place it lives.
 *
 * Matches `@/components/ui/input` so a generated field and a shadcn one sit
 * together without looking like two different apps.
 */
export const controlClass = cn(
  "flex h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs",
  "placeholder:text-muted-foreground",
  "outline-none transition-[color,box-shadow]",
  "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
  "disabled:cursor-not-allowed disabled:opacity-50",
);

/** The same, for a multi-line control that must not be locked to one row. */
export const textareaClass = cn(controlClass, "h-auto min-h-16 py-2 font-mono text-xs");

/** A field label, above a control. */
export const labelClass = "mb-1.5 block text-xs font-medium text-muted-foreground";
