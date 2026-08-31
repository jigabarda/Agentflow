/**
 * Secret encryption — AES-256-GCM, keyed by SECRETS_ENC_KEY.
 *
 * ⚠️ SERVER ONLY. This module imports `node:crypto`, so it is deliberately NOT
 * re-exported from the package barrel — import it as `@agentflow/core/crypto`
 * so it can never be pulled into a browser bundle.
 *
 * Stored form:  v1.<iv-b64>.<tag-b64>.<ciphertext-b64>
 * The version prefix exists so the format can change without guessing.
 *
 * Rules (docs/SECURITY.md): ciphertext at rest, decrypt in memory at the moment
 * of use, never log plaintext, never write a key into a prompt or workspace.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

export class SecretCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretCryptoError";
  }
}

/** Parse and check a base64 SECRETS_ENC_KEY. Throws with actionable advice. */
export function parseEncryptionKey(keyBase64: string | undefined): Buffer {
  if (!keyBase64) {
    throw new SecretCryptoError(
      "SECRETS_ENC_KEY is not set. Generate one: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== KEY_BYTES) {
    throw new SecretCryptoError(
      `SECRETS_ENC_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}.`,
    );
  }
  return key;
}

/**
 * Encrypt a secret for storage.
 * `iv` is injectable purely so tests can be deterministic — production always
 * uses a fresh random IV, and reusing one with the same key breaks GCM.
 */
export function encryptSecret(plaintext: string, keyBase64: string, iv?: Buffer): string {
  const key = parseEncryptionKey(keyBase64);
  const nonce = iv ?? randomBytes(IV_BYTES);
  if (nonce.length !== IV_BYTES) {
    throw new SecretCryptoError(`IV must be ${IV_BYTES} bytes, got ${nonce.length}.`);
  }

  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    nonce.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

/** Decrypt a stored secret. Throws if the payload was tampered with. */
export function decryptSecret(payload: string, keyBase64: string): string {
  const key = parseEncryptionKey(keyBase64);
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SecretCryptoError("Malformed secret payload.");
  }

  const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Never surface the underlying crypto error — it can leak key/tag details.
    throw new SecretCryptoError("Could not decrypt secret: wrong key or tampered payload.");
  }
}

/** Generate a fresh SECRETS_ENC_KEY, base64-encoded. */
export function generateEncryptionKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}
