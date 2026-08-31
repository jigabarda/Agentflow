import {
  isTerminalDeployState,
  mapNetlifyDeployment,
  mapVercelDeployment,
  netlifyDeployRequest,
  vercelDeployRequest,
  type DeployResult,
} from "@agentflow/core";
import { redact } from "@agentflow/core";
import { parseBody, safeUrl, type HttpClient } from "../http/HttpClient";
import type { NodeHandler, NodeInfo } from "./types";
import { NodeFailure } from "./types";

/**
 * The deploy nodes.
 *
 * Both are the same three steps — build a request, send it, read the answer —
 * and the first and third are pure functions in core. What lives here is the
 * part that touches the world: the token, the call, and the log line.
 *
 * A deploy that has not finished yet is not a failure. The node returns the
 * state it has, and the URL when the provider knows one; a pipeline that needs
 * to wait for "ready" can poll with `wait-for-checks` or an `http-request`.
 */

export interface DeployDeps {
  http: HttpClient;
  loadSecret: (name: string) => Promise<string | null>;
  log: (
    runId: string,
    entry: { level: "debug" | "info" | "warn" | "error"; message: string; nodeId: string },
  ) => Promise<void>;
}

export interface DeployOutput extends DeployResult {
  /** True when the provider says it finished successfully. */
  ready: boolean;
}

/**
 * Send the request and read the answer.
 *
 * The token is redacted out of every message before it can be logged, and the
 * URL is reduced to its host, because a deploy hook URL is itself a credential.
 */
async function send(
  deps: DeployDeps,
  runId: string,
  node: NodeInfo,
  request: { method: "POST"; url: string; headers: Record<string, string>; body?: string },
  secrets: readonly string[],
  map: (payload: unknown) => DeployResult,
): Promise<DeployOutput> {
  const safe = (message: string) => redact(message, secrets);

  await deps.log(runId, {
    level: "info",
    nodeId: node.id,
    message: safe(`Deploying via ${safeUrl(request.url)}.`),
  });

  const response = await deps.http.send({
    method: request.method,
    url: request.url,
    headers: request.headers,
    ...(request.body !== undefined ? { body: request.body } : {}),
  });

  if (response.status < 200 || response.status >= 300) {
    throw new NodeFailure(
      safe(
        `Node "${node.id}": ${safeUrl(request.url)} answered ${response.status}. ${response.body.slice(0, 200)}`,
      ),
    );
  }

  const result = map(parseBody(response));
  const ready = result.state === "ready";

  await deps.log(runId, {
    level: result.state === "failed" ? "error" : "info",
    nodeId: node.id,
    message: result.deploymentUrl
      ? `Deployment ${result.state}: ${result.deploymentUrl}`
      : `Deployment ${result.state}${isTerminalDeployState(result.state) ? "" : " — not finished yet"}.`,
  });

  if (result.state === "failed") {
    throw new NodeFailure(`Node "${node.id}": the deployment failed.`);
  }

  return { ...result, ready };
}

/** The token for a provider, or "" when a hook URL makes it unnecessary. */
async function optionalSecret(deps: DeployDeps, name: string): Promise<string> {
  return (await deps.loadSecret(name)) ?? "";
}

// ──────────────────────────────── Vercel ────────────────────────────────────

export interface DeployVercelConfig {
  project?: string;
  target?: "preview" | "production";
  deployHookUrl?: string;
  teamId?: string;
  /** The secret holding the API token. Defaults to VERCEL_TOKEN. */
  tokenRef?: string;
}

export function createDeployVercelHandler(
  deps: DeployDeps,
): NodeHandler<DeployVercelConfig, DeployOutput> {
  return {
    type: "deploy-vercel",
    async run(context, config, node) {
      const token = await optionalSecret(deps, config.tokenRef?.trim() || "VERCEL_TOKEN");

      const request = vercelDeployRequest(
        {
          project: config.project ?? "",
          target: config.target ?? "preview",
          deployHookUrl: config.deployHookUrl?.trim() || null,
          teamId: config.teamId?.trim() || null,
        },
        token,
      );

      return send(deps, context.runId, node, request, [token], mapVercelDeployment);
    },
  };
}

// ─────────────────────────────── Netlify ────────────────────────────────────

export interface DeployNetlifyConfig {
  siteId?: string;
  prod?: boolean;
  buildHookUrl?: string;
  /** The secret holding the API token. Defaults to NETLIFY_TOKEN. */
  tokenRef?: string;
}

export function createDeployNetlifyHandler(
  deps: DeployDeps,
): NodeHandler<DeployNetlifyConfig, DeployOutput> {
  return {
    type: "deploy-netlify",
    async run(context, config, node) {
      const token = await optionalSecret(deps, config.tokenRef?.trim() || "NETLIFY_TOKEN");

      const request = netlifyDeployRequest(
        {
          siteId: config.siteId ?? "",
          prod: config.prod ?? false,
          buildHookUrl: config.buildHookUrl?.trim() || null,
        },
        token,
      );

      return send(deps, context.runId, node, request, [token], mapNetlifyDeployment);
    },
  };
}
