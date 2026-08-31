import { describe, expect, it } from "vitest";
import {
  DeployConfigError,
  isTerminalDeployState,
  mapNetlifyDeployment,
  mapVercelDeployment,
  netlifyDeployRequest,
  vercelDeployRequest,
} from "./deploy";

/**
 * Deploy contracts. Pure request builders and response mappers — no token,
 * no network, and every provider quirk pinned to a fixture.
 */

describe("vercelDeployRequest", () => {
  const config = { project: "agentflow", target: "preview" as const };

  it("builds an authenticated API call", () => {
    const request = vercelDeployRequest(config, "tok_123");

    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://api.vercel.com/v13/deployments");
    expect(request.headers.Authorization).toBe("Bearer tok_123");
    expect(JSON.parse(request.body!)).toMatchObject({ project: "agentflow", target: "preview" });
  });

  it("scopes the call to a team when one is given", () => {
    const request = vercelDeployRequest({ ...config, teamId: "team_1" }, "tok_123");
    expect(request.url).toContain("teamId=team_1");
  });

  it("prefers a deploy hook, which needs no token at all", () => {
    const request = vercelDeployRequest(
      { ...config, deployHookUrl: "https://api.vercel.com/v1/integrations/deploy/abc" },
      "",
    );

    expect(request.url).toBe("https://api.vercel.com/v1/integrations/deploy/abc");
    expect(request.headers).toEqual({});
  });

  it("says what is missing rather than calling with no credentials", () => {
    expect(() => vercelDeployRequest(config, "")).toThrow(DeployConfigError);
    expect(() => vercelDeployRequest(config, "")).toThrow(/deploy hook URL or a VERCEL_TOKEN/);
  });

  it("requires a project", () => {
    expect(() => vercelDeployRequest({ project: " ", target: "preview" }, "tok")).toThrow(
      /needs a project/,
    );
  });
});

describe("mapVercelDeployment", () => {
  it("gives a bare hostname a scheme, so it is a link", () => {
    const result = mapVercelDeployment({
      id: "dpl_1",
      url: "agentflow-abc123.vercel.app",
      readyState: "READY",
    });

    expect(result).toEqual({
      deploymentUrl: "https://agentflow-abc123.vercel.app",
      state: "ready",
      id: "dpl_1",
    });
  });

  it("leaves a URL that already has one alone", () => {
    expect(mapVercelDeployment({ url: "https://x.vercel.app" }).deploymentUrl).toBe(
      "https://x.vercel.app",
    );
  });

  it("maps the states that mean 'not finished yet'", () => {
    expect(mapVercelDeployment({ readyState: "QUEUED" }).state).toBe("queued");
    expect(mapVercelDeployment({ readyState: "BUILDING" }).state).toBe("building");
    expect(mapVercelDeployment({ readyState: "INITIALIZING" }).state).toBe("building");
  });

  it("maps failure and cancellation", () => {
    expect(mapVercelDeployment({ readyState: "ERROR" }).state).toBe("failed");
    expect(mapVercelDeployment({ readyState: "CANCELED" }).state).toBe("canceled");
  });

  it("reads a deploy hook's job envelope as queued", () => {
    const result = mapVercelDeployment({ job: { id: "job_1", state: "PENDING" } });
    expect(result).toMatchObject({ state: "queued", id: "job_1", deploymentUrl: null });
  });

  it("keeps a state it does not recognise rather than guessing", () => {
    const result = mapVercelDeployment({ readyState: "SOMETHING_NEW" });
    expect(result.state).toBe("unknown");
    expect(result.rawState).toBe("something_new");
  });

  it("survives an empty response", () => {
    expect(mapVercelDeployment(null)).toEqual({ deploymentUrl: null, state: "unknown", id: null });
  });
});

describe("netlifyDeployRequest", () => {
  const config = { siteId: "site_1", prod: true };

  it("builds an authenticated build call", () => {
    const request = netlifyDeployRequest(config, "tok_123");

    expect(request.url).toBe("https://api.netlify.com/api/v1/sites/site_1/builds");
    expect(request.headers.Authorization).toBe("Bearer tok_123");
  });

  it("escapes a site id rather than pasting it into the path", () => {
    const request = netlifyDeployRequest({ ...config, siteId: "a/b" }, "tok");
    expect(request.url).toContain("a%2Fb");
  });

  it("prefers a build hook, which needs no token", () => {
    const request = netlifyDeployRequest(
      { ...config, buildHookUrl: "https://api.netlify.com/build_hooks/abc" },
      "",
    );
    expect(request.url).toBe("https://api.netlify.com/build_hooks/abc");
    expect(request.headers).toEqual({});
  });

  it("says what is missing", () => {
    expect(() => netlifyDeployRequest(config, "")).toThrow(/build hook URL or a NETLIFY_TOKEN/);
    expect(() => netlifyDeployRequest({ siteId: "", prod: false }, "tok")).toThrow(/site id/);
  });
});

describe("mapNetlifyDeployment", () => {
  it("prefers the SSL address people actually use", () => {
    const result = mapNetlifyDeployment({
      deploy: {
        id: "dep_1",
        state: "ready",
        deploy_ssl_url: "https://x.netlify.app",
        deploy_url: "http://x.netlify.app",
      },
    });

    expect(result).toEqual({ deploymentUrl: "https://x.netlify.app", state: "ready", id: "dep_1" });
  });

  it("reads a build response that is not nested under `deploy`", () => {
    const result = mapNetlifyDeployment({
      id: "dep_2",
      state: "building",
      ssl_url: "x.netlify.app",
    });
    expect(result).toMatchObject({ state: "building", id: "dep_2" });
    expect(result.deploymentUrl).toBe("https://x.netlify.app");
  });

  it("survives an empty response", () => {
    expect(mapNetlifyDeployment({})).toEqual({ deploymentUrl: null, state: "unknown", id: null });
  });
});

describe("isTerminalDeployState", () => {
  it("knows what counts as finished", () => {
    expect(isTerminalDeployState("ready")).toBe(true);
    expect(isTerminalDeployState("failed")).toBe(true);
    expect(isTerminalDeployState("canceled")).toBe(true);
  });

  it("knows what does not", () => {
    expect(isTerminalDeployState("queued")).toBe(false);
    expect(isTerminalDeployState("building")).toBe(false);
    // An unrecognised state is not assumed to be finished.
    expect(isTerminalDeployState("unknown")).toBe(false);
  });
});
