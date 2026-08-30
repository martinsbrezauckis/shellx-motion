import { describe, expect, it } from "vitest";
import {
  buildAgentRuntime,
  DEFAULT_AGENT_OUTPUT_MAX_BYTES,
  type AgentAdapter,
  type AgentCommand,
  type AgentRunner
} from "./index";

const adapter: AgentAdapter = {
  id: "diagnostic-fixture",
  label: "Diagnostic Fixture",
  transport: "local-cli",
  billing: "cli-subscription",
  promptContextMode: "prompt-only",
  probeCommand: () => ({ executable: "diagnostic-fixture", args: ["--version"], shell: false }),
  promptCommand: (input) => ({ executable: "diagnostic-fixture", args: ["run"], stdin: input.prompt, shell: false })
};

describe("agent diagnostic projection", () => {
  it("caps override ceilings before raw diagnostics are projected to health", async () => {
    const commands: AgentCommand[] = [];
    const runner: AgentRunner = async (command) => {
      commands.push(command);
      return command.args.includes("--version")
        ? { exitCode: 0, stdout: "v".repeat(900), stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "failed" };
    };
    const [health] = await buildAgentRuntime({
      adapters: [adapter],
      runner,
      maxOutputBytes: DEFAULT_AGENT_OUTPUT_MAX_BYTES * 2,
      maxTranscriptBytes: 128 * 1024
    }).health();

    expect(commands[0]?.maxOutputBytes).toBe(DEFAULT_AGENT_OUTPUT_MAX_BYTES);
    expect(Buffer.byteLength(health!.detail)).toBeLessThanOrEqual(512);
    expect(health!.detail.endsWith("…")).toBe(true);
  });

  it("bounds raw transcript bytes before redacting partial credentials, controls, and paths", async () => {
    const partial = `sk-proj-${"a".repeat(10)}\u001b[0m${"b".repeat(10)}`;
    const runner: AgentRunner = async (command) => command.args.includes("--version")
      ? { exitCode: 0, stdout: "ok", stderr: "" }
      : {
          exitCode: 1,
          stdout: partial,
          stderr: "\u001b]8;;https://example.invalid\u0007hidden\u001b\\ C:\\Users\\TestUser\\secret.txt /opt/fixture/private\u202E"
        };
    const result = await buildAgentRuntime({ adapters: [adapter], runner, maxTranscriptBytes: 64 }).runPrompt({
      agentId: adapter.id,
      prompt: "show failure",
      packageId: "lower-third",
      permission: "render_motion"
    });

    expect(result).toMatchObject({ ok: false, error: { code: "agent_failed" } });
    const published = JSON.stringify(result);
    expect(published).toContain("[redacted]");
    expect(published).not.toContain("sk-proj-");
    expect(published).not.toContain("\u001b");
    expect(published).not.toContain("C:\\Users\\TestUser");
    expect(published).not.toContain("/opt/fixture/private");
    expect(published).not.toContain("\u202E");
  });

  it("sanitizes structured scalar diagnostics without altering ordinary JSON values", async () => {
    const runner: AgentRunner = async (command) => command.args.includes("--version")
      ? { exitCode: 0, stdout: "ok", stderr: "" }
      : {
          exitCode: 0,
          stdout: JSON.stringify({
            keep: "ordinary value",
            diagnostic: "Bearer abcdefghijklmnop /srv/private/file C:\\Users\\TestUser\\file\u001b[8m\u202E"
          }),
          stderr: ""
        };
    const result = await buildAgentRuntime({ adapters: [adapter], runner }).runPrompt({
      agentId: adapter.id,
      prompt: "return JSON",
      packageId: "lower-third",
      permission: "render_motion"
    });

    expect(result).toMatchObject({
      ok: true,
      structuredOutput: { keep: "ordinary value", diagnostic: "Bearer [redacted] <path> <path>" }
    });
  });
});
