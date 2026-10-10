import { findActionMatch, guideAction, planAction, type MotionActionMatch } from "@shellx-motion/actions";
import { describeAgentSetup, type AgentAdapter, type AgentSetupHints } from "@shellx-motion/agent-runtime";
import { hashBuffer } from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { buildActionsPanel } from "./actions-panel.js";
import { annotatePlanWithArgumentContracts } from "./agent-plan-arguments.js";
import { promptPanelCandidates, type AgentPanelRuntime, type PromptCandidateSource } from "./agent-panels.js";
import { nonNegativeIntegerArg, stringArg } from "./args.js";
import { dispatchAgentRevisionCommand, type AgentRevisionServices } from "./agent-revision.js";
import { dispatchAgentPromptLifecycleCommand, type AgentPromptLifecycleServices } from "./agent-prompt-lifecycle.js";
import { dispatchAgentPromptRunCommand, type AgentPromptRunServices } from "./agent-prompt-run.js";
import { dispatchMotionAgentSnapshot, type AgentSnapshotServices } from "./agent-snapshot.js";

export async function dispatchAgentCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: AgentDomainServices = {}
): Promise<MotionDebugResult | null> {
  // `request` is read INSIDE each branch that uses it, not once at the top. Read at the top it was
  // an argument of every command this dispatcher routes — including `motion.agent.health`, which
  // has no use for it — and a published schema either has to declare it everywhere or reject a call
  // the handler read. `scripts/public/debug-arg-coverage.ts` gates that agreement.
  if (command === "motion.actions.find") return { ok: true, result: actionsFindResult(requestArg(args)), warnings: [] };
  // Both plans are returned with each step's argument contract attached. Without it an agent
  // gets the call order and no way to know what to pass, which is how a "successful" run can
  // execute nothing at all.
  if (command === "motion.actions.guide") return { ok: true, result: annotatePlanWithArgumentContracts(guideAction(requestArg(args))), warnings: [] };
  if (command === "motion.actions.plan") return { ok: true, result: annotatePlanWithArgumentContracts(planAction(requestArg(args))), warnings: [] };
  if (command === "motion.actions.panel") {
    const panel = buildActionsPanel(services.agentRuntime);
    return {
      ok: true,
      visibleState: {
        panel: "actions",
        operation: "actions.panel",
        actionCount: panel.actionCount,
        promptActionCount: panel.promptActionCount,
        mutatingActionCount: panel.mutatingActionCount,
        surfaceCount: panel.surfaceCount
      },
      result: { ok: true, ...panel },
      warnings: []
    };
  }
  if (command === "motion.agent.panel") {
    const panel = buildAgentPanel(services.agentRuntime);
    const receiptId = `agent-panel-${hashBuffer(Buffer.from(JSON.stringify(panel), "utf8")).slice(0, 16)}`;
    return {
      ok: true,
      receiptId,
      visibleState: {
        panel: "agent",
        operation: "agent.panel",
        adapterCount: panel.counts.adapters,
        localCliCount: panel.counts.localCliAdapters,
        cliSubscriptionCount: panel.counts.cliSubscriptionAdapters,
        selectionRequired: panel.selectionPolicy.defaultMode === "selection-required",
        promptFollowUpCount: panel.counts.promptFollowUps,
        warningCount: panel.warnings.length
      },
      result: { ok: true, ...panel },
      warnings: panel.warnings
    };
  }
  if (command === "motion.agent.health") {
    const agentRuntime = services.agentRuntime;
    if (!agentRuntime) return capabilityUnavailable("Agent health is unavailable because this host did not inject an agent runtime.");
    const agents = await agentRuntime.health();
    const availableCount = agents.filter((agent) => agent.available).length;
    return {
      ok: true,
      visibleState: { panel: "agent", operation: "agent.health", agentCount: agents.length, availableCount },
      result: { ok: true, agents },
      warnings: []
    };
  }
  if (command === "motion.agent.snapshot") return await dispatchMotionAgentSnapshot(command, args, services); if (command === "motion.agent.transcript") return agentTranscript(args, services);
  const revision = await dispatchAgentRevisionCommand(command, args, services);
  if (revision) return revision;
  const promptLifecycle = await dispatchAgentPromptLifecycleCommand(command, args, services);
  if (promptLifecycle) return promptLifecycle;
  const promptRun = await dispatchAgentPromptRunCommand(command, args, services);
  if (promptRun) return promptRun;
  return null;
}

