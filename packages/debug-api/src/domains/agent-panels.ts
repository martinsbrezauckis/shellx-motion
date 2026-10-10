import { buildAgentRuntime, type AgentAdapter, type AgentRuntime } from "@shellx-motion/agent-runtime";

export type AgentPanelRuntime = Pick<AgentRuntime, "health"> & Partial<Pick<AgentRuntime, "listAgents">>;
export type PromptCandidateSource = "host-runtime" | "declared-built-in-candidates";

export interface PromptProviderSelection {
  selectionRequired: true;
  argument: "agentId";
  promptCapableAgentIds: string[];
  candidateSource: PromptCandidateSource;
  message: string;
}

export interface PromptPanelCandidates {
  adapters: AgentAdapter[];
  promptCapableAgentIds: string[];
  candidateSource: PromptCandidateSource;
}

export function promptPanelCandidates(agentRuntime?: AgentPanelRuntime): PromptPanelCandidates {
  const adapters = agentRuntime?.listAgents?.() ?? buildAgentRuntime().listAgents();
  const candidateSource: PromptCandidateSource = agentRuntime?.listAgents ? "host-runtime" : "declared-built-in-candidates";
  return {
    adapters,
    promptCapableAgentIds: adapters.filter((adapter) => adapter.promptContextMode === "prompt-only").map((adapter) => adapter.id),
    candidateSource
  };
}

export function promptProviderSelection(candidates: PromptPanelCandidates): PromptProviderSelection {
  const { candidateSource, promptCapableAgentIds } = candidates;
  return {
    selectionRequired: true,
    argument: "agentId",
    promptCapableAgentIds,
    candidateSource,
    message: promptCapableAgentIds.length > 0
      ? candidateSource === "host-runtime"
        ? `Select agentId explicitly from host-declared prompt-capable adapters: ${promptCapableAgentIds.join(", ")}.`
        : `Select agentId explicitly. Declared built-in prompt-capable candidates: ${promptCapableAgentIds.join(", ")}; host readiness is not checked here.`
      : candidateSource === "host-runtime"
        ? "The host runtime declares no prompt-capable adapters. Configure one before running a prompt."
        : "No declared built-in prompt-capable candidates are available. Configure a host runtime before running a prompt."
  };
}
