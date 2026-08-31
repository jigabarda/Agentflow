import { describe, expect, it } from "vitest";
import {
  SecretCryptoError,
  decryptSecret,
  encryptSecret,
  generateEncryptionKey,
  parseEncryptionKey,
} from "./crypto";

const KEY = generateEncryptionKey();
const SECRET = "ghp_averyrealisticlookinggithubtoken000000";

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a secret", () => {
    expect(decryptSecret(encryptSecret(SECRET, KEY), KEY)).toBe(SECRET);
  });

  it("stores ciphertext that does not contain the plaintext", () => {
    const stored = encryptSecret(SECRET, KEY);
    expect(stored).not.toContain(SECRET);
    expect(stored.includes(SECRET)).toBe(false);
    expect(stored.startsWith("v1.")).toBe(true);
  });

  it("produces a different ciphertext every time (fresh IV)", () => {
    const a = encryptSecret(SECRET, KEY);
    const b = encryptSecret(SECRET, KEY);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, KEY)).toBe(decryptSecret(b, KEY));
  });

  it("round-trips unicode and empty strings", () => {
    for (const value of ["", "  ", "🔑 clé — ключ", "a".repeat(10_000)]) {
      expect(decryptSecret(encryptSecret(value, KEY), KEY)).toBe(value);
    }
  });

  it("refuses to decrypt with the wrong key", () => {
    const stored = encryptSecret(SECRET, KEY);
    expect(() => decryptSecret(stored, generateEncryptionKey())).toThrow(SecretCryptoError);
  });

  it("detects a tampered payload", () => {
    const stored = encryptSecret(SECRET, KEY);
    const [version, iv, tag, data] = stored.split(".") as [string, string, string, string];
    const flipped = data.startsWith("A") ? `B${data.slice(1)}` : `A${data.slice(1)}`;
    expect(() => decryptSecret([version, iv, tag, flipped].join("."), KEY)).toThrow(
      SecretCryptoError,
    );
  });

  it("rejects a malformed payload", () => {
    expect(() => decryptSecret("not-a-payload", KEY)).toThrow(SecretCryptoError);
    expect(() => decryptSecret("v2.a.b.c", KEY)).toThrow(SecretCryptoError);
  });

  it("never leaks key material in its error messages", () => {
    const stored = encryptSecret(SECRET, KEY);
    const otherKey = generateEncryptionKey();
    try {
      decryptSecret(stored, otherKey);
      expect.unreachable("decrypt should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain(otherKey);
      expect(message).not.toContain(SECRET);
    }
  });
});

describe("parseEncryptionKey", () => {
  it("accepts a valid 32-byte base64 key", () => {
    expect(parseEncryptionKey(generateEncryptionKey())).toHaveLength(32);
  });

  it("explains itself when the key is missing", () => {
    expect(() => parseEncryptionKey(undefined)).toThrow(/SECRETS_ENC_KEY is not set/);
  });

  it("rejects a key of the wrong length", () => {
    expect(() => parseEncryptionKey(Buffer.from("short").toString("base64"))).toThrow(
      /must decode to 32 bytes/,
    );
  });
});

describe("deterministic IV (test-only injection)", () => {
  it("produces a stable ciphertext when the IV is supplied", () => {
    const iv = Buffer.alloc(12, 7);
    expect(encryptSecret(SECRET, KEY, iv)).toBe(encryptSecret(SECRET, KEY, iv));
  });

  it("rejects an IV of the wrong size", () => {
    expect(() => encryptSecret(SECRET, KEY, Buffer.alloc(8))).toThrow(SecretCryptoError);
  });
});
