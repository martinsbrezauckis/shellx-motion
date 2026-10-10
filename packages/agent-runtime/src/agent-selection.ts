export const AGENT_SELECTION_REQUIRED_CODE = "agent_selection_required";

interface PromptSelectionAdapter {
  id: string;
  promptContextMode?: string;
}

/** The built-in runtime never chooses an adapter from health or declaration order. */
export function agentSelectionRequired(adapters: readonly PromptSelectionAdapter[]) {
  const promptOnlyIds = adapters
    .filter((candidate) => candidate.promptContextMode === "prompt-only")
    .map((candidate) => candidate.id);
  return {
    ok: false as const,
    error: {
      code: AGENT_SELECTION_REQUIRED_CODE,
      message: "Select a prompt-capable agent explicitly before running a prompt.",
      detail: promptOnlyIds.length > 0
        ? `Set agentId to one of: ${promptOnlyIds.join(", ")}.`
        : "No prompt-capable adapters are configured. Configure one, then set agentId explicitly."
    }
  };
}
