import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Ship a self-contained server in the container: the standalone bundle brings
  // only the files the app actually imports, so the image does not carry the
  // whole monorepo's node_modules.
  output: "standalone",

  // The standalone tracer needs to know where the workspace root is, or it
  // guesses from the lockfile and misses the sibling packages.
  outputFileTracingRoot: path.join(import.meta.dirname, ".."),

  // `@agentflow/core` is a workspace package published as TypeScript source,
  // so Next must transpile it rather than expect a built bundle.
  transpilePackages: ["@agentflow/core"],

  // Next generates its own web/AGENTS.md + web/CLAUDE.md. This repo's operating
  // manual is the root CLAUDE.md; a second set inside web/ competes with it.
  agentRules: false,

  // Playwright drives the dev server over the loopback IP.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
