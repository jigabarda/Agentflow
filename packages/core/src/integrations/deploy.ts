/**
 * Deploy contracts — pure request builders and response mappers.
 *
 * Every deploy target is the same two decisions: what request describes "ship
 * this", and what does the answer mean. Both are pure here, so they can be
 * tested exhaustively without a token, and so a provider changing its response
 * shape is a one-file fix rather than a hunt through handler code.
 *
 * ⚠️ These shapes are written from the providers' documented APIs and are
 * verified against fixtures, NOT against a live account. Treat the first real
 * deployment as the thing that confirms them.
 */

export type DeployState = "queued" | "building" | "ready" | "failed" | "canceled" | "unknown";

export interface DeployRequest {
  method: "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface DeployResult {
  /** The deployment's URL, with a scheme. Null until the provider knows one. */
  deploymentUrl: string | null;
  state: DeployState;
  /** The provider's own id, for polling or for a link. */
  id: string | null;
  /** The provider's raw state word, when it does not map to one of ours. */
  rawState?: string;
}

export class DeployConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployConfigError";
  }
}

/** Providers spell readiness differently; this is the shared vocabulary. */
function normaliseState(raw: unknown): { state: DeployState; rawState?: string } {
  const value = String(raw ?? "").toLowerCase();

  switch (value) {
    case "queued":
    case "new":
    case "pending":
    case "enqueued":
      return { state: "queued" };
    case "building":
    case "initializing":
    case "uploading":
    case "processing":
    case "started":
      return { state: "building" };
    case "ready":
    case "done":
    case "current":
      return { state: "ready" };
    case "error":
    case "failed":
      return { state: "failed" };
    case "canceled":
    case "cancelled":
      return { state: "canceled" };
    default:
      return value ? { state: "unknown", rawState: value } : { state: "unknown" };
  }
}

/** A host with no scheme is not a link. Vercel returns bare hostnames. */
function withScheme(url: unknown): string | null {
  const value = typeof url === "string" ? url.trim() : "";
  if (!value) return null;
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

// ──────────────────────────────── Vercel ────────────────────────────────────

export interface VercelDeployConfig {
  /** The Vercel project name or id. */
  project: string;
  target: "preview" | "production";
  /** Deploy hook URL. When set, the token path is not used. */
  deployHookUrl?: string | null;
  /** Team/scope id, for accounts where the project is not personal. */
  teamId?: string | null;
}

const VERCEL_API = "https://api.vercel.com";

/**
 * The request that starts a Vercel deployment.
 *
 * Two ways in, and the hook wins when it is set: a deploy hook needs no token
 * and no scope, which is the simplest thing that works for most people.
 */
export function vercelDeployRequest(config: VercelDeployConfig, token: string): DeployRequest {
  if (config.deployHookUrl) {
    return { method: "POST", url: config.deployHookUrl, headers: {} };
  }

  if (!token) {
    throw new DeployConfigError(
      "Deploying to Vercel needs either a deploy hook URL or a VERCEL_TOKEN secret.",
    );
  }
  if (!config.project?.trim()) {
    throw new DeployConfigError("Deploying to Vercel needs a project.");
  }

  const query = config.teamId ? `?teamId=${encodeURIComponent(config.teamId)}` : "";

  return {
    method: "POST",
    url: `${VERCEL_API}/v13/deployments${query}`,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: config.project,
      project: config.project,
      target: config.target,
    }),
  };
}

export function mapVercelDeployment(payload: unknown): DeployResult {
  const data = (payload ?? {}) as Record<string, unknown>;

  // A deploy hook answers with a job envelope rather than a deployment.
  const job = data.job as Record<string, unknown> | undefined;
  if (job && !data.url) {
    const { state, rawState } = normaliseState(job.state);
    return {
      deploymentUrl: null,
      state: state === "unknown" ? "queued" : state,
      id: typeof job.id === "string" ? job.id : null,
      ...(rawState ? { rawState } : {}),
    };
  }

  const { state, rawState } = normaliseState(data.readyState ?? data.state);

  return {
    deploymentUrl: withScheme(data.url),
    state,
    id: typeof data.id === "string" ? data.id : null,
    ...(rawState ? { rawState } : {}),
  };
}

// ─────────────────────────────── Netlify ────────────────────────────────────

export interface NetlifyDeployConfig {
  siteId: string;
  prod: boolean;
  /** Build hook URL. When set, the token path is not used. */
  buildHookUrl?: string | null;
}

const NETLIFY_API = "https://api.netlify.com/api/v1";

export function netlifyDeployRequest(config: NetlifyDeployConfig, token: string): DeployRequest {
  if (config.buildHookUrl) {
    // A build hook takes the branch as a query parameter, or none at all.
    return { method: "POST", url: config.buildHookUrl, headers: {} };
  }

  if (!token) {
    throw new DeployConfigError(
      "Deploying to Netlify needs either a build hook URL or a NETLIFY_TOKEN secret.",
    );
  }
  if (!config.siteId?.trim()) {
    throw new DeployConfigError("Deploying to Netlify needs a site id.");
  }

  return {
    method: "POST",
    url: `${NETLIFY_API}/sites/${encodeURIComponent(config.siteId)}/builds`,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ clear_cache: false }),
  };
}

export function mapNetlifyDeployment(payload: unknown): DeployResult {
  const data = (payload ?? {}) as Record<string, unknown>;
  const deploy = (data.deploy ?? data) as Record<string, unknown>;

  const { state, rawState } = normaliseState(deploy.state ?? data.state);

  return {
    // Netlify offers several; the SSL one is the address people actually use.
    deploymentUrl: withScheme(deploy.deploy_ssl_url ?? deploy.ssl_url ?? deploy.deploy_url),
    state,
    id:
      typeof deploy.id === "string"
        ? deploy.id
        : typeof data.deploy_id === "string"
          ? data.deploy_id
          : null,
    ...(rawState ? { rawState } : {}),
  };
}

/** True when a deploy has finished, one way or the other. */
export function isTerminalDeployState(state: DeployState): boolean {
  return state === "ready" || state === "failed" || state === "canceled";
}
