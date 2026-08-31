import { notFound } from "next/navigation";
import { PipelineEditor } from "@/components/editor/PipelineEditor";
import { listAgentProfiles } from "@/data/agentProfiles";
import { getPipeline, getVariables } from "@/data/pipelines";
import { listCredentialStates } from "@/data/secrets";

export const dynamic = "force-dynamic";

export default async function PipelineEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const pipeline = await getPipeline(id);
  if (!pipeline) notFound();

  // Credentials are fetched as STATE only — no key ever reaches the browser.
  const [profiles, credentials, variables] = await Promise.all([
    listAgentProfiles(),
    listCredentialStates(id),
    getVariables(id),
  ]);

  return (
    <PipelineEditor
      pipeline={pipeline}
      initialProfiles={profiles}
      initialCredentials={credentials}
      initialVariables={variables}
    />
  );
}