interface AgentTranscriptSession {
  transcript: { messageCount: number };
}

export interface AgentDomainServices extends AgentRevisionServices, AgentPromptLifecycleServices, AgentPromptRunServices, AgentSnapshotServices {
  agentRuntime?: AgentPanelRuntime;
  receiptsRoot?: string;
  isAgentReceiptPathInsideRoot?: (root: string, path: string) => Promise<boolean>;
  readAgentTranscript?: (input: {
    receiptsRoot: string;
    receiptId?: string;
    receiptPath?: string;
  }) => Promise<{ targetFound: boolean; sessions: AgentTranscriptSession[] }>;
}

/** The natural-language request the three `motion.actions.*` planning commands take. */
function requestArg(args: unknown): string {
  return stringArg(args, "request") ?? "";
}

/**
 * The `motion.actions.find` payload.
 *
 * Previously this command returned `findAction(request)` verbatim, so an unmatched query answered
 * `result: null` — a dead end that teaches an agent nothing and invites the same query again.
 * Now every answer carries `matched` and a non-empty `nearest`, and a miss additionally states in
 * words that nothing matched and names the two commands that do work with no vocabulary.
 *
 * On a hit the matched action's own fields stay at the top level. That is deliberate: hosts,
 * the CLI and the MCP smoke test all read `result.id`, and breaking them to gain symmetry would
 * trade one agent-facing defect for another.
 */
function actionsFindResult(request: string): Record<string, unknown> {
  const match: MotionActionMatch = findActionMatch(request);
  if (match.matched && match.action) {
    return {
      matched: true,
      ...match.action,
      nearest: match.nearest,
      suggestedActions: [
        { id: "plan", command: "motion.actions.plan", args: { request } },
        { id: "guide", command: "motion.actions.guide", args: { request } }
      ]
    };
  }
  return {
    matched: false,
    action: null,
    message: match.message,
    nearest: match.nearest,
    suggestedActions: [
      { id: "panel", command: "motion.actions.panel", args: {} },
      { id: "plan", command: "motion.actions.plan", args: { request } }
    ]
  };
}

