"use client";

import { useState } from "react";

/**
 * Adding and rotating tokens.
 *
 * The input is cleared the moment a value is submitted, and nothing that comes
 * back from the server contains it — the list is names only.
 */

const KNOWN = [
  {
    name: "GITHUB_TOKEN",
    hint: "Repo + pull request permissions. Needed from the GitHub nodes on.",
  },
  { name: "VERCEL_TOKEN", hint: "Only if you deploy to Vercel with the API rather than a hook." },
  { name: "NETLIFY_TOKEN", hint: "Only if you deploy to Netlify with the API rather than a hook." },
  { name: "GITHUB_WEBHOOK_SECRET", hint: "Only if you enable the webhook endpoint." },
];

export function SecretsForm({ initialNames }: { initialNames: string[] }) {
  const [names, setNames] = useState(initialNames);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch("/api/secrets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), value }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setError(payload.error ?? "That did not save.");
        return;
      }

      setNames((await response.json()) as string[]);
      // Clear it immediately: there is no reason for it to stay on screen.
      setValue("");
      setMessage(`${name.trim()} saved. It will not be shown again.`);
      setName("");
    } finally {
      setBusy(false);
    }
  }

  async function remove(target: string) {
    const response = await fetch(`/api/secrets?name=${encodeURIComponent(target)}`, {
      method: "DELETE",
    });
    if (response.ok) {
      setNames((await response.json()) as string[]);
      setMessage(`${target} removed.`);
    }
  }

  return (
    <>
      <ul data-testid="secrets-list" className="mb-4 space-y-1">
        {names.length === 0 && (
          <li data-testid="secrets-empty" className="text-sm text-neutral-500">
            Nothing stored yet.
          </li>
        )}
        {names.map((stored) => (
          <li
            key={stored}
            data-testid={`secret-${stored}`}
            className="flex items-center gap-2 rounded border border-neutral-200 bg-white px-2 py-1.5 text-sm dark:border-neutral-800 dark:bg-neutral-900"
          >
            <span className="font-mono text-xs">{stored}</span>
            <span className="text-[11px] text-neutral-500">set</span>
            <button
              type="button"
              data-testid={`secret-remove-${stored}`}
              onClick={() => void remove(stored)}
              className="ml-auto rounded px-2 py-0.5 text-[11px] text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
            >
              Remove
            </button>
          </li>
        ))}
      </ul>

      <form
        onSubmit={save}
        className="space-y-2 rounded border border-neutral-200 p-3 dark:border-neutral-800"
      >
        <h2 className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
          Add or replace
        </h2>

        <input
          data-testid="secret-name"
          list="known-secrets"
          value={name}
          onChange={(event) => setName(event.target.value.toUpperCase())}
          placeholder="GITHUB_TOKEN"
          className="w-full rounded border border-neutral-300 bg-white px-2 py-1 font-mono text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
        <datalist id="known-secrets">
          {KNOWN.map((entry) => (
            <option key={entry.name} value={entry.name}>
              {entry.hint}
            </option>
          ))}
        </datalist>

        <input
          data-testid="secret-value"
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Paste the token"
          autoComplete="off"
          className="w-full rounded border border-neutral-300 bg-white px-2 py-1 font-mono text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />

        <button
          type="submit"
          data-testid="secret-save"
          disabled={busy || !name.trim() || !value}
          className="rounded bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-neutral-300 dark:disabled:bg-neutral-700"
        >
          Save
        </button>

        {message && (
          <p
            data-testid="secret-message"
            className="text-[11px] text-emerald-700 dark:text-emerald-400"
          >
            {message}
          </p>
        )}
        {error && (
          <p data-testid="secret-error" className="text-[11px] text-red-600">
            {error}
          </p>
        )}
      </form>
    </>
  );
}
