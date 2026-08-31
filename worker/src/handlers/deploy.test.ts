import { beforeEach, describe, expect, it } from "vitest";
import { containsSecret, type RunContext } from "@agentflow/core";
import type { HttpClient, HttpRequest, HttpResponse } from "../http/HttpClient";
import { createDeployNetlifyHandler, createDeployVercelHandler, type DeployDeps } from "./deploy";
import { createHttpRequestHandler, injectSecrets } from "./httpRequest";
import { NodeFailure, type NodeInfo } from "./types";

/**
 * The outbound nodes: the generic HTTP escape hatch and both deploy targets.
 *
 * The property under test throughout is that a token gets INTO the request and
 * never anywhere else — not a log line, not an error message, not an output.
 */

const TOKEN = "vercel_tok_thisisafaketokenfortests";

class RecordingHttp implements HttpClient {
  readonly sent: HttpRequest[] = [];
  response: HttpResponse = { status: 200, headers: {}, body: "{}" };

  async send(request: HttpRequest): Promise<HttpResponse> {
    this.sent.push(request);
    return this.response;
  }

  get last(): HttpRequest {
    const request = this.sent.at(-1);
    if (!request) throw new Error("no request was sent");
    return request;
  }
}

let http: RecordingHttp;
let logs: { level: string; message: string }[];
let secrets: Map<string, string>;

function deps(): DeployDeps {
  return {
    http,
    loadSecret: async (name) => secrets.get(name) ?? null,
    log: async (_runId, entry) => {
      logs.push({ level: entry.level, message: entry.message });
    },
  };
}

function context(): RunContext {
  return {
    pipeline: { vars: {} },
    trigger: {},
    nodes: {},
    runId: "run_1",
    pipelineId: "pipe_1",
    workspaceDir: "/ws",
  };
}

const node: NodeInfo = { id: "ship", type: "deploy-vercel", label: "Ship" };

beforeEach(() => {
  http = new RecordingHttp();
  logs = [];
  secrets = new Map([
    ["VERCEL_TOKEN", TOKEN],
    ["NETLIFY_TOKEN", "netlify_tok_alsofake"],
  ]);
});

describe("deploy-vercel", () => {
  it("returns the deployment URL into the run context", async () => {
    http.response = {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "dpl_1", url: "agentflow-abc.vercel.app", readyState: "READY" }),
    };

    const output = await createDeployVercelHandler(deps()).run(
      context(),
      { project: "agentflow", target: "production" },
      node,
    );

    expect(output).toMatchObject({
      deploymentUrl: "https://agentflow-abc.vercel.app",
      state: "ready",
      ready: true,
    });
  });

  it("sends the token as a bearer header", async () => {
    await createDeployVercelHandler(deps()).run(context(), { project: "agentflow" }, node);
    expect(http.last.headers?.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("never lets the token reach a log line", async () => {
    await createDeployVercelHandler(deps()).run(context(), { project: "agentflow" }, node);
    expect(containsSecret(logs.map((entry) => entry.message).join("\n"), [TOKEN])).toBe(false);
  });

  it("logs the host only, because a deploy hook URL is itself a credential", async () => {
    await createDeployVercelHandler(deps()).run(
      context(),
      { deployHookUrl: "https://api.vercel.com/v1/integrations/deploy/SECRETPATH" },
      node,
    );

    const message = logs.map((entry) => entry.message).join("\n");
    expect(message).toContain("https://api.vercel.com");
    expect(message).not.toContain("SECRETPATH");
  });

  it("does not treat an unfinished deployment as a failure", async () => {
    http.response = {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "dpl_1", url: "x.vercel.app", readyState: "BUILDING" }),
    };

    const output = await createDeployVercelHandler(deps()).run(
      context(),
      { project: "agentflow" },
      node,
    );

    expect(output.state).toBe("building");
    expect(output.ready).toBe(false);
  });

  it("fails the run when the provider says the deployment failed", async () => {
    http.response = {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ readyState: "ERROR" }),
    };

    await expect(
      createDeployVercelHandler(deps()).run(context(), { project: "agentflow" }, node),
    ).rejects.toThrow(/deployment failed/);
  });

  it("surfaces an error status with the host and the body", async () => {
    http.response = { status: 403, headers: {}, body: "Forbidden" };

    await expect(
      createDeployVercelHandler(deps()).run(context(), { project: "agentflow" }, node),
    ).rejects.toThrow(/answered 403.*Forbidden/s);
  });

  it("says what is missing when there is neither a hook nor a token", async () => {
    secrets.delete("VERCEL_TOKEN");

    await expect(
      createDeployVercelHandler(deps()).run(context(), { project: "agentflow" }, node),
    ).rejects.toThrow(/deploy hook URL or a VERCEL_TOKEN/);
    expect(http.sent).toHaveLength(0);
  });
});

