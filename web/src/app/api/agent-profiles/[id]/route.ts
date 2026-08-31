import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { deleteAgentProfile, updateAgentProfile } from "@/data/agentProfiles";

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    return NextResponse.json(await updateAgentProfile(id, await request.json()));
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json({ error: error.issues[0]?.message }, { status: 400 });
    }
    throw error;
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  await deleteAgentProfile(id);
  return new NextResponse(null, { status: 204 });
}
