/**
 * Runs before every test module is imported, which matters: the Prisma client
 * reads DATABASE_URL the first time it is constructed.
 *
 * The worker gets its OWN test database so it never races the web tests.
 */
process.env.DATABASE_URL = "file:./.tmp/worker-test.db";
process.env.SECRETS_ENC_KEY ??= "dGVzdC1vbmx5LWtleS0zMi1ieXRlcy1sb25nLXh4eHg=";
