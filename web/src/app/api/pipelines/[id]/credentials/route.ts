import { NextResponse } from "next/server";
import { providerCredentialInputSchema } from "@agentflow/core";
import {
  deleteProviderCredential,
  listCredentialStates,
  setProviderCredential,
} from "@/data/secrets";

/**
 * Per-pipeline AI provider credentials.
 *
 * GET returns STATE only — which providers are configured and whether each has
 * a key. A stored key is never returned to the browser, not even masked; the
 * editor shows "key set" and offers to replace it. See docs/SECURITY.md.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return NextResponse.json(await listCredentialStates(id));
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  const parsed = providerCredentialInputSchema.safeParse({
    ...(await request.json()),
    pipelineId: id,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  }

  await setProviderCredential(parsed.data);
  // Respond with state, never with what was just submitted.
  return NextResponse.json(await listCredentialStates(id), { status: 201 });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const provider = new URL(request.url).searchParams.get("provider");
  if (!provider) {
    return NextResponse.json({ error: "Name the provider to remove." }, { status: 400 });
  }

  await deleteProviderCredential(id, provider);
  return NextResponse.json(await listCredentialStates(id));
}
