import { prisma } from "./client";

/**
 * Test-only helpers. Not imported by application code.
 */

/** Empty every table, children first, so each test starts from a known state. */
export async function resetDatabase(): Promise<void> {
  await prisma.$transaction([
    prisma.logEntry.deleteMany(),
    prisma.runStep.deleteMany(),
    prisma.run.deleteMany(),
    prisma.taskEvent.deleteMany(),
    prisma.task.deleteMany(),
    prisma.boardColumn.deleteMany(),
    prisma.board.deleteMany(),
    prisma.providerCredential.deleteMany(),
    prisma.variable.deleteMany(),
    prisma.pipelineNode.deleteMany(),
    prisma.pipelineEdge.deleteMany(),
    prisma.pipeline.deleteMany(),
    prisma.agentProfile.deleteMany(),
    prisma.secret.deleteMany(),
  ]);
}
