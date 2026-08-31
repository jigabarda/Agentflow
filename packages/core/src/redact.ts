/**
 * Redaction — the last line of defence before anything is written to a log.
 *
 * Every LogEntry passes through this. It is deliberately dumb and total: give
 * it the plaintext secrets in play and it removes every occurrence, including
 * the URL-encoded and base64 forms a token often takes on its way into a log.
 *
 * Pure, so it is cheap to call on every log line and trivial to test.
 */

export const REDACTED = "[redacted]";

/** Very short strings are excluded — redacting "a" would destroy every message. */
const MIN_SECRET_LENGTH = 6;

/** Every form of `secret` worth scrubbing: raw, URL-encoded, base64. */
function variantsOf(secret: string): string[] {
  const variants = new Set<string>([secret]);

  const encoded = encodeURIComponent(secret);
  if (encoded !== secret) variants.add(encoded);

  try {
    variants.add(Buffer.from(secret, "utf8").toString("base64"));
  } catch {
    // Non-representable input: the raw form alone is still worth scrubbing.
  }

  return [...variants].filter((v) => v.length >= MIN_SECRET_LENGTH);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace every occurrence of every secret (and its common encodings) with
 * `[redacted]`. Secrets shorter than 6 characters are ignored — see above.
 */
export function redact(message: string, secrets: readonly (string | null | undefined)[]): string {
  const patterns = secrets
    .filter((s): s is string => typeof s === "string" && s.length >= MIN_SECRET_LENGTH)
    .flatMap(variantsOf)
    // Longest first, so an embedded shorter secret can't blank out the longer match.
    .sort((a, b) => b.length - a.length);

  let result = message;
  for (const pattern of patterns) {
    result = result.replace(new RegExp(escapeRegExp(pattern), "g"), REDACTED);
  }
  return result;
}

/** True when `message` still contains any of `secrets` verbatim. Test aid. */
export function containsSecret(
  message: string,
  secrets: readonly (string | null | undefined)[],
): boolean {
  return secrets.some(
    (secret) =>
      typeof secret === "string" &&
      secret.length >= MIN_SECRET_LENGTH &&
      variantsOf(secret).some((variant) => message.includes(variant)),
  );
}
