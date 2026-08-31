import { NextResponse } from "next/server";
import { z } from "zod";
import { deleteSecret, listSecretNames, setSecret } from "@/data/secrets";

/**
 * Integration tokens.
 *
 * GET returns NAMES only. A stored token is never sent back to the browser,
 * not even masked — the UI shows that one is set and offers to replace it
 * (docs/SECURITY.md).
 */
export async function GET() {
  return NextResponse.json(await listSecretNames());
}

const setSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[A-Z][A-Z0-9_]*$/, "Use an UPPER_SNAKE_CASE name, like GITHUB_TOKEN."),
  value: z.string().min(1, "An empty token is worse than no token — it fails later, confusingly."),
});

export async function POST(request: Request) {
  const parsed = setSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  }

  await setSecret(parsed.data.name, parsed.data.value);
  // Respond with names, never with what was just submitted.
  return NextResponse.json(await listSecretNames(), { status: 201 });
}

export async function DELETE(request: Request) {
  const name = new URL(request.url).searchParams.get("name");
  if (!name) return NextResponse.json({ error: "Which secret?" }, { status: 400 });

  await deleteSecret(name);
  return NextResponse.json(await listSecretNames());
}
