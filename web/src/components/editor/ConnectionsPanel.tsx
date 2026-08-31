"use client";

import { useState } from "react";
import type { CredentialState } from "@agentflow/core";
import { PROVIDERS, getProvider } from "@/nodes/models";

const inputClass =
  "w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-900 " +
  "focus:border-sky-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100";

/**
 * Connections — the API key for each provider THIS pipeline uses.
 *
 * Keys are write-only: once saved, the value never comes back to the browser,
 * not even masked. You replace it, you do not read it. See docs/SECURITY.md.
 */
export function ConnectionsPanel({
  pipelineId,
  credentials,
  providersUsed,
  onChanged,
}: {
  pipelineId: string;
  credentials: CredentialState[];
  providersUsed: string[];
  onChanged: () => void;
}) {
  const [provider, setProvider] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  const selected = getProvider(provider);
  const keyless = selected?.keyless ?? false;
  const canSubmit = provider !== "" && (keyless ? baseUrl.trim() !== "" : apiKey.trim() !== "");

  const configured = new Map(credentials.map((credential) => [credential.provider, credential]));
  const missing = providersUsed.filter((used) => {
    const credential = configured.get(used);
    if (!credential) return true;
    return getProvider(used)?.keyless ? !credential.baseUrl : !credential.hasKey;
  });

  async function save() {
    setError(null);
    const response = await fetch(`/api/pipelines/${pipelineId}/credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider,
        ...(apiKey ? { apiKey } : {}),
        ...(baseUrl ? { baseUrl } : {}),
      }),
    });

    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      setError(payload.error ?? "Could not save this connection.");
      return;
    }

    setApiKey("");
    setBaseUrl("");
    onChanged();
  }

  return (
    <div data-testid="connections-panel" className="p-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        API keys for this pipeline
      </h3>

      {missing.length > 0 && (
        <div
          data-testid="missing-credentials"
          className="mb-3 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
        >
          This pipeline cannot run yet: no credential for {missing.join(", ")}.
        </div>
      )}

      <ul className="mb-4 space-y-1">
        {credentials.length === 0 && (
          <li className="text-xs text-neutral-500">No connections yet.</li>
        )}
        {credentials.map((credential) => (
          <li
            key={credential.provider}
            data-testid={`credential-${credential.provider}`}
            className="rounded border border-neutral-200 bg-white px-2 py-1 text-xs dark:border-neutral-800 dark:bg-neutral-900"
          >
            <span className="font-medium">{credential.provider}</span>
            <span className="ml-1 text-neutral-500">
              {credential.hasKey ? "key set" : credential.baseUrl ? credential.baseUrl : "not set"}
            </span>
          </li>
        ))}
      </ul>

      <select
        data-testid="credential-provider"
        value={provider}
        onChange={(event) => setProvider(event.target.value)}
        className={`${inputClass} mb-2`}
      >
        <option value="">Pick a provider…</option>
        {PROVIDERS.map((item) => (
          <option key={item.id} value={item.id}>
            {item.label}
          </option>
        ))}
      </select>

      {selected?.hint && <p className="mb-2 text-[11px] text-neutral-500">{selected.hint}</p>}

      {keyless ? (
        <input
          data-testid="credential-base-url"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="http://localhost:11434"
          className={`${inputClass} mb-2`}
        />
      ) : (
        <input
          data-testid="credential-key"
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="Paste the API key"
          disabled={!provider}
          className={`${inputClass} mb-2`}
        />
      )}

      {error && <p className="mb-2 text-xs text-red-600">{error}</p>}

      <button
        type="button"
        data-testid="save-credential"
        disabled={!canSubmit}
        onClick={save}
        className="w-full rounded bg-sky-600 px-2 py-1 text-sm text-white disabled:opacity-40"
      >
        Save connection
      </button>

      <p className="mt-2 text-[11px] text-neutral-500">
        Stored encrypted, and never shown again after saving.
      </p>
    </div>
  );
}
