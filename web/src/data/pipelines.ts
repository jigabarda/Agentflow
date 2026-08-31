import { pipelineSchema, validateGraph } from "@agentflow/core";
import type { GraphValidation, Pipeline, PipelineEdge, PipelineNode } from "@agentflow/core";
import type { Prisma } from "@prisma/client";
import { agentProfileChoices } from "./agentProfiles";
import { prisma } from "./client";

/**
 * Pipelines — the recipes. The canvas edits these; the worker executes them.
 */

export class InvalidPipelineError extends Error {
  constructor(readonly validation: GraphValidation) {
    super(validation.issues[0]?.message ?? "The pipeline is invalid.");
    this.name = "InvalidPipelineError";
  }
}

export interface PipelineGraphInput {
  name: string;
  nodes?: PipelineNode[];
  edges?: PipelineEdge[];
}

type NodeRow = {
  id: string;
  type: string;
  label: string;
  config: Prisma.JsonValue;
  x: number;
  y: number;
};

type EdgeRow = {
  id: string;
  source: string;
  target: string;
  sourceHandle: string | null;
  loop: boolean;
  maxIterations: number | null;
};

function toNode(row: NodeRow): PipelineNode {
  return {
    id: row.id,
    type: row.type,
    label: row.label,
    config: (row.config ?? {}) as Record<string, unknown>,
    x: row.x,
    y: row.y,
  };
}

function toEdge(row: EdgeRow): PipelineEdge {
  return {
    id: row.id,
    source: row.source,
    target: row.target,
    ...(row.sourceHandle ? { sourceHandle: row.sourceHandle } : {}),
    ...(row.loop ? { loop: true } : {}),
    ...(row.maxIterations !== null ? { maxIterations: row.maxIterations } : {}),
  };
}

export async function createPipeline(input: PipelineGraphInput): Promise<Pipeline> {
  const created = await prisma.pipeline.create({
    data: {
      name: input.name,
      nodes: {
        create: (input.nodes ?? []).map((node) => ({
          id: node.id,
          type: node.type,
          label: node.label,
          config: node.config as Prisma.InputJsonValue,
          x: node.x,
          y: node.y,
        })),
      },
      edges: {
        create: (input.edges ?? []).map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle ?? null,
          loop: edge.loop ?? false,
          maxIterations: edge.maxIterations ?? null,
        })),
      },
    },
    include: { nodes: true, edges: true },
  });

  return {
    id: created.id,
    name: created.name,
    nodes: created.nodes.map(toNode),
    edges: created.edges.map(toEdge),
  };
}

export async function getPipeline(id: string): Promise<Pipeline | null> {
  const row = await prisma.pipeline.findUnique({
    where: { id },
    include: { nodes: true, edges: true },
  });
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    nodes: row.nodes.map(toNode),
    edges: row.edges.map(toEdge),
  };
}

export async function listPipelines(): Promise<{ id: string; name: string }[]> {
  return prisma.pipeline.findMany({
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Replace a pipeline's graph.
 *
 * The graph is validated first — an invalid pipeline is never persisted, so a
 * saved pipeline is always one the runner could attempt.
 */
export async function savePipelineGraph(id: string, input: PipelineGraphInput): Promise<Pipeline> {
  const parsed = pipelineSchema.parse({
    id,
    name: input.name,
    nodes: input.nodes ?? [],
    edges: input.edges ?? [],
  });

  // Profiles are needed to resolve an agent node that references one, rather
  // than configuring its model inline.
  const validation = validateGraph(parsed, await agentProfileChoices());
  if (!validation.valid) throw new InvalidPipelineError(validation);

  await prisma.$transaction([
    prisma.pipelineNode.deleteMany({ where: { pipelineId: id } }),
    prisma.pipelineEdge.deleteMany({ where: { pipelineId: id } }),
    prisma.pipeline.update({ where: { id }, data: { name: parsed.name } }),
    prisma.pipelineNode.createMany({
      data: parsed.nodes.map((node) => ({
        id: node.id,
        pipelineId: id,
        type: node.type,
        label: node.label,
        config: node.config as Prisma.InputJsonValue,
        x: node.x,
        y: node.y,
      })),
    }),
    prisma.pipelineEdge.createMany({
      data: parsed.edges.map((edge) => ({
        id: edge.id,
        pipelineId: id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle ?? null,
        loop: edge.loop ?? false,
        maxIterations: edge.maxIterations ?? null,
      })),
    }),
  ]);

  const saved = await getPipeline(id);
  if (!saved) throw new Error(`Pipeline ${id} vanished during save`);
  return saved;
}

export async function deletePipeline(id: string): Promise<void> {
  await prisma.pipeline.delete({ where: { id } });
}

// ───────────────────────────────── variables ────────────────────────────────

export async function setVariable(pipelineId: string, key: string, value: string): Promise<void> {
  await prisma.variable.upsert({
    where: { pipelineId_key: { pipelineId, key } },
    create: { pipelineId, key, value },
    update: { value },
  });
}

export async function getVariables(pipelineId: string): Promise<Record<string, string>> {
  const rows = await prisma.variable.findMany({ where: { pipelineId } });
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}
