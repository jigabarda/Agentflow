import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createWorkspace,
  isInsideWorkspace,
  openRunWorkspace,
  pathsInToolInput,
  workspaceRoot,
} from "./index";

const created: { cleanup: () => void }[] = [];

function workspace() {
  const ws = createWorkspace("run_1");
  created.push(ws);
  return ws;
}

afterEach(() => {
  for (const ws of created.splice(0)) ws.cleanup();
});

describe("per-run workspaces", () => {
  it("creates a real, empty directory", () => {
    const ws = workspace();
    expect(existsSync(ws.dir)).toBe(true);
    expect(path.isAbsolute(ws.dir)).toBe(true);
  });

  it("gives each run its own directory", () => {
    expect(workspace().dir).not.toBe(workspace().dir);
  });

  it("deletes the workspace and its contents on cleanup", () => {
    const ws = createWorkspace("run_cleanup");
    writeFileSync(path.join(ws.dir, "scratch.txt"), "work in progress");

    ws.cleanup();

    expect(existsSync(ws.dir)).toBe(false);
  });

  it("can be cleaned up twice without complaining", () => {
    const ws = createWorkspace("run_twice");
    ws.cleanup();
    expect(() => ws.cleanup()).not.toThrow();
  });

  it("keeps a hostile run id out of the path", () => {
    const ws = createWorkspace("../../etc/passwd");
    created.push(ws);
    expect(ws.dir).not.toContain("..");
    expect(path.dirname(ws.dir)).toBe(realpathSync(os.tmpdir()));
  });
});

describe("workspace confinement", () => {
  it("allows paths inside the workspace", () => {
    const ws = workspace();
    expect(isInsideWorkspace(ws.dir, "src/index.ts")).toBe(true);
    expect(isInsideWorkspace(ws.dir, "./nested/deep/file.txt")).toBe(true);
    expect(isInsideWorkspace(ws.dir, ws.dir)).toBe(true);
  });

  it("BLOCKS a parent-directory escape", () => {
    const ws = workspace();
    expect(isInsideWorkspace(ws.dir, "../outside.txt")).toBe(false);
    expect(isInsideWorkspace(ws.dir, "../../etc/passwd")).toBe(false);
    expect(isInsideWorkspace(ws.dir, "src/../../escape.txt")).toBe(false);
  });

  it("BLOCKS an absolute path outside the workspace", () => {
    const ws = workspace();
    expect(isInsideWorkspace(ws.dir, path.join(os.homedir(), ".ssh", "id_rsa"))).toBe(false);
    expect(isInsideWorkspace(ws.dir, os.tmpdir())).toBe(false);
  });

  it("allows an absolute path that IS inside the workspace", () => {
    const ws = workspace();
    expect(isInsideWorkspace(ws.dir, path.join(ws.dir, "src", "main.ts"))).toBe(true);
  });

  it("is not fooled by a sibling whose name merely shares the prefix", () => {
    const ws = workspace();
    expect(isInsideWorkspace(ws.dir, `${ws.dir}-evil/secrets.txt`)).toBe(false);
  });

  it("BLOCKS a write through a symlinked directory pointing outside", () => {
    const ws = workspace();
    const outside = createWorkspace("run_outside");
    created.push(outside);

    const link = path.join(ws.dir, "escape-hatch");
    try {
      symlinkSync(outside.dir, link, "dir");
    } catch {
      // Windows without developer mode cannot create symlinks; the guard is
      // still exercised by the other cases.
      return;
    }

    // The path looks like it is inside, but resolving it lands elsewhere.
    expect(isInsideWorkspace(ws.dir, "escape-hatch/stolen.txt")).toBe(false);
  });

  it("allows a file that does not exist yet, inside a directory that does", () => {
    const ws = workspace();
    mkdirSync(path.join(ws.dir, "src"), { recursive: true });
    expect(isInsideWorkspace(ws.dir, "src/not-created-yet.ts")).toBe(true);
  });
});

describe("finding paths in a tool call", () => {
  it("picks up the usual file arguments", () => {
    expect(pathsInToolInput({ file_path: "/etc/passwd" })).toEqual(["/etc/passwd"]);
    expect(pathsInToolInput({ path: "src/a.ts" })).toEqual(["src/a.ts"]);
    expect(pathsInToolInput({ notebook_path: "nb.ipynb" })).toEqual(["nb.ipynb"]);
  });

  it("returns nothing for a tool call with no path", () => {
    expect(pathsInToolInput({ command: "ls" })).toEqual([]);
    expect(pathsInToolInput(null)).toEqual([]);
    expect(pathsInToolInput("string")).toEqual([]);
  });
});

describe("workspaceRoot", () => {
  const original = process.env.AGENTFLOW_WORKSPACE_ROOT;

  afterEach(() => {
    if (original === undefined) delete process.env.AGENTFLOW_WORKSPACE_ROOT;
    else process.env.AGENTFLOW_WORKSPACE_ROOT = original;
  });

  it("falls back to a temp directory when nothing is configured", () => {
    delete process.env.AGENTFLOW_WORKSPACE_ROOT;
    expect(workspaceRoot()).toContain("agentflow");
  });

  it("honours the configured root, which is how a volume gets used", () => {
    // In a container the default is inside the writable layer, so a run parked
    // at a gate would lose its clone on restart.
    process.env.AGENTFLOW_WORKSPACE_ROOT = "/workspaces";
    expect(workspaceRoot()).toBe("/workspaces");
  });

  it("ignores a blank setting rather than using the filesystem root", () => {
    process.env.AGENTFLOW_WORKSPACE_ROOT = "   ";
    expect(workspaceRoot()).not.toBe("");
    expect(workspaceRoot()).toContain("agentflow");
  });

  it("puts a run's directory under the configured root", () => {
    process.env.AGENTFLOW_WORKSPACE_ROOT = mkdtempSync(path.join(os.tmpdir(), "af-root-"));
    const workspace = openRunWorkspace("run_abc");

    expect(workspace.dir.startsWith(realpathSync(process.env.AGENTFLOW_WORKSPACE_ROOT))).toBe(true);
    workspace.cleanup();
  });

  it("gives the same run the same directory twice, so a resume finds its clone", () => {
    process.env.AGENTFLOW_WORKSPACE_ROOT = mkdtempSync(path.join(os.tmpdir(), "af-root-"));

    const first = openRunWorkspace("run_same");
    const second = openRunWorkspace("run_same");

    expect(second.dir).toBe(first.dir);
    first.cleanup();
  });
});
