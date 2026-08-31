/**
 * The one way this worker makes an outbound HTTP call.
 *
 * Behind an interface so every node that talks to an API — the escape-hatch
 * `http-request`, both deploy targets, anything added later — is testable with
 * no network at all.
 */

export interface HttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | undefined;
  /** Give up after this long. A node must never hang a run forever. */
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface HttpClient {
  send(request: HttpRequest): Promise<HttpResponse>;
}

export class HttpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpError";
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class FetchHttpClient implements HttpClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async send(request: HttpRequest): Promise<HttpResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    try {
      const response = await this.fetchImpl(request.url, {
        method: request.method,
        headers: request.headers ?? {},
        ...(request.body !== undefined ? { body: request.body } : {}),
        signal: controller.signal,
      });

      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      return { status: response.status, headers, body: await response.text() };
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") {
        throw new HttpError(
          `${request.method} ${safeUrl(request.url)} gave up after ${
            (request.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000
          }s.`,
        );
      }
      throw new HttpError(
        `${request.method} ${safeUrl(request.url)} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * A URL fit to appear in an error message.
 *
 * Deploy hooks are themselves secrets — the whole URL is the credential — so
 * the path is dropped and only the host is named.
 */
export function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "the configured URL";
  }
}

/** JSON when the body is JSON, and the raw text when it is not. */
export function parseBody(response: HttpResponse): unknown {
  const type = response.headers["content-type"] ?? "";
  if (!type.includes("json")) return response.body;

  try {
    return JSON.parse(response.body);
  } catch {
    return response.body;
  }
}
