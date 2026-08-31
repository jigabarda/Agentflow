import { redact } from "@agentflow/core";
import { parseBody, safeUrl, type HttpClient } from "../http/HttpClient";
import type { NodeHandler } from "./types";
import { NodeFailure } from "./types";

/**
 * `http-request` — the escape hatch.
 *
 * Any API, any endpoint, any backend that has no dedicated node. This is what
 * makes "set an API and some variables on a node" true generally rather than
 * only for the integrations we happened to build.
 *
 * ⚠️ How secrets get in. The run context deliberately does NOT hold plaintext
 * secrets: anything in it can be interpolated into a prompt, an output, or a
 * log. Instead the node names the secrets it needs in `secretRefs`, writes
 * `$NAME` where each one goes, and the substitution happens HERE — after the
 * `{{ }}` interpolation the runner does, and after nothing else. `$NAME` is
 * chosen precisely because the interpolator leaves it alone.
 *
 *     headers: { "Authorization": "Bearer $VERCEL_TOKEN" }
 *     secretRefs: ["VERCEL_TOKEN"]
 *
 * Every log line this node writes is redacted against the values it resolved,
 * so a mistyped header cannot leak one.
 */

export interface HttpRequestConfig {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
  secretRefs?: string[];
  timeoutSec?: number;
  /** Fail the run on a 4xx/5xx. On by default: a silent 500 helps nobody. */
  failOnErrorStatus?: boolean;
}

export interface HttpRequestOutput {
  status: number;
  headers: Record<string, string>;
  /** Parsed when the response is JSON, raw text otherwise. */
  body: unknown;
  ok: boolean;
}

export interface HttpRequestDeps {
  http: HttpClient;
  /** Decrypts a stored secret by name. Called only for the refs the node names. */
  loadSecret: (name: string) => Promise<string | null>;
  log: (
    runId: string,
    entry: { level: "debug" | "info" | "warn" | "error"; message: string; nodeId: string },
  ) => Promise<void>;
}

const SECRET_PLACEHOLDER = /\$([A-Z][A-Z0-9_]*)/g;

/**
 * Replace every `$NAME` with the secret of that name.
 *
 * A ref that was named but has no stored value is an error, not an empty
 * string: calling an API with `Bearer ` would fail confusingly later.
 */
export function injectSecrets(
  text: string,
  secrets: ReadonlyMap<string, string>,
  nodeId: string,
): string {
  return text.replace(SECRET_PLACEHOLDER, (match, name: string) => {
    const value = secrets.get(name);
    if (value === undefined) {
      // Not one of the refs this node declared: leave it exactly as written,
      // because `$5.00` and `$HOME` are ordinary text.
      return match;
    }
    if (value === "") {
      throw new NodeFailure(`Node "${nodeId}": the secret ${name} is empty.`);
    }
    return value;
  });
}

export function createHttpRequestHandler(
  deps: HttpRequestDeps,
): NodeHandler<HttpRequestConfig, HttpRequestOutput> {
  return {
    type: "http-request",
    async run(context, config, node) {
      const url = (config.url ?? "").trim();
      if (!url) throw new NodeFailure(`Node "${node.id}": there is no URL to call.`);

      const method = (config.method ?? "GET").toUpperCase();
      const refs = (config.secretRefs ?? []).map((ref) => ref.trim()).filter(Boolean);

      const secrets = new Map<string, string>();
      for (const ref of refs) {
        const value = await deps.loadSecret(ref);
        if (value === null) {
          throw new NodeFailure(
            `Node "${node.id}" needs the secret ${ref}, which is not set. Add it in Secrets.`,
          );
        }
        secrets.set(ref, value);
      }

      const plaintext = [...secrets.values()];
      /** Nothing derived from a secret reaches a log. */
      const safe = (message: string) => redact(message, plaintext);

      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(config.headers ?? {})) {
        headers[key] = injectSecrets(String(value), secrets, node.id);
      }

      const resolvedUrl = injectSecrets(url, secrets, node.id);
      const body =
        config.body === undefined ? undefined : injectSecrets(config.body, secrets, node.id);

      await deps.log(context.runId, {
        level: "info",
        nodeId: node.id,
        // The host only: a deploy hook URL is itself a credential.
        message: safe(`${method} ${safeUrl(resolvedUrl)}`),
      });

      const response = await deps.http.send({
        method,
        url: resolvedUrl,
        headers,
        body,
        ...(config.timeoutSec ? { timeoutMs: config.timeoutSec * 1000 } : {}),
      });

      const ok = response.status >= 200 && response.status < 300;

      if (!ok && (config.failOnErrorStatus ?? true)) {
        await deps.log(context.runId, {
          level: "error",
          nodeId: node.id,
          message: safe(`${safeUrl(resolvedUrl)} answered ${response.status}.`),
        });
        throw new NodeFailure(
          safe(
            `Node "${node.id}": ${safeUrl(resolvedUrl)} answered ${response.status}. ${response.body.slice(0, 200)}`,
          ),
        );
      }

      await deps.log(context.runId, {
        level: ok ? "info" : "warn",
        nodeId: node.id,
        message: safe(`Answered ${response.status}.`),
      });

      return { status: response.status, headers: response.headers, body: parseBody(response), ok };
    },
  };
}
