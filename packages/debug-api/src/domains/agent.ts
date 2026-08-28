import { ACTIONS, findActionMatch, guideAction, planAction, type MotionActionMatch, type MotionPermissionTier } from "@shellx-motion/actions";
import { buildAgentRuntime, describeAgentSetup, type AgentAdapter, type AgentRuntime, type AgentSetupHints } from "@shellx-motion/agent-runtime";
import { compareCodeUnits, hashBuffer } from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { annotatePlanWithArgumentContracts } from "./agent-plan-arguments.js";
import { nonNegativeIntegerArg, stringArg } from "./args.js";
import { dispatchAgentRevisionCommand, type AgentRevisionServices } from "./agent-revision.js";
import { dispatchAgentPromptLifecycleCommand, type AgentPromptLifecycleServices } from "./agent-prompt-lifecycle.js";
import { dispatchAgentPromptRunCommand, type AgentPromptRunServices } from "./agent-prompt-run.js"; import { dispatchMotionAgentSnapshot, type AgentSnapshotServices } from "./agent-snapshot.js";

const TIER_ORDER: MotionPermissionTier[] = ["read_motion", "draft_motion", "render_motion", "edit_motion", "write_local", "push_remote"];

export async function dispatchAgentCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: AgentDomainServices = {}
): Promise<MotionDebugResult | null> {
  // `request` is read INSIDE each branch that uses it, not once at the top. Read at the top it was
  // an argument of every command this dispatcher routes — including `motion.agent.health`, which
  // has no use for it — and a published schema either has to declare it everywhere or reject a call
  // the handler read. `scripts/debug-arg-coverage.ts` gates that agreement.
  if (command === "motion.actions.find") return { ok: true, result: actionsFindResult(requestArg(args)), warnings: [] };
  // Both plans are returned with each step's argument contract attached. Without it an agent
  // gets the call order and no way to know what to pass, which is how a "successful" run can
  // execute nothing at all.
  if (command === "motion.actions.guide") return { ok: true, result: annotatePlanWithArgumentContracts(guideAction(requestArg(args))), warnings: [] };
  if (command === "motion.actions.plan") return { ok: true, result: annotatePlanWithArgumentContracts(planAction(requestArg(args))), warnings: [] };
  if (command === "motion.actions.panel") {
    const panel = buildActionsPanel();
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
    const panel = buildAgentPanel();
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
        defaultAgentId: panel.selectionPolicy.defaultAgentId,
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
  agentRuntime?: Pick<AgentRuntime, "health">;
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
interface ActionsPanelCard {
  id: string;
  primaryAlias: string;
  aliasCount: number;
  permission: MotionPermissionTier;
  mutates: boolean;
  calls: string[];
  callCount: number;
  verify: string[];
  surfaces: string[];
  primarySurface: string;
}

interface ActionsPanelSurface {
  id: string;
  label: string;
  actionCount: number;
  mutatingActionCount: number;
  actionIds: string[];
}

interface ActionsPanelPermission {
  tier: MotionPermissionTier;
  actionCount: number;
  mutatingActionCount: number;
  actionIds: string[];
}

interface ActionsPanelCommand {
  id: "find" | "guide" | "plan" | "run" | "agentHealth";
  command: "motion.actions.find" | "motion.actions.guide" | "motion.actions.plan" | "motion.prompt.run" | "motion.agent.health";
  args: { request: string } | Record<string, never>;
}

interface ActionsPanel {
  actionCount: number;
  promptActionCount: number;
  readOnlyActionCount: number;
  mutatingActionCount: number;
  surfaceCount: number;
  actions: ActionsPanelCard[];
  surfaces: ActionsPanelSurface[];
  permissions: ActionsPanelPermission[];
  promptCommands: ActionsPanelCommand[];
  suggestedActions: Array<{
    id: "plan" | "runPrompt" | "agentHealth";
    command: "motion.actions.plan" | "motion.prompt.run" | "motion.agent.health";
    args: { request: string } | Record<string, never>;
  }>;
}

function buildActionsPanel(): ActionsPanel {
  const actions = ACTIONS.map((action): ActionsPanelCard => ({
    id: action.id,
    primaryAlias: action.aliases[0] ?? action.id,
    aliasCount: action.aliases.length,
    permission: action.permission,
    mutates: action.mutates,
    calls: action.calls,
    callCount: action.calls.length,
    verify: action.verify,
    surfaces: action.surfaces,
    primarySurface: action.surfaces[0] ?? "prompt"
  }));
  const surfaceIds = [...new Set(actions.flatMap((action) => action.surfaces))].sort((left, right) => surfaceSortRank(left) - surfaceSortRank(right) || compareCodeUnits(left, right));
  const surfaces = surfaceIds.map((surfaceId): ActionsPanelSurface => {
    const surfaceActions = actions.filter((action) => action.surfaces.includes(surfaceId));
    return {
      id: surfaceId,
      label: actionSurfaceLabel(surfaceId),
      actionCount: surfaceActions.length,
      mutatingActionCount: surfaceActions.filter((action) => action.mutates).length,
      actionIds: surfaceActions.map((action) => action.id)
    };
  });
  const permissions = TIER_ORDER
    .map((tier): ActionsPanelPermission => {
      const tierActions = actions.filter((action) => action.permission === tier);
      return {
        tier,
        actionCount: tierActions.length,
        mutatingActionCount: tierActions.filter((action) => action.mutates).length,
        actionIds: tierActions.map((action) => action.id)
      };
    })
    .filter((permission) => permission.actionCount > 0);
  const mutatingActionCount = actions.filter((action) => action.mutates).length;
  return {
    actionCount: actions.length,
    promptActionCount: actions.filter((action) => action.surfaces.includes("prompt")).length,
    readOnlyActionCount: actions.length - mutatingActionCount,
    mutatingActionCount,
    surfaceCount: surfaces.length,
    actions,
    surfaces,
    permissions,
    promptCommands: [
      { id: "find", command: "motion.actions.find", args: { request: "" } },
      { id: "guide", command: "motion.actions.guide", args: { request: "" } },
      { id: "plan", command: "motion.actions.plan", args: { request: "" } },
      { id: "run", command: "motion.prompt.run", args: { request: "" } },
      { id: "agentHealth", command: "motion.agent.health", args: {} }
    ],
    suggestedActions: [
      { id: "plan", command: "motion.actions.plan", args: { request: "describe the Motion task" } },
      { id: "runPrompt", command: "motion.prompt.run", args: { request: "describe the Motion task" } },
      { id: "agentHealth", command: "motion.agent.health", args: {} }
    ]
  };
}

function surfaceSortRank(surfaceId: string): number {
  const order = ["prompt", "packages", "timeline", "templateInspector", "preview", "receipts", "assets", "brand"];
  const index = order.indexOf(surfaceId);
  return index === -1 ? order.length : index;
}

function actionSurfaceLabel(surfaceId: string): string {
  const labels: Record<string, string> = {
    prompt: "Prompt",
    packages: "Packages",
    timeline: "Timeline",
    templateInspector: "Template Inspector",
    preview: "Preview",
    receipts: "Receipts",
    assets: "Assets",
    brand: "Brand"
  };
  return labels[surfaceId] ?? surfaceId;
}

interface AgentPanelCommandShape {
  executable: string;
  args: string[];
  shell: false;
}

interface AgentPanelAdapter {
  agentId: string;
  label: string;
  default: boolean;
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
    defaultMode: "auto-local-cli";
    defaultAgentId: string;
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
    | { id: "run"; command: "motion.prompt.run"; args: { request: string } }
    | { id: "transcript"; command: "motion.agent.transcript"; args: { receiptsRoot: string } }
  >;
  warnings: string[];
}

function buildAgentPanel(): AgentPanel {
  const adapters = buildAgentRuntime().listAgents();
  const defaultAgentId = adapters[0]?.id ?? "codex";
  const cards = adapters.map((adapter) => agentPanelAdapter(adapter, defaultAgentId));
  const suggestedActions: AgentPanel["suggestedActions"] = [
    { id: "health", command: "motion.agent.health", args: {} },
    { id: "run", command: "motion.prompt.run", args: { request: "" } },
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
      defaultMode: "auto-local-cli",
      defaultAgentId,
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

function agentPanelAdapter(adapter: AgentAdapter, defaultAgentId: string): AgentPanelAdapter {
  const probe = adapter.probeCommand();
  const prompt = adapter.promptCommand({ prompt: "" }); const redactedPromptIndexes = new Set(prompt.redactedArgIndexes ?? []);
  return {
    agentId: adapter.id,
    label: adapter.label,
    default: adapter.id === defaultAgentId,
    transport: adapter.transport,
    billing: adapter.billing,
    probe: { executable: probe.executable, args: [...probe.args], shell: false },
    prompt: {
      executable: prompt.executable,
      args: prompt.args.map((arg, index) => redactedPromptIndexes.has(index) ? "<prompt>" : arg),
      shell: false, stdin: "prompt"
    },
    setup: describeAgentSetup(adapter)
  };
}
