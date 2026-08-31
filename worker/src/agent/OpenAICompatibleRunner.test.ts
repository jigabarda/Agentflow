import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createWorkspace } from "../workspace/index";
import { AgentRunFailure } from "./AgentRunner";
import type { AgentRunRequest } from "./AgentRunner";
import { OpenAICompatibleRunner, toolsForAllowlist } from "./OpenAICompatibleRunner";

/**
 * The runner that makes AgentFlow usable without an Anthropic account: a local
 * Ollama model, or any free hosted tier speaking the OpenAI-compatible API.
 */

const workspaces: { cleanup: () => void }[] = [];
afterEach(() => {
  for (const ws of workspaces.splice(0)) ws.cleanup();
});

function workspace() {
  const ws = createWorkspace("run_openai");
  workspaces.push(ws);
  return ws;
}

function request(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    provider: "ollama",
    model: "qwen2.5-coder",
    prompt: "Create a hello file",
    allowedTools: ["Read", "Write"],
    workspaceDir: overrides.workspaceDir ?? workspace().dir,
    credential: { baseUrl: "http://localhost:11434/v1" },
    ...overrides,
  };
}

const events = { onLog: () => {} };

/** A fake endpoint that replays scripted chat-completion responses. */
function fakeEndpoint(responses: unknown[]) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const impl = vi.fn(async (url: unknown, init?: unknown) => {
    const requestInit = init as RequestInit;
    calls.push({ url: String(url), body: JSON.parse(String(requestInit.body)) });
    const next = responses.shift() ?? {
      choices: [{ message: { role: "assistant", content: "" } }],
    };
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function say(content: string, usage = 10) {
  return { choices: [{ message: { role: "assistant", content } }], usage: { total_tokens: usage } };
}

function callTool(name: string, args: Record<string, unknown>, id = "call_1") {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id, type: "function", function: { name, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
    usage: { total_tokens: 5 },
  };
}

describe("talking to an OpenAI-compatible endpoint", () => {
  it("returns the model's answer", async () => {
    const { impl } = fakeEndpoint([say("all done")]);
    const result = await new OpenAICompatibleRunner(impl).run(request(), events);

    expect(result.result).toBe("all done");
    expect(result.usage.tokens).toBe(10);
  });

  it("posts to {baseUrl}/chat/completions with the chosen model", async () => {
    const { impl, calls } = fakeEndpoint([say("ok")]);
    await new OpenAICompatibleRunner(impl).run(request({ model: "llama3.1" }), events);

    expect(calls[0]!.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(calls[0]!.body.model).toBe("llama3.1");
  });

  it("sends no Authorization header for a keyless local provider", async () => {
    const impl = vi.fn(async (_url: unknown, init?: unknown) => {
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
      return new Response(JSON.stringify(say("ok")), { status: 200 });
    });

    await new OpenAICompatibleRunner(impl as unknown as typeof fetch).run(request(), events);
    expect(impl).toHaveBeenCalled();
  });

  it("sends a bearer token when a hosted free tier supplies one", async () => {
    let seen: string | undefined;
    const impl = vi.fn(async (_url: unknown, init?: unknown) => {
      seen = ((init as RequestInit).headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify(say("ok")), { status: 200 });
    });

    await new OpenAICompatibleRunner(impl as unknown as typeof fetch).run(
      request({
        provider: "openai-compat",
        credential: { apiKey: "gsk_free_tier", baseUrl: "https://api.groq.com/openai/v1" },
      }),
      events,
    );

    expect(seen).toBe("Bearer gsk_free_tier");
  });

  it("fails clearly when no base URL is configured", async () => {
    const { impl } = fakeEndpoint([]);
    await expect(
      new OpenAICompatibleRunner(impl).run(request({ credential: {} }), events),
    ).rejects.toThrow(/needs a base URL/);
  });

  it("reports an unreachable endpoint in plain language", async () => {
    const impl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    await expect(new OpenAICompatibleRunner(impl).run(request(), events)).rejects.toThrow(
      /Could not reach "ollama"/,
    );
  });

  it("reports an HTTP error with its status", async () => {
    const impl = (async () =>
      new Response("model not found", { status: 404 })) as unknown as typeof fetch;

    await expect(new OpenAICompatibleRunner(impl).run(request(), events)).rejects.toThrow(/404/);
  });
});

describe("the tool loop lets a free model actually do work", () => {
  it("writes a file the model asked for, inside the workspace", async () => {
    const ws = workspace();
    const { impl } = fakeEndpoint([
      callTool("write_file", { path: "hello.txt", content: "hi there" }),
      say("created hello.txt"),
    ]);

    const result = await new OpenAICompatibleRunner(impl).run(
      request({ workspaceDir: ws.dir }),
      events,
    );

    expect(readFileSync(path.join(ws.dir, "hello.txt"), "utf8")).toBe("hi there");
    expect(result.filesChanged).toEqual(["hello.txt"]);
    expect(result.toolCalls[0]).toMatchObject({ name: "write_file", allowed: true });
  });

  it("reads a file back to the model", async () => {
    const ws = workspace();
    writeFileSync(path.join(ws.dir, "notes.md"), "the existing content");

    const { impl, calls } = fakeEndpoint([
      callTool("read_file", { path: "notes.md" }),
      say("I read it"),
    ]);

    await new OpenAICompatibleRunner(impl).run(request({ workspaceDir: ws.dir }), events);

    const followUp = calls[1]!.body.messages as { role: string; content: string }[];
    expect(followUp.at(-1)).toMatchObject({ role: "tool", content: "the existing content" });
  });

  it("REFUSES a write outside the workspace and tells the model so", async () => {
    const ws = workspace();
    const { impl, calls } = fakeEndpoint([
      callTool("write_file", { path: "../escaped.txt", content: "nope" }),
      say("understood"),
    ]);

    const result = await new OpenAICompatibleRunner(impl).run(
      request({ workspaceDir: ws.dir }),
      events,
    );

    expect(existsSync(path.join(path.dirname(ws.dir), "escaped.txt"))).toBe(false);
    expect(result.toolCalls[0]).toMatchObject({ name: "write_file", allowed: false });

    const followUp = calls[1]!.body.messages as { role: string; content: string }[];
    expect(followUp.at(-1)!.content).toContain("outside the workspace");
  });

  it("REFUSES a tool the node's allowlist does not grant", async () => {
    const { impl } = fakeEndpoint([
      callTool("write_file", { path: "a.txt", content: "x" }),
      say("ok"),
    ]);

    const result = await new OpenAICompatibleRunner(impl).run(
      request({ allowedTools: ["Read"] }),
      events,
    );

    expect(result.toolCalls[0]).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("allowlist"),
    });
  });

  it("stops after a bounded number of turns rather than looping forever", async () => {
    const forever = Array.from({ length: 40 }, () => callTool("read_file", { path: "x.txt" }));
    const { impl } = fakeEndpoint(forever);

    await expect(
      new OpenAICompatibleRunner(impl).run(request({ allowedTools: ["Read"] }), events),
    ).rejects.toThrow(AgentRunFailure);
  });

  it("passes a tool error back to the model instead of failing the run", async () => {
    const { impl, calls } = fakeEndpoint([
      callTool("read_file", { path: "missing.txt" }),
      say("that file was not there"),
    ]);

    const result = await new OpenAICompatibleRunner(impl).run(request(), events);

    expect(result.result).toBe("that file was not there");
    const followUp = calls[1]!.body.messages as { role: string; content: string }[];
    expect(followUp.at(-1)!.content).toContain("Error:");
  });
});

describe("mapping the editor's tool names onto this runner", () => {
  it("translates the Claude tool vocabulary", () => {
    expect(toolsForAllowlist(["Read"]).tools).toEqual(["read_file"]);
    expect(toolsForAllowlist(["Write", "Edit"]).tools).toEqual(["write_file"]);
    expect(toolsForAllowlist(["Glob", "Grep"]).tools).toEqual(["list_files"]);
  });

  it("reports Bash as unsupported rather than pretending to offer it", () => {
    const { tools, unsupported } = toolsForAllowlist(["Read", "Bash"]);
    expect(tools).toEqual(["read_file"]);
    expect(unsupported).toEqual(["Bash"]);
  });

  it("offers no tools when the node grants none", () => {
    expect(toolsForAllowlist([]).tools).toEqual([]);
  });
});
