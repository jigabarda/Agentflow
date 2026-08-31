import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Per-run workspaces.
 *
 * Every run gets a fresh, isolated directory, and it is deleted when the run
 * ends. Agents may read and write only inside it — that confinement is the
 * single biggest limit on the blast radius of a misbehaving or hijacked agent
 * (docs/SECURITY.md, principle 2).
 */

export interface Workspace {
  /** Absolute, symlink-resolved path. */
  dir: string;
  /** Remove the workspace and everything in it. Safe to call twice. */
  cleanup: () => void;
}

const PREFIX = "agentflow-run-";

export function createWorkspace(runId: string, root?: string): Workspace {
  const base = root ?? os.tmpdir();
  mkdirSync(base, { recursive: true });

  // mkdtemp gives a unique directory even if two runs share an id somehow.
  const created = mkdtempSync(path.join(base, `${PREFIX}${sanitize(runId)}-`));
  // Resolve symlinks up front (macOS /var → /private/var), so every later
  // containment check compares like with like.
  const dir = realpathSync(created);

  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Where run workspaces live.
 *
 * `AGENTFLOW_WORKSPACE_ROOT` matters in a container: the default temp directory
 * is inside the image's writable layer, so a run parked at an approval gate
 * would lose its clone — and the agent's edits with it — the moment the
 * container restarted. Pointing this at a volume is what makes a gate survive
 * a restart (docker-compose.yml).
 */
export function workspaceRoot(): string {
  const configured = process.env.AGENTFLOW_WORKSPACE_ROOT?.trim();
  return configured || path.join(os.tmpdir(), "agentflow");
}

/** Keep run ids from escaping into the path. */
function sanitize(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
}

/**
 * Is `candidate` inside `workspaceDir`?
 *
 * Resolves both sides first, so `..` traversal, absolute paths, and symlinked
 * parents are all handled rather than pattern-matched. The workspace itself
 * counts as inside; a sibling whose name merely starts the same does not.
 */
export function isInsideWorkspace(workspaceDir: string, candidate: string): boolean {
  const root = resolveExisting(path.resolve(workspaceDir));
  const target = resolveExisting(path.resolve(workspaceDir, candidate));

  if (target === root) return true;
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Resolve symlinks as far as the path exists.
 *
 * A file the agent is about to create does not exist yet, so resolving its
 * nearest existing ancestor is what actually matters: a symlinked parent is
 * the escape route, and this closes it.
 */
function resolveExisting(target: string): string {
  let current = path.resolve(target);
  const trailing: string[] = [];

  for (let guard = 0; guard < 64; guard++) {
    try {
      return path.join(realpathSync(current), ...trailing);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...trailing);
      trailing.unshift(path.basename(current));
      current = parent;
    }
  }
  return path.resolve(target);
}

/** File-path arguments a tool call might carry, for containment checks. */
export function pathsInToolInput(input: unknown): string[] {
  if (typeof input !== "object" || input === null) return [];

  const keys = ["file_path", "path", "notebook_path", "filePath"];
  const found: string[] = [];
  for (const key of keys) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim() !== "") found.push(value);
  }
  return found;
}

/**
 * The workspace for a run, by name rather than at random.
 *
 * `createWorkspace` uses mkdtemp, which is right when a fresh directory is all
 * you need. A run that parks at an approval gate needs the opposite: when it
 * resumes, minutes or days later, it must find the same clone and the same
 * edits the agent made. So this path is derived from the run id and creating it
 * twice is harmless.
 */
export function openRunWorkspace(runId: string, root?: string): Workspace {
  const base = root ?? workspaceRoot();
  mkdirSync(base, { recursive: true });

  const dir = path.join(realpathSync(base), `${PREFIX}${sanitize(runId)}`);
  mkdirSync(dir, { recursive: true });

  return {
    dir: realpathSync(dir),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
