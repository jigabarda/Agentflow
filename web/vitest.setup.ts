import "@testing-library/jest-dom/vitest";

/**
 * Runs before every test module is imported, which matters: the Prisma client
 * reads DATABASE_URL when `web/src/data/client.ts` is first loaded.
 *
 * Tests never touch the developer's dev.db, and the encryption key here is a
 * fixed throwaway — a real key must never live in the repo.
 */
process.env.DATABASE_URL = "file:./.tmp/test.db";
process.env.SECRETS_ENC_KEY ??= "dGVzdC1vbmx5LWtleS0zMi1ieXRlcy1sb25nLXh4eHg=";
