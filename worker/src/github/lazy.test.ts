import { describe, expect, it } from "vitest";
import { MockGit, MockGitHubClient } from "./MockGitHubClient";
import { createLazyGitHub, MissingGitHubTokenError } from "./lazy";

/**
 * The token is resolved per call, not at startup. That is what lets someone
 * paste GITHUB_TOKEN into the UI and have the next run work with no restart —
 * and it means the plaintext is not held for the life of the process.
 *
 * Both real clients are replaced here, so nothing reaches GitHub or runs git.
 */

function harness(loadToken: () => Promise<string | null>) {
  const tokensSeen: string[] = [];
  const { client, git } = createLazyGitHub({
    loadToken,
    createClient: (token) => {
      tokensSeen.push(token);
      return new MockGitHubClient({ defaultBranch: "main" });
    },
    createGit: () => new MockGit(),
  });
  return { client, git, tokensSeen };
}

describe("createLazyGitHub", () => {
  it("refuses clearly when no token is configured", async () => {
    const { client, git, tokensSeen } = harness(async () => null);

    await expect(client.getIssue("o/r", 1)).rejects.toThrow(MissingGitHubTokenError);
    await expect(git.push("/ws", "b")).rejects.toThrow(/Add GITHUB_TOKEN in Secrets/);
    // Nothing was built, so nothing could have been called.
    expect(tokensSeen).toEqual([]);
  });

  it("takes effect on the next call when a token is added later", async () => {
    let stored: string | null = null;
    const { client, tokensSeen } = harness(async () => stored);

    await expect(client.getDefaultBranch("o/r")).rejects.toThrow(MissingGitHubTokenError);

    stored = "ghp_added-after-the-worker-started";
    expect(await client.getDefaultBranch("o/r")).toBe("main");
    expect(tokensSeen).toEqual(["ghp_added-after-the-worker-started"]);
  });

  it("rebuilds the clients when the token is rotated", async () => {
    let stored = "ghp_first-token-value";
    const { client, tokensSeen } = harness(async () => stored);

    await client.getDefaultBranch("o/r");
    stored = "ghp_second-token-value";
    await client.getDefaultBranch("o/r");

    expect(tokensSeen).toEqual(["ghp_first-token-value", "ghp_second-token-value"]);
  });

  it("reuses the client while the token is unchanged", async () => {
    const { client, git, tokensSeen } = harness(async () => "ghp_stable-token-value");

    await client.getDefaultBranch("o/r");
    await client.listChecks("o/r", "sha");
    await git.headSha("/ws");

    expect(tokensSeen).toHaveLength(1);
  });

  it("asks for the token on every call rather than caching the plaintext", async () => {
    let asked = 0;
    const { client } = harness(async () => {
      asked += 1;
      return "ghp_stable-token-value";
    });

    await client.getDefaultBranch("o/r");
    await client.getDefaultBranch("o/r");
    await client.getDefaultBranch("o/r");

    expect(asked).toBe(3);
  });
});
