"use client";

import { useState } from "react";
import { controlClass } from "./controls";

/** Pipeline-level `{{ vars }}`, reusable across every node's config. */
export function VariablesPanel({
  pipelineId,
  variables,
  onChanged,
}: {
  pipelineId: string;
  variables: Record<string, string>;
  onChanged: () => void;
}) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");

  async function save() {
    const response = await fetch(`/api/pipelines/${pipelineId}/variables`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value }),
    });
    if (!response.ok) return;

    setKey("");
    setValue("");
    onChanged();
  }

  const entries = Object.entries(variables);

  return (
    <div data-testid="variables-panel" className="p-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Variables
      </h3>

      <ul className="mb-4 space-y-1">
        {entries.length === 0 && <li className="text-xs text-muted-foreground">None yet.</li>}
        {entries.map(([name, stored]) => (
          <li
            key={name}
            data-testid={`variable-${name}`}
            className="rounded border border-border bg-card px-2 py-1 font-mono text-xs "
          >
            {`{{ pipeline.vars.${name} }}`}
            <span className="ml-1 font-sans text-muted-foreground">{stored}</span>
          </li>
        ))}
      </ul>

      <input
        data-testid="variable-key"
        value={key}
        onChange={(event) => setKey(event.target.value)}
        placeholder="repoUrl"
        className={`${controlClass} mb-2`}
      />
      <input
        data-testid="variable-value"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="acme/app"
        className={`${controlClass} mb-2`}
      />
      <button
        type="button"
        data-testid="save-variable"
        disabled={key.trim() === ""}
        onClick={save}
        className="w-full rounded bg-primary px-2 py-1 text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
      >
        Save variable
      </button>
    </div>
  );
}
