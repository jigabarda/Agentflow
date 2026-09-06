"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
          <li data-testid="secrets-empty" className="text-sm text-muted-foreground">
            Nothing stored yet.
          </li>
        )}
        {names.map((stored) => (
          <li
            key={stored}
            data-testid={`secret-${stored}`}
            className="flex items-center gap-2 rounded-lg border bg-card px-2.5 py-2 text-sm"
          >
            <span className="font-mono text-xs">{stored}</span>
            <Badge variant="secondary" className="font-normal">
              set
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              data-testid={`secret-remove-${stored}`}
              onClick={() => void remove(stored)}
              className="ml-auto h-6 gap-1 px-2 text-[11px] text-muted-foreground"
            >
              <Trash2 className="size-3" aria-hidden />
              Remove
            </Button>
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

        <div className="space-y-1.5">
          <Label htmlFor="secret-value" className="text-xs text-muted-foreground">
            Value — shown once, never again
          </Label>
          <Input
            id="secret-value"
            data-testid="secret-value"
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Paste the token"
            autoComplete="off"
            className="font-mono text-sm"
          />
        </div>

        <Button
          type="submit"
          size="sm"
          data-testid="secret-save"
          disabled={busy || !name.trim() || !value}
        >
          Save
        </Button>

        {message && (
          <p
            data-testid="secret-message"
            className="text-[11px] text-emerald-700 dark:text-emerald-400"
          >
            {message}
          </p>
        )}
        {error && (
          <p data-testid="secret-error" className="text-[11px] text-destructive">
            {error}
          </p>
        )}
      </form>
    </>
  );
}
