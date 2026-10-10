import { describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "../index.js";

describe("agent selection panels", () => {
  it("labels built-in candidates as declared when the host did not provide an agent runtime", async () => {
    const result = await dispatchDebugCommand("motion.actions.panel", {}, { tier: "read_motion" });

    expect(result).toMatchObject({
      ok: true,
      result: {
        promptProviderSelection: {
          candidateSource: "declared-built-in-candidates",
          promptCapableAgentIds: ["claude-code", "grok"],
          message: "Select agentId explicitly. Declared built-in prompt-capable candidates: claude-code, grok; host readiness is not checked here."
        }
      }
    });
  });

  it("uses a custom host list without probing it", async () => {
    let healthCalls = 0;
    const agentRuntime = {
      health: async () => {
        healthCalls += 1;
        return [];
      },
      listAgents: () => [{
        id: "host-safe",
        label: "Host Safe Agent",
        transport: "local-cli" as const,
        billing: "cli-subscription" as const,
        promptContextMode: "prompt-only" as const,
        probeCommand: () => ({ executable: "host-safe", args: ["--version"], shell: false as const }),
        promptCommand: (input: { prompt: string; cwd?: string }) => ({ executable: "host-safe", args: ["run"], stdin: input.prompt, ...(input.cwd ? { cwd: input.cwd } : {}), shell: false as const })
      }]
    };

    const [actionsPanel, agentPanel] = await Promise.all([
      dispatchDebugCommand("motion.actions.panel", {}, { tier: "read_motion", agentRuntime }),
      dispatchDebugCommand("motion.agent.panel", {}, { tier: "read_motion", agentRuntime })
    ]);

    expect(healthCalls).toBe(0);
    expect(actionsPanel).toMatchObject({
      ok: true,
      result: {
        promptProviderSelection: {
          candidateSource: "host-runtime",
          promptCapableAgentIds: ["host-safe"],
          message: "Select agentId explicitly from host-declared prompt-capable adapters: host-safe."
        }
      }
    });
    expect(agentPanel).toMatchObject({
      ok: true,
      result: {
        selectionPolicy: { candidateSource: "host-runtime", promptCapableAgentIds: ["host-safe"] },
        adapters: [expect.objectContaining({ agentId: "host-safe", promptCapable: true })]
      }
    });
  });
});