async function agentTranscript(args: unknown, services: AgentDomainServices): Promise<MotionDebugResult> {
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
  const receiptId = stringArg(args, "receiptId") ?? stringArg(args, "id") ?? undefined;
  const receiptPath = stringArg(args, "receiptPath") ?? stringArg(args, "path") ?? undefined;
  const limit = nonNegativeIntegerArg(args, "limit");
  if (!receiptsRoot) return invalidArgs("motion.agent.transcript requires receiptsRoot.");
  if (limit === false) return invalidArgs("motion.agent.transcript limit must be a non-negative integer.");
  if (!services.readAgentTranscript) return capabilityUnavailable("Agent transcript receipt reading is unavailable.");
  if (receiptPath) {
    if (!services.isAgentReceiptPathInsideRoot) return capabilityUnavailable("Agent transcript path validation is unavailable.");
    if (!await services.isAgentReceiptPathInsideRoot(receiptsRoot, receiptPath)) {
      return invalidArgs("motion.agent.transcript receiptPath must be inside receiptsRoot.");
    }
  }
  const read = await services.readAgentTranscript({ receiptsRoot, ...(receiptId ? { receiptId } : {}), ...(receiptPath ? { receiptPath } : {}) });
  if ((receiptId || receiptPath) && !read.targetFound) {
    return {
      ok: false,
      error: {
        code: "receipt_not_found",
        message: receiptId ? `Receipt not found: ${receiptId}.` : `Receipt not found at path: ${receiptPath}.`
      },
      warnings: []
    };
  }
  const sessions = read.sessions.slice(0, limit ?? undefined);
  const messageCount = sessions.reduce((total, session) => total + session.transcript.messageCount, 0);
  return {
    ok: true,
    visibleState: { panel: "agent", operation: "agent.transcript", sessionCount: sessions.length, messageCount },
    result: { ok: true, receiptsRoot, sessionCount: sessions.length, messageCount, sessions },
    warnings: []
  };
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

function capabilityUnavailable(message: string): MotionDebugResult {
  return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure the required host capability and retry." }, warnings: [] };
}

interface AgentPanelCommandShape {
  executable: string;
  args: string[];
  shell: false;
}

interface AgentPanelAdapter {
  agentId: string;
  label: string;
  promptCapable: boolean;
  transport: "local-cli";
  billing: "cli-subscription";
  probe: AgentPanelCommandShape;
  prompt: AgentPanelCommandShape & { stdin: "prompt" };
  setup: AgentSetupHints;
}

interface AgentPanel {
  counts: {
    adapters: number;
    localCliAdapters: number;
    cliSubscriptionAdapters: number;
    promptFollowUps: number;
  };
  selectionPolicy: {
    defaultMode: "selection-required";
    promptCapableAgentIds: string[];
    candidateSource: PromptCandidateSource;
    selectedUnavailableFallback: "none";
    healthProbeCommand: "motion.agent.health";
  };
  adapters: AgentPanelAdapter[];
  safety: {
    shell: false;
    envInReceipts: "omitted";
    stdoutStderrRedaction: boolean;
    noPackageMutationDuringHealth: boolean;
    selectedUnavailableMutatesPackage: false;
  };
  receipts: {
    promptOperation: "prompt.run";
    agentOperation: "agent.prompt";
    transcriptCommand: "motion.agent.transcript";
  };
  suggestedActions: Array<
    | { id: "health"; command: "motion.agent.health"; args: Record<string, never> }
    | { id: "transcript"; command: "motion.agent.transcript"; args: { receiptsRoot: string } }
  >;
  warnings: string[];
}

function buildAgentPanel(agentRuntime?: AgentPanelRuntime): AgentPanel {
  const candidates = promptPanelCandidates(agentRuntime);
  const cards = candidates.adapters.map(agentPanelAdapter);
  const suggestedActions: AgentPanel["suggestedActions"] = [
    { id: "health", command: "motion.agent.health", args: {} },
    { id: "transcript", command: "motion.agent.transcript", args: { receiptsRoot: "" } }
  ];
  return {
    counts: {
      adapters: cards.length,
      localCliAdapters: cards.filter((adapter) => adapter.transport === "local-cli").length,
      cliSubscriptionAdapters: cards.filter((adapter) => adapter.billing === "cli-subscription").length,
      promptFollowUps: suggestedActions.length
    },
    selectionPolicy: {
      defaultMode: "selection-required",
      promptCapableAgentIds: candidates.promptCapableAgentIds,
      candidateSource: candidates.candidateSource,
      selectedUnavailableFallback: "none",
      healthProbeCommand: "motion.agent.health"
    },
    adapters: cards,
    safety: {
      shell: false,
      envInReceipts: "omitted",
      stdoutStderrRedaction: true,
      noPackageMutationDuringHealth: true,
      selectedUnavailableMutatesPackage: false
    },
    receipts: {
      promptOperation: "prompt.run",
      agentOperation: "agent.prompt",
      transcriptCommand: "motion.agent.transcript"
    },
    suggestedActions,
    warnings: []
  };
}

function agentPanelAdapter(adapter: AgentAdapter): AgentPanelAdapter {
  const probe = adapter.probeCommand();
  const prompt = adapter.promptCommand({ prompt: "" });
  const redactedPromptIndexes = new Set(prompt.redactedArgIndexes ?? []);
  return {
    agentId: adapter.id,
    label: adapter.label,
    promptCapable: adapter.promptContextMode === "prompt-only",
    transport: adapter.transport,
    billing: adapter.billing,
    probe: { executable: probe.executable, args: [...probe.args], shell: false },
    prompt: {
      executable: prompt.executable,
      args: prompt.args.map((arg, index) => redactedPromptIndexes.has(index) ? "<prompt>" : arg),
      shell: false,
      stdin: "prompt"
    },
    setup: describeAgentSetup(adapter)
  };
}