describe("deploy-netlify", () => {
  const netlifyNode: NodeInfo = { id: "ship", type: "deploy-netlify", label: "Ship" };

  it("returns the deploy URL", async () => {
    http.response = {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deploy: { id: "dep_1", state: "ready", deploy_ssl_url: "https://x.netlify.app" },
      }),
    };

    const output = await createDeployNetlifyHandler(deps()).run(
      context(),
      { siteId: "site_1", prod: true },
      netlifyNode,
    );

    expect(output).toMatchObject({ deploymentUrl: "https://x.netlify.app", ready: true });
  });

  it("calls the site's builds endpoint", async () => {
    await createDeployNetlifyHandler(deps()).run(context(), { siteId: "site_1" }, netlifyNode);
    expect(http.last.url).toBe("https://api.netlify.com/api/v1/sites/site_1/builds");
  });

  it("uses a build hook with no token when one is configured", async () => {
    secrets.delete("NETLIFY_TOKEN");

    await createDeployNetlifyHandler(deps()).run(
      context(),
      { siteId: "site_1", buildHookUrl: "https://api.netlify.com/build_hooks/abc" },
      netlifyNode,
    );

    expect(http.last.url).toBe("https://api.netlify.com/build_hooks/abc");
    expect(http.last.headers?.Authorization).toBeUndefined();
  });
});

describe("injectSecrets", () => {
  const secretMap = new Map([["VERCEL_TOKEN", "tok_123"]]);

  it("replaces a named placeholder", () => {
    expect(injectSecrets("Bearer $VERCEL_TOKEN", secretMap, "n")).toBe("Bearer tok_123");
  });

  it("leaves ordinary text that happens to start with a dollar alone", () => {
    // `$5.00` and `$HOME` are not secrets this node declared.
    expect(injectSecrets("costs $5.00 in $HOME", secretMap, "n")).toBe("costs $5.00 in $HOME");
  });

  it("replaces every occurrence", () => {
    expect(injectSecrets("$VERCEL_TOKEN:$VERCEL_TOKEN", secretMap, "n")).toBe("tok_123:tok_123");
  });

  it("refuses an empty secret rather than sending 'Bearer '", () => {
    expect(() => injectSecrets("Bearer $EMPTY", new Map([["EMPTY", ""]]), "n")).toThrow(
      NodeFailure,
    );
  });
});

describe("http-request", () => {
  const httpNode: NodeInfo = { id: "call", type: "http-request", label: "Call" };

  function handler() {
    return createHttpRequestHandler({
      http,
      loadSecret: async (name) => secrets.get(name) ?? null,
      log: async (_runId, entry) => {
        logs.push({ level: entry.level, message: entry.message });
      },
    });
  }

  it("calls the configured URL and returns the response", async () => {
    http.response = {
      status: 201,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true }),
    };

    const output = await handler().run(
      context(),
      { method: "post", url: "https://example.com/hook", body: '{"a":1}' },
      httpNode,
    );

    expect(output).toMatchObject({ status: 201, ok: true, body: { ok: true } });
    expect(http.last).toMatchObject({ method: "POST", url: "https://example.com/hook" });
  });

  it("returns a non-JSON body as text", async () => {
    http.response = { status: 200, headers: { "content-type": "text/plain" }, body: "done" };

    const output = await handler().run(context(), { url: "https://example.com" }, httpNode);
    expect(output.body).toBe("done");
  });

  it("injects only the secrets the node declared", async () => {
    secrets.set("MY_TOKEN", "s3cret-value");

    await handler().run(
      context(),
      {
        url: "https://example.com",
        headers: { Authorization: "Bearer $MY_TOKEN", "X-Other": "$NOT_DECLARED" },
        secretRefs: ["MY_TOKEN"],
      },
      httpNode,
    );

    expect(http.last.headers?.Authorization).toBe("Bearer s3cret-value");
    expect(http.last.headers?.["X-Other"]).toBe("$NOT_DECLARED");
  });

  it("keeps an injected secret out of every log line", async () => {
    secrets.set("MY_TOKEN", "s3cret-value");

    await handler().run(
      context(),
      {
        url: "https://example.com/$MY_TOKEN",
        headers: { Authorization: "Bearer $MY_TOKEN" },
        secretRefs: ["MY_TOKEN"],
      },
      httpNode,
    );

    expect(containsSecret(logs.map((entry) => entry.message).join("\n"), ["s3cret-value"])).toBe(
      false,
    );
  });

  it("refuses to run when a declared secret is not set", async () => {
    await expect(
      handler().run(
        context(),
        { url: "https://example.com", secretRefs: ["MISSING_TOKEN"] },
        httpNode,
      ),
    ).rejects.toThrow(/needs the secret MISSING_TOKEN, which is not set/);

    expect(http.sent).toHaveLength(0);
  });

  it("fails the run on an error status by default", async () => {
    http.response = { status: 500, headers: {}, body: "boom" };

    await expect(
      handler().run(context(), { url: "https://example.com" }, httpNode),
    ).rejects.toThrow(/answered 500/);
  });

  it("can be told to carry on past an error status", async () => {
    http.response = { status: 404, headers: {}, body: "nope" };

    const output = await handler().run(
      context(),
      { url: "https://example.com", failOnErrorStatus: false },
      httpNode,
    );

    expect(output).toMatchObject({ status: 404, ok: false });
  });

  it("refuses to call nothing", async () => {
    await expect(handler().run(context(), { url: "  " }, httpNode)).rejects.toThrow(
      /no URL to call/,
    );
  });
});
