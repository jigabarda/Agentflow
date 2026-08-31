"use client";

import { useState } from "react";
import type { AgentProfile } from "@/data/agentProfiles";
import { EFFORT_LEVELS, PROVIDERS, modelsFor } from "@/nodes/models";

const inputClass =
  "w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-900 " +
  "focus:border-sky-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100";

/**
 * The Agents library — define an agent once ("Senior implementer", "Cheap
 * triager") and drop it onto as many nodes as you like.
 *
 * Provider and model are required with no default here too: the form will not
 * submit until both are chosen.
 */
export function AgentsPanel({
  profiles,
  onChanged,
}: {
  profiles: AgentProfile[];
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("high");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const knownModels = modelsFor(provider);
  const canSubmit = name.trim() !== "" && provider !== "" && model.trim() !== "";

  async function create() {
    setBusy(true);
    setError(null);

    const response = await fetch("/api/agent-profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, provider, model, effort, systemPrompt, allowedTools: [] }),
    });

    setBusy(false);

    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      setError(payload.error ?? "Could not save this agent.");
      return;
    }

    setName("");
    setModel("");
    setSystemPrompt("");
    onChanged();
  }

  return (
    <div data-testid="agents-panel" className="p-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        Saved agents
      </h3>

      <ul className="mb-4 space-y-1">
        {profiles.length === 0 && (
          <li className="text-xs text-neutral-500">None yet. Create one below.</li>
        )}
        {profiles.map((profile) => (
          <li
            key={profile.id}
            data-testid={`profile-${profile.id}`}
            className="rounded border border-neutral-200 bg-white px-2 py-1 text-xs dark:border-neutral-800 dark:bg-neutral-900"
          >
            <span className="font-medium">{profile.name}</span>
            <span className="ml-1 text-neutral-500">
              {profile.provider} · {profile.model} · {profile.effort}
            </span>
          </li>
        ))}
      </ul>

      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        New agent
      </h3>

      <input
        data-testid="profile-name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Senior implementer"
        className={`${inputClass} mb-2`}
      />

      <select
        data-testid="profile-provider"
        value={provider}
        onChange={(event) => {
          setProvider(event.target.value);
          setModel("");
        }}
        className={`${inputClass} mb-2`}
      >
        <option value="">Pick a provider…</option>
        {PROVIDERS.map((item) => (
          <option key={item.id} value={item.id}>
            {item.label}
          </option>
        ))}
      </select>

      {knownModels.length > 0 ? (
        <select
          data-testid="profile-model"
          value={model}
          onChange={(event) => setModel(event.target.value)}
          className={`${inputClass} mb-2`}
        >
          <option value="">Set a model…</option>
          {knownModels.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          data-testid="profile-model"
          value={model}
          onChange={(event) => setModel(event.target.value)}
          placeholder={provider ? "Type the model id" : "Pick a provider first"}
          disabled={!provider}
          className={`${inputClass} mb-2`}
        />
      )}

      <select
        data-testid="profile-effort"
        value={effort}
        onChange={(event) => setEffort(event.target.value)}
        className={`${inputClass} mb-2`}
      >
        {EFFORT_LEVELS.map((level) => (
          <option key={level.id} value={level.id}>
            {level.label}
          </option>
        ))}
      </select>

      <textarea
        data-testid="profile-prompt"
        value={systemPrompt}
        onChange={(event) => setSystemPrompt(event.target.value)}
        rows={3}
        placeholder="You are a senior engineer. Implement the task in this repo."
        className={`${inputClass} mb-2 font-mono text-xs`}
      />

      {error && <p className="mb-2 text-xs text-red-600">{error}</p>}

      <button
        type="button"
        data-testid="create-profile"
        disabled={!canSubmit || busy}
        onClick={create}
        className="w-full rounded bg-sky-600 px-2 py-1 text-sm text-white disabled:opacity-40"
      >
        {busy ? "Saving…" : "Save agent"}
      </button>
    </div>
  );
}
