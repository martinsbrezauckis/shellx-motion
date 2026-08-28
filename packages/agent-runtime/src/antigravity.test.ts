/**
 * Antigravity adapter contract tests.
 *
 * Covers the three things that make this adapter different from the stdin
 * adapters: argv-carried prompt, the `--print`-last invariant, and the honest
 * empty-stdout (issue #76) failure path.
 */
import { describe, expect, it } from "vitest";
import {
  ANTIGRAVITY_EXECUTABLE,
  ANTIGRAVITY_PRINT_FLAG,
  antigravityAdapter,
  antigravityCliCommand,
  AntigravityPrintOrderError,
  assertAntigravityPrintLast,
  AGENT_CONTEXT_UNBOUNDED_CODE,
  buildAgentRuntime,
  createCliAgentAdapters,
  type AgentRunner
} from "./index";

describe("antigravity adapter", () => {
  it("registers as a local CLI subscription adapter alongside the stdin agents", () => {
    const agents = createCliAgentAdapters();

    expect(agents.map((agent) => agent.id)).toEqual(["codex", "claude-code", "grok", "antigravity"]);
    const antigravity = agents.find((agent) => agent.id === "antigravity");
    expect(antigravity).toMatchObject({
      label: "Antigravity CLI",
      transport: "local-cli",
      billing: "cli-subscription",
      promptContextMode: "filesystem-read"
    });
    expect(antigravity?.probeCommand()).toEqual({
      executable: "agy",
      args: ["--version"],
      shell: false
    });
  });

  it("does not register a Kimi adapter, because no Kimi invocation contract exists yet", () => {
    expect(createCliAgentAdapters().map((agent) => agent.id)).not.toContain("kimi");
  });

  it("carries the prompt as the --print value in argv rather than on stdin", () => {
    const command = antigravityCliCommand({ prompt: "preview current package", cwd: "/workspace" });

    expect(command.executable).toBe(ANTIGRAVITY_EXECUTABLE);
    expect(command.shell).toBe(false);
    expect(command.cwd).toBe("/workspace");
    // The whole point of this adapter: no stdin channel exists for agy --print.
    expect(command.stdin).toBeUndefined();
    expect(command.args.at(-2)).toBe(ANTIGRAVITY_PRINT_FLAG);
    expect(command.args.at(-1)).toBe("preview current package");
  });

  it("requests plan mode, the JSON transport envelope, sandboxing, and cwd scope", () => {
    const command = antigravityCliCommand({ prompt: "hello", cwd: "/workspace" });

    expect(command.args).toEqual([
      "--sandbox",
      "--mode",
      "plan",
      "--output-format",
      "json",
      "--add-dir",
      "/workspace",
      "--print",
      "hello"
    ]);
    // Motion's typed dispatcher governs mutation, so the provider stays in
    // plan mode and its auto-approve flag must never be passed.
    expect(command.args).not.toContain("--dangerously-skip-permissions");
  });

  it("builds a pure argv that depends only on the prompt and cwd", () => {
    // motion.agent.panel serialises this argv via promptCommand({ prompt: "" }),
    // so ambient state (cwd of the server, env) must never leak into it.
    const previous = process.env.SHELLX_MOTION_SCRATCH_ROOT;
    process.env.SHELLX_MOTION_SCRATCH_ROOT = "/some/host/specific/root";
    try {
      expect(antigravityCliCommand({ prompt: "" }).args).toEqual([
        "--sandbox",
        "--mode",
        "plan",
        "--output-format",
        "json",
        "--print",
        ""
      ]);
    } finally {
      if (previous === undefined) delete process.env.SHELLX_MOTION_SCRATCH_ROOT;
      else process.env.SHELLX_MOTION_SCRATCH_ROOT = previous;
    }
  });

  it("omits --add-dir when no working directory is supplied", () => {
    const command = antigravityCliCommand({ prompt: "hello" });

    expect(command.args).not.toContain("--add-dir");
    expect(command.args.at(-2)).toBe(ANTIGRAVITY_PRINT_FLAG);
  });

  it("keeps a prompt that looks like a flag as an inert argv value", () => {
    const command = antigravityCliCommand({ prompt: "--dangerously-skip-permissions --print pwned" });

    // A prompt is data. It lands in exactly one argv slot, and because shell is
    // false it is never re-tokenised into separate flags.
    expect(command.args.at(-1)).toBe("--dangerously-skip-permissions --print pwned");
    expect(command.args.filter((arg) => arg === ANTIGRAVITY_PRINT_FLAG)).toHaveLength(1);
  });

  it("freezes argv so a later append after the prompt value throws instead of corrupting it", () => {
    const command = antigravityCliCommand({ prompt: "hello", cwd: "/workspace" });

    expect(Object.isFrozen(command.args)).toBe(true);
    expect(() => command.args.push("--model")).toThrow(TypeError);
    expect(command.args.at(-1)).toBe("hello");
  });

  it("rejects argv that places anything after the --print prompt value", () => {
    expect(() => assertAntigravityPrintLast(["--print", "hello", "--output-format"]))
      .toThrow(AntigravityPrintOrderError);
    expect(() => assertAntigravityPrintLast(["--sandbox", "--print", "hello", "extra"]))
      .toThrow(/1 argument\(s\) after the prompt/);
    expect(() => assertAntigravityPrintLast(["--sandbox", "--print"]))
      .toThrow(AntigravityPrintOrderError);
    expect(() => assertAntigravityPrintLast(["--sandbox", "json"]))
      .toThrow(/must contain --print/);
    expect(() => assertAntigravityPrintLast(["--print", "a", "--print", "b"]))
      .toThrow(/exactly one --print; found 2/);
    expect(() => assertAntigravityPrintLast(["--sandbox", "--print", "hello"])).not.toThrow();
  });

  it("keeps Antigravity health-visible but refuses its unbounded prompt context", async () => {
    const commands: string[][] = [];
    const runner: AgentRunner = async (command) => {
      commands.push(command.args);
      return { exitCode: 0, stdout: "1.1.8", stderr: "" };
    };
    const runtime = buildAgentRuntime({ adapters: [antigravityAdapter()], runner });

    await expect(runtime.health()).resolves.toMatchObject([{ agentId: "antigravity", available: true, status: "ready" }]);
    const result = await runtime.runPrompt({
      agentId: "antigravity",
      prompt: "preview current package",
      packageId: "lower-third",
      permission: "render_motion"
    });

    expect(result).toMatchObject({ ok: false, error: { code: AGENT_CONTEXT_UNBOUNDED_CODE } });
    expect(commands).toEqual([["--version"]]);
  });

  it("does not probe or spawn Antigravity when prompt execution is requested", async () => {
    const runner: AgentRunner = async () => {
      throw new Error("unbounded prompt execution must not invoke the runner");
    };
    const runtime = buildAgentRuntime({ adapters: [antigravityAdapter()], runner });

    const result = await runtime.runPrompt({
      agentId: "antigravity",
      prompt: "preview current package",
      packageId: "lower-third",
      permission: "render_motion"
    });

    expect(result).toMatchObject({ ok: false, error: { code: AGENT_CONTEXT_UNBOUNDED_CODE } });
  });

  it("refuses Codex read-only mode because it can still read the filesystem", async () => {
    const runner: AgentRunner = async (command) => command.args.includes("--version")
      ? { exitCode: 0, stdout: "ok", stderr: "" }
      : { exitCode: 0, stdout: "", stderr: "" };
    const [codex] = createCliAgentAdapters();
    const runtime = buildAgentRuntime({ adapters: [codex], runner });

    const result = await runtime.runPrompt({
      agentId: "codex",
      prompt: "preview current package",
      packageId: "lower-third",
      permission: "render_motion"
    });

    expect(result).toMatchObject({ ok: false, error: { code: AGENT_CONTEXT_UNBOUNDED_CODE } });
  });
});
