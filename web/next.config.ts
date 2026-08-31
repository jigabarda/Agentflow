import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
