import { listSecretNames } from "@/data/secrets";
import { SecretsForm } from "./SecretsForm";

export const dynamic = "force-dynamic";

/**
 * Integration tokens — GitHub, Vercel, Netlify, anything an `http-request`
 * node needs.
 *
 * Write-only by design: a stored token is never sent back to the browser, not
 * even masked. You can replace one or remove it; you cannot read it back
 * (docs/SECURITY.md). AI provider keys are NOT here — those are per-pipeline,
 * in the editor's Connections panel.
 */
export default async function SecretsPage() {
  const names = await listSecretNames();

  return (
    <main className="mx-auto max-w-2xl p-6">
      <header className="mb-4 border-b pb-3">
        <h1 className="text-lg font-semibold tracking-tight">Secrets</h1>
      </header>

      <p className="mb-4 text-xs text-muted-foreground">
        Integration tokens, encrypted at rest. Once saved, a value is never shown again — you can
        replace it or remove it, but not read it back. AI model keys live on each pipeline instead,
        in the editor&apos;s Connections panel.
      </p>

      <SecretsForm initialNames={names} />
    </main>
  );
}
