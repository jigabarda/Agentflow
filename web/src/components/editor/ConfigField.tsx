"use client";

import { coerceFieldValue, formatFieldValue, type FieldDescriptor } from "@/nodes/fields";

const inputClass =
  "w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-900 " +
  "focus:border-sky-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100";

/** One generated form control, driven entirely by the node's Zod schema. */
export function ConfigField({
  field,
  value,
  onChange,
}: {
  field: FieldDescriptor;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const id = `config-${field.name}`;
  const shown = formatFieldValue(field, value);

  return (
    <div className="mb-3">
      <label
        htmlFor={id}
        className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-400"
      >
        {field.label}
        {field.required && <span className="ml-0.5 text-red-500">*</span>}
      </label>

      {field.kind === "boolean" ? (
        <input
          id={id}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
          className="h-4 w-4"
        />
      ) : field.kind === "select" ? (
        <select
          id={id}
          value={shown}
          onChange={(event) => onChange(coerceFieldValue(field, event.target.value))}
          className={inputClass}
        >
          <option value="">—</option>
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : field.kind === "textarea" ? (
        <textarea
          id={id}
          rows={4}
          value={shown}
          onChange={(event) => onChange(coerceFieldValue(field, event.target.value))}
          className={`${inputClass} font-mono text-xs`}
        />
      ) : (
        <input
          id={id}
          type={field.kind === "number" ? "number" : "text"}
          value={shown}
          onChange={(event) => onChange(coerceFieldValue(field, event.target.value))}
          className={inputClass}
          placeholder={field.kind === "string-list" ? "comma, separated" : undefined}
        />
      )}

      {field.description && (
        <p className="mt-1 text-[11px] text-neutral-500">{field.description}</p>
      )}
    </div>
  );
}
