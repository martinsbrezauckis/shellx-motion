import { describe, expect, it } from "vitest";

import { AGENT_CONTEXT_UNBOUNDED_CODE, buildAgentRuntime, createCliAgentAdapters, type AgentAdapter, type AgentCommand, type AgentRunner } from "./index";

const safeAdapter: AgentAdapter = {
  id: "safe", label: "Safe Agent", transport: "local-cli", billing: "cli-subscription", promptContextMode: "prompt-only",
  probeCommand: () => ({ executable: "safe-agent", args: ["--version"], shell: false }),
  promptCommand: (input) => ({ executable: "safe-agent", args: ["run"], stdin: input.prompt, shell: false })
};

describe("agent prompt context", () => {
  it("declares only the provider contracts that disable every tool as prompt-only", () => {
    const agents = createCliAgentAdapters();
    expect(Object.fromEntries(agents.map(({ id, promptContextMode }) => [id, promptContextMode]))).toEqual({ codex: "filesystem-read", "claude-code": "prompt-only", grok: "prompt-only", antigravity: "filesystem-read" });
    expect(agents.find(({ id }) => id === "claude-code")?.promptCommand({ prompt: "plan" }).args).toContain("--tools");
    expect(agents.find(({ id }) => id === "grok")?.promptCommand({ prompt: "plan" }).args).toContain("--tools=");
  });

  it.each([["filesystem-read", "filesystem-read", "The adapter permits filesystem reads."], ["undeclared", undefined, "The adapter does not declare a prompt context mode."]] as const)("refuses %s context before probing or spawning", async (id, promptContextMode, detail) => {
    const commands: AgentCommand[] = [];
    const runner: AgentRunner = async (command) => { commands.push(command); return { exitCode: 0, stdout: "ok", stderr: "" }; };
    const result = await buildAgentRuntime({ adapters: [{ ...safeAdapter, id, promptContextMode }], runner }).runPrompt({ agentId: id, prompt: "plan", permission: "draft_motion" });
    expect(result).toEqual({ ok: false, error: { code: AGENT_CONTEXT_UNBOUNDED_CODE, message: "The selected agent cannot run because its context is not bounded to the prompt.", detail } });
    expect(commands).toEqual([]);
  });

  it("keeps unbounded built-ins health-visible without letting a prompt add a probe or spawn", async () => {
    const [codex] = createCliAgentAdapters();
    const commands: AgentCommand[] = [];
    const runner: AgentRunner = async (command) => { commands.push(command); return { exitCode: 0, stdout: "ok", stderr: "" }; };
    const runtime = buildAgentRuntime({ adapters: [codex], runner });
    await expect(runtime.health()).resolves.toMatchObject([{ agentId: "codex", available: true, status: "ready" }]);
    await expect(runtime.runPrompt({ agentId: "codex", prompt: "plan", permission: "draft_motion" })).resolves.toMatchObject({ ok: false, error: { code: AGENT_CONTEXT_UNBOUNDED_CODE } });
    expect(commands).toHaveLength(1);
  });
});
