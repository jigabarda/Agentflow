import { execSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Create the worker tests' database once per run. */
const workerDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(workerDir, "..");
const schemaPath = path.join(repoRoot, "prisma", "schema.prisma");
const dbFile = path.join(repoRoot, "prisma", ".tmp", "worker-test.db");

export const TEST_DATABASE_URL = "file:./.tmp/worker-test.db";

export default function setup(): void {
  mkdirSync(path.dirname(dbFile), { recursive: true });
  rmSync(dbFile, { force: true });
  rmSync(`${dbFile}-journal`, { force: true });

  execSync(`npx prisma db push --skip-generate --schema "${schemaPath}"`, {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: "pipe",
  });
}
