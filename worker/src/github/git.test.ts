import { describe, expect, it } from "vitest";
import { containsSecret } from "@agentflow/core";
import { GitError, LocalGit } from "./git";

/**
 * The git layer, with `execFile` replaced by a recorder.
 *
 * The point of these tests is not that git works — it is that the token never
 * reaches a place the agent or a log can read it.
 */

const TOKEN = "ghp_thisisafaketokenfortestsonly000000";

interface Invocation {
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
}

function recorder(result: Partial<Record<string, string>> = {}) {
  const calls: Invocation[] = [];
  const exec = async (
    _file: string,
    args: string[],
    options: { cwd?: string; env: NodeJS.ProcessEnv },
  ) => {
    calls.push({ args, ...(options.cwd ? { cwd: options.cwd } : {}), env: options.env });
    // Scripted per git subcommand: `{ status: " M f\n" }`.
    return { stdout: result[args[0] ?? ""] ?? "", stderr: "" };
  };
  /** Indexed access that fails the test loudly instead of yielding undefined. */
  const at = (index: number): Invocation => {
    const call = calls[index];
    if (!call) throw new Error(`expected a git command #${index}, but there were ${calls.length}`);
    return call;
  };

  return { calls, at, exec };
}

describe("LocalGit — where the token goes", () => {
  it("keeps the token out of the remote URL, so nothing secret lands in .git/config", async () => {
    const { calls, exec } = recorder({ "rev-parse": "abc123\n" });
    await new LocalGit(TOKEN, { exec }).clone({ repo: "o/r", dir: "/ws/r" });

    // The first command probes for an existing checkout; the clone follows.
    const clone = calls.find((call) => call.args[0] === "clone")!;
    expect(clone.args).toContain("https://github.com/o/r.git");
    expect(clone.args.some((arg) => arg.includes(TOKEN))).toBe(false);
  });

  it("keeps the token out of argv entirely, where `ps` could read it", async () => {
    const { calls, exec } = recorder({ "rev-parse": "abc123\n" });
    await new LocalGit(TOKEN, { exec }).clone({ repo: "o/r", dir: "/ws/r" });

    for (const call of calls) {
      expect(containsSecret(call.args.join(" "), [TOKEN])).toBe(false);
    }
  });

  it("authenticates through the environment instead", async () => {
    const { at, exec } = recorder();
    await new LocalGit(TOKEN, { exec }).push("/ws/r", "task/1");

    const env = at(0).env;
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
    expect(env.GIT_CONFIG_VALUE_0).toBe(
      `Authorization: Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`,
    );
  });

  it("sends no credential at all when there is no token", async () => {
    const { at, exec } = recorder();
    await new LocalGit(null, { exec }).push("/ws/r", "task/1");

    expect(at(0).env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(at(0).env.GIT_CONFIG_VALUE_0).toBeUndefined();
  });

  it("never lets the token reach the log callback", async () => {
    const lines: string[] = [];
    const { exec } = recorder({ "rev-parse": "abc\n" });
    await new LocalGit(TOKEN, { exec, log: (line) => lines.push(line) }).clone({
      repo: "o/r",
      dir: "/ws/r",
    });

    expect(lines.length).toBeGreaterThan(0);
    expect(containsSecret(lines.join("\n"), [TOKEN])).toBe(false);
  });

  it("redacts the token and its Basic form out of git's error output", async () => {
    const header = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
    const exec = async () => {
      throw Object.assign(new Error("fatal: could not read Password"), {
        stderr: `remote: rejected ${TOKEN} / ${header}`,
      });
    };

    const git = new LocalGit(TOKEN, { exec });
    const error = await git.push("/ws/r", "b").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitError);
    expect(containsSecret((error as Error).message, [TOKEN, header])).toBe(false);
    expect((error as Error).message).toContain("[redacted]");
  });

  it("disables the credential prompt, so a run can never hang on stdin", async () => {
    const { at, exec } = recorder();
    await new LocalGit(TOKEN, { exec }).push("/ws/r", "b");

    expect(at(0).env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(at(0).env.GIT_ASKPASS).toBe("");
  });
});

describe("LocalGit — commands", () => {
  it("clones shallow by default and checks out a ref when given one", async () => {
    const { calls, exec } = recorder({ "rev-parse": "abc\n" });
    await new LocalGit(TOKEN, { exec }).clone({ repo: "o/r", dir: "/ws/r", ref: "develop" });

    expect(calls.find((call) => call.args[0] === "clone")!.args).toEqual([
      "clone",
      "--quiet",
      "--depth",
      "1",
      "--branch",
      "develop",
      "https://github.com/o/r.git",
      "/ws/r",
    ]);
  });

  it("clones with full history when depth is 0", async () => {
    const { calls, exec } = recorder({ "rev-parse": "abc\n" });
    await new LocalGit(TOKEN, { exec }).clone({ repo: "o/r", dir: "/ws/r", depth: 0 });

    expect(calls.find((call) => call.args[0] === "clone")!.args).not.toContain("--depth");
  });

  it("reports a clean tree as having no changes", async () => {
    const { exec } = recorder({ status: "   \n" });
    expect(await new LocalGit(TOKEN, { exec }).hasChanges("/ws/r")).toBe(false);
  });

  it("reports a dirty tree as having changes", async () => {
    const { exec } = recorder({ status: " M src/index.ts\n" });
    expect(await new LocalGit(TOKEN, { exec }).hasChanges("/ws/r")).toBe(true);
  });

  it("does not commit when there is nothing to commit", async () => {
    const { calls, exec } = recorder({ status: "" });
    const result = await new LocalGit(TOKEN, { exec }).commitAll("/ws/r", "msg", {
      name: "A",
      email: "a@b.c",
    });

    expect(result).toBeNull();
    expect(calls.map((call) => call.args[0])).toEqual(["status"]);
  });

  it("stages everything, commits, and returns the new sha", async () => {
    const { calls, at, exec } = recorder({ status: " M f\n", "rev-parse": "deadbeef\n" });
    const result = await new LocalGit(TOKEN, { exec }).commitAll("/ws/r", "Implement it", {
      name: "James",
      email: "j@example.com",
    });

    expect(result).toEqual({ sha: "deadbeef" });
    expect(calls.map((call) => call.args[0])).toEqual(["status", "add", "commit", "rev-parse"]);

    const commit = at(2);
    expect(commit.args).toEqual(["commit", "--message", "Implement it"]);
    // Identity through the environment: no config is written into the workspace.
    expect(commit.env.GIT_AUTHOR_NAME).toBe("James");
    expect(commit.env.GIT_COMMITTER_EMAIL).toBe("j@example.com");
  });

  it("passes the commit message as one argument, never through a shell", async () => {
    const { at, exec } = recorder({ status: " M f\n", "rev-parse": "sha\n" });
    const message = "fix: $(whoami) && rm -rf / `id`";

    await new LocalGit(TOKEN, { exec }).commitAll("/ws/r", message, {
      name: "A",
      email: "a@b.c",
    });

    expect(at(2).args[2]).toBe(message);
  });

  it("pushes and sets upstream", async () => {
    const { at, exec } = recorder();
    await new LocalGit(TOKEN, { exec }).push("/ws/r", "task/1");

    expect(at(0).args).toEqual(["push", "--set-upstream", "origin", "task/1"]);
    expect(at(0).cwd).toBe("/ws/r");
  });
});
