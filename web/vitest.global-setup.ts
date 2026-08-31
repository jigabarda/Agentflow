import { execSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Create the repository tests' database once per run.
 *
 * The path is relative to prisma/schema.prisma (how Prisma resolves sqlite
 * URLs), which keeps this working on Windows without escaping absolute paths.
 */
const webDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(webDir, "..");
const schemaPath = path.join(repoRoot, "prisma", "schema.prisma");
const dbFile = path.join(repoRoot, "prisma", ".tmp", "test.db");

export const TEST_DATABASE_URL = "file:./.tmp/test.db";

export default function setup(): void {
  mkdirSync(path.dirname(dbFile), { recursive: true });
  // Start from an empty database so a stale schema can never mask a migration bug.
  rmSync(dbFile, { force: true });
  rmSync(`${dbFile}-journal`, { force: true });

  execSync(`npx prisma db push --skip-generate --schema "${schemaPath}"`, {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: "pipe",
  });
}
