"use client";

import { coerceFieldValue, formatFieldValue, type FieldDescriptor } from "@/nodes/fields";
import { controlClass } from "./controls";

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
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-muted-foreground">
        {field.label}
        {field.required && <span className="ml-0.5 text-destructive">*</span>}
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
          className={controlClass}
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
          className={`${controlClass} font-mono text-xs`}
        />
      ) : (
        <input
          id={id}
          type={field.kind === "number" ? "number" : "text"}
          value={shown}
          onChange={(event) => onChange(coerceFieldValue(field, event.target.value))}
          className={controlClass}
          placeholder={field.kind === "string-list" ? "comma, separated" : undefined}
        />
      )}

      {field.description && (
        <p className="mt-1 text-[11px] text-muted-foreground">{field.description}</p>
      )}
    </div>
  );
}
