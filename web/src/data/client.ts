import { PrismaClient } from "@prisma/client";

/**
 * The single Prisma client.
 *
 * `web/src/data/**` is the ONLY layer that touches the database from the web
 * side — route handlers and components call repositories, never Prisma
 * directly (docs/ARCHITECTURE.md, module boundary 2).
 *
 * Cached on globalThis so Next's dev-mode hot reload does not open a new pool
 * on every edit.
 */
const globalForPrisma = globalThis as unknown as { agentflowPrisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.agentflowPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.agentflowPrisma = prisma;
}
