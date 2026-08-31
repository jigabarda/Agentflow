import { describe, expect, it } from "vitest";
import { REDACTED, containsSecret, redact } from "./redact";

const TOKEN = "ghp_averyrealisticlookinggithubtoken000000";
const API_KEY = "sk-ant-api03-notarealkey-000000000000";

describe("redact", () => {
  it("removes a secret from a log line", () => {
    const line = `git push https://${TOKEN}@github.com/acme/app.git`;
    const safe = redact(line, [TOKEN]);
    expect(safe).not.toContain(TOKEN);
    expect(safe).toContain(REDACTED);
  });

  it("removes every occurrence, not just the first", () => {
    const line = `${TOKEN} ... ${TOKEN} ... ${TOKEN}`;
    const safe = redact(line, [TOKEN]);
    expect(safe).toBe(`${REDACTED} ... ${REDACTED} ... ${REDACTED}`);
  });

  it("removes several different secrets at once", () => {
    const line = `token=${TOKEN} key=${API_KEY}`;
    const safe = redact(line, [TOKEN, API_KEY]);
    expect(containsSecret(safe, [TOKEN, API_KEY])).toBe(false);
  });

  it("catches the URL-encoded form a token takes inside a URL", () => {
    const secret = "p@ss word/with+chars";
    const line = `https://user:${encodeURIComponent(secret)}@host/path`;
    expect(containsSecret(redact(line, [secret]), [secret])).toBe(false);
  });

  it("catches the base64 form used in an Authorization header", () => {
    const line = `Authorization: Basic ${Buffer.from(TOKEN, "utf8").toString("base64")}`;
    expect(containsSecret(redact(line, [TOKEN]), [TOKEN])).toBe(false);
  });

  it("leaves an innocent message untouched", () => {
    const line = "worker ready; 3 steps queued";
    expect(redact(line, [TOKEN])).toBe(line);
  });

  it("ignores null, undefined, and trivially short secrets", () => {
    const line = "a short line about a and ab";
    expect(redact(line, [null, undefined, "", "a", "ab"])).toBe(line);
  });

  it("treats secrets as literals, not patterns", () => {
    const line = "matched a.c and abc";
    expect(redact(line, ["a.c and"])).toBe(`matched ${REDACTED} abc`);
  });

  it("redacts a longer secret that contains a shorter one, leaving nothing behind", () => {
    const short = "secret123";
    const long = `${short}-extended-tail`;
    expect(containsSecret(redact(`value=${long}`, [short, long]), [short, long])).toBe(false);
  });
});

describe("containsSecret", () => {
  it("detects a leak in any encoding", () => {
    expect(containsSecret(`x ${TOKEN} y`, [TOKEN])).toBe(true);
    expect(containsSecret(`x ${encodeURIComponent(TOKEN)} y`, [TOKEN])).toBe(true);
    expect(containsSecret("nothing here", [TOKEN])).toBe(false);
  });
});

describe("property: no secret survives redaction", () => {
  it("holds for many generated secrets embedded in noisy messages", () => {
    const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_/+=@.";
    // Deterministic pseudo-random source: tests must not depend on Math.random.
    let seed = 1337;
    const nextInt = (max: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % max;
    };

    for (let i = 0; i < 200; i++) {
      const length = 8 + nextInt(40);
      let secret = "";
      for (let c = 0; c < length; c++) secret += alphabet[nextInt(alphabet.length)];

      const message = `step=${i} url=https://x.test/${secret}?k=${secret} body={"token":"${secret}"}`;
      expect(containsSecret(redact(message, [secret]), [secret])).toBe(false);
    }
  });
});
