import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createPipeline, listPipelines } from "@/data/pipelines";

export const dynamic = "force-dynamic";

async function create(formData: FormData) {
  "use server";
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;

  const pipeline = await createPipeline({ name });
  revalidatePath("/pipelines");
  redirect(`/pipelines/${pipeline.id}`);
}

export default async function PipelinesPage() {
  const pipelines = await listPipelines();

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">Pipelines</h1>
      <p className="mt-1 text-sm text-neutral-500">
        A pipeline is the recipe for a class of task. Bind one to a board column and cards run it.
      </p>

      <ul className="mt-6 space-y-2">
        {pipelines.length === 0 && (
          <li className="text-sm text-neutral-500">No pipelines yet — create your first below.</li>
        )}
        {pipelines.map((pipeline) => (
          <li key={pipeline.id}>
            <Link
              href={`/pipelines/${pipeline.id}`}
              data-testid={`pipeline-${pipeline.id}`}
              className="block rounded border border-neutral-200 px-3 py-2 text-sm hover:border-sky-400 dark:border-neutral-800"
            >
              {pipeline.name}
            </Link>
          </li>
        ))}
      </ul>

      <form action={create} className="mt-8 flex gap-2">
        <input
          name="name"
          data-testid="new-pipeline-name"
          placeholder="Implement a task"
          className="flex-1 rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button
          type="submit"
          data-testid="create-pipeline"
          className="rounded bg-sky-600 px-3 py-1 text-sm text-white"
        >
          New pipeline
        </button>
      </form>
    </main>
  );
}
