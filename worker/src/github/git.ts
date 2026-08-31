import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { redact } from "@agentflow/core";

const run = promisify(execFile);

/**
 * Local git, on the run's workspace.
 *
 * Cloning, branching, committing and pushing happen on disk rather than through
 * the API: the agent edits a real working tree, and that tree is what we commit.
 *
 * ⚠️ Where the token goes. It must never be written into the workspace, because
 * the agent can read every file in there. So:
 *   · the remote is a plain https URL — nothing secret lands in `.git/config`;
 *   · auth is an `http.extraheader` passed through `GIT_CONFIG_*` **environment**
 *     variables, so it is not in `argv` either (visible to `ps`) and not on disk;
 *   · every line of git output is redacted before it can reach a log.
 */

export interface CloneInput {
  repo: string;
  dir: string;
  /** Branch or tag to check out. Defaults to the repo's default branch. */
  ref?: string;
  /** Shallow by default: agents need the working tree, not the history. */
  depth?: number;
}

export interface CommitIdentity {
  name: string;
  email: string;
}

export interface GitOps {
  clone(input: CloneInput): Promise<{ headSha: string }>;
  /** Create `branch` from the current HEAD and check it out. */
  createBranch(dir: string, branch: string): Promise<void>;
  /** True when the working tree has anything to commit. */
  hasChanges(dir: string): Promise<boolean>;
  /** Stage everything and commit. Returns null when there was nothing to commit. */
  commitAll(
    dir: string,
    message: string,
    identity: CommitIdentity,
  ): Promise<{ sha: string } | null>;
  push(dir: string, branch: string): Promise<void>;
  headSha(dir: string): Promise<string>;
}

/** A git command that failed, with its output already redacted. */
export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

export interface LocalGitOptions {
  /** Injected so tests can assert on the exact commands without running git. */
  exec?: (
    file: string,
    args: string[],
    options: { cwd?: string; env: NodeJS.ProcessEnv },
  ) => Promise<{ stdout: string; stderr: string }>;
  log?: (message: string) => void;
}

export class LocalGit implements GitOps {
  private readonly exec: NonNullable<LocalGitOptions["exec"]>;
  private readonly log: (message: string) => void;

  constructor(
    private readonly token: string | null,
    options: LocalGitOptions = {},
  ) {
    this.exec =
      options.exec ??
      ((file, args, opts) => run(file, args, { ...opts, maxBuffer: 32 * 1024 * 1024 }));
    this.log = options.log ?? (() => {});
  }

  async clone(input: CloneInput): Promise<{ headSha: string }> {
    // A resumed run re-enters a workspace that already holds the checkout —
    // and the agent's edits. Cloning over it would throw them away, so this is
    // idempotent: an existing checkout is kept as it is.
    if (await this.isRepo(input.dir)) {
      this.log(`git clone skipped: ${input.dir} is already a checkout`);
      return { headSha: await this.headSha(input.dir) };
    }

    const args = ["clone", "--quiet"];
    if (input.depth !== 0) args.push("--depth", String(input.depth ?? 1));
    if (input.ref) args.push("--branch", input.ref);
    args.push(this.remoteUrl(input.repo), input.dir);

    await this.git(args);
    return { headSha: await this.headSha(input.dir) };
  }

  /** True when `dir` already contains a git checkout. */
  private async isRepo(dir: string): Promise<boolean> {
    try {
      const { stdout } = await this.git(["rev-parse", "--is-inside-work-tree"], dir);
      return stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  async createBranch(dir: string, branch: string): Promise<void> {
    await this.git(["checkout", "-b", branch], dir);
  }

  async hasChanges(dir: string): Promise<boolean> {
    const { stdout } = await this.git(["status", "--porcelain"], dir);
    return stdout.trim().length > 0;
  }

  async commitAll(
    dir: string,
    message: string,
    identity: CommitIdentity,
  ): Promise<{ sha: string } | null> {
    if (!(await this.hasChanges(dir))) return null;

    await this.git(["add", "--all"], dir);
    await this.git(["commit", "--message", message], dir, {
      // Identity through the environment, so no config is written into the
      // workspace and the target repo's own config is left alone.
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
    });

    return { sha: await this.headSha(dir) };
  }

  async push(dir: string, branch: string): Promise<void> {
    await this.git(["push", "--set-upstream", "origin", branch], dir);
  }

  async headSha(dir: string): Promise<string> {
    const { stdout } = await this.git(["rev-parse", "HEAD"], dir);
    return stdout.trim();
  }

  private remoteUrl(repo: string): string {
    // No credentials in the URL: it would be persisted in .git/config, inside
    // the very workspace the agent can read.
    return `https://github.com/${repo}.git`;
  }

  /** The Basic credential git will send, built fresh for each command. */
  private authEnv(): NodeJS.ProcessEnv {
    if (!this.token) return {};

    const header = `Authorization: Basic ${Buffer.from(`x-access-token:${this.token}`).toString("base64")}`;
    return {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: header,
    };
  }

  private async git(
    args: string[],
    cwd?: string,
    extraEnv: NodeJS.ProcessEnv = {},
  ): Promise<{ stdout: string; stderr: string }> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.authEnv(),
      ...extraEnv,
      // Never block a run waiting for a password prompt no one can answer.
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
      // Deterministic output regardless of the operator's locale.
      LC_ALL: "C",
    };

    this.log(`git ${this.safe(args.join(" "))}`);

    try {
      const result = await this.exec("git", args, { ...(cwd ? { cwd } : {}), env });
      return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    } catch (error) {
      const detail =
        typeof error === "object" && error !== null
          ? `${(error as { stderr?: string }).stderr ?? ""}${(error as { message?: string }).message ?? ""}`
          : String(error);
      throw new GitError(`git ${this.safe(args[0] ?? "")} failed: ${this.safe(detail).trim()}`);
    }
  }

  /** Nothing derived from the token reaches a log or an error message. */
  private safe(text: string): string {
    const header = this.token
      ? Buffer.from(`x-access-token:${this.token}`).toString("base64")
      : null;
    return redact(text, [this.token, header]);
  }
}
