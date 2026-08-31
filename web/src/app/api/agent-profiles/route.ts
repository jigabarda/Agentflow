import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { createAgentProfile, listAgentProfiles } from "@/data/agentProfiles";

export async function GET() {
  return NextResponse.json(await listAgentProfiles());
}

export async function POST(request: Request) {
  try {
    const profile = await createAgentProfile(await request.json());
    return NextResponse.json(profile, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      // Most likely: no model chosen. There is no default to fall back on.
      return NextResponse.json({ error: error.issues[0]?.message }, { status: 400 });
    }
    throw error;
  }
}
