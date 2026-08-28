/** Prompt execution, retention, proposal validation, and linked receipt policy. */
import { withAgentAuthoringJobExecution, type AgentAuthoringJob, type OperationReceipt } from "@shellx-motion/core";
import { redactExpiredRawPrompt, runMotionPrompt, type MotionPromptRuntime, type PromptRawRetentionPurpose, type PromptRetentionInput, type PromptRunReceipt } from "@shellx-motion/prompt";
import { trustedRootRefusal, type MotionPermissionTier } from "@shellx-motion/actions";
import { DEBUG_COMMANDS, type MotionDebugCommand, type MotionDebugResult } from "../command-registry.js";
import { booleanArg, objectArg, stringArg } from "./args.js";
import { callerReceiptsRootRefusal, type ReceiptsRootPolicyServices } from "./receipts-root-policy.js";
import { hasStableReceiptStoreCapability } from "../receipt-store-stable-reader.js";
import { rawPromptRetentionAdmissionError } from "../raw-prompt-retention-admission.js";

export interface PromptCommandProposal { command: MotionDebugCommand; args: unknown }
export interface PromptCommandExecutionRecord {
  command: MotionDebugCommand;
  ok: boolean;
  receiptId?: string;
  error?: { code: string; message: string; suggestedAction?: string; detail?: unknown };
  warnings: string[];
}
export interface PromptCommandExecutionSummary {
  commandCount: number;
  receiptIds: string[];
  commands: PromptCommandExecutionRecord[];
}

export interface RawPromptReceiptReservation {
  writeReceipt(receipt: OperationReceipt): Promise<string>;
  close(): Promise<void>;
}

export interface AgentPromptRunServices extends ReceiptsRootPolicyServices {
  tier?: MotionPermissionTier;
  promptRuntime?: MotionPromptRuntime;
  promptNow?: () => string;
  promptCwdRoots?: string[];
  writeReceipt?: (root: string, receipt: OperationReceipt) => Promise<string>;
  /**
   * Host-owned admission seam for the raw-retention lifecycle. Production defaults to the shared
   * descriptor-relative receipt-store capability; tests can model a non-Linux host without
   * changing global platform state. Callers cannot select this through command arguments.
   */
  hasStableReceiptPurgeCapability?: () => boolean;
  /**
   * Host-only descriptor-held receipt root. It is acquired after caller-root fencing and held
   * through the agent and prompt receipt writes; command arguments cannot supply this capability.
   */
  reserveRawPromptReceiptRoot?: (receiptsRoot: string) => Promise<RawPromptReceiptReservation | null>;
  executePromptCommands?: (proposals: PromptCommandProposal[], receiptsRoot?: string) => Promise<PromptCommandExecutionSummary>;
}

const MAX_PROMPT_COMMAND_PROPOSALS = 25;

export async function dispatchAgentPromptRunCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: AgentPromptRunServices
): Promise<MotionDebugResult | null> {
  if (command !== "motion.prompt.run") return null;
  const request = stringArg(args, "request") ?? stringArg(args, "prompt");
  const packageId = stringArg(args, "packageId") ?? "unknown";
  const agentId = stringArg(args, "agentId") ?? undefined;
  const cwd = stringArg(args, "cwd") ?? undefined;
  // Keep the caller's value distinguishable from the host's after the default
  // is applied, because only the caller's needs fencing and only the caller's may be refused.
  const requestedReceiptsRoot = stringArg(args, "receiptsRoot") ?? undefined;
  const receiptsRoot = requestedReceiptsRoot ?? services.receiptsRoot;
  const executeAgentCommands = booleanArg(args, "executeAgentCommands") ?? false;
  const retainRawRequest = booleanArg(args, "retainRawRequest") ?? false;
  const rawRequestDeleteAfter = stringArg(args, "rawRequestDeleteAfter") ?? undefined;
  const rawRequestPurpose = stringArg(args, "rawRequestPurpose") ?? undefined;
  if (!request) return invalidArgs("motion.prompt.run requires request.");
  if (!services.tier) return capabilityUnavailable("Prompt permission context is unavailable.");
  const promptRuntime = services.promptRuntime;
  const retention = promptRetentionFromArgs(retainRawRequest, rawRequestDeleteAfter, rawRequestPurpose);
  if (!retention.ok) return invalidArgs(retention.message);
  if (cwd) {
    if (!services.isPathInsideTrustedRoot || !services.promptCwdRoots || services.promptCwdRoots.length === 0) {
      return {
        ok: false,
        error: {
          code: "capability_unavailable",
          message: "This host did not configure any trusted prompt working root, so cwd cannot be validated.",
          suggestedAction: "Omit cwd to run in the host's own working directory. A caller cannot add a root: the host operator sets promptCwdRoots on the Motion debug context, and the shipped debug server derives it from the directory it was started in.",
          detail: { argument: "cwd", trustedRoots: [], resolvedBy: "host_operator" }
        },
        warnings: []
      };
    }
    if (!await insideAnyRoot(cwd, services.promptCwdRoots, services.isPathInsideTrustedRoot)) {
      // Same dead-end class as a tier refusal: the old message named the rule and neither the roots
      // in force nor who sets them, so an agent could only guess paths until it gave up.
      return {
        ok: false,
        error: trustedRootRefusal({
          subject: "motion.prompt.run",
          argument: "cwd",
          roots: services.promptCwdRoots,
          hostGrantHint: "start the Motion debug server from the directory that should be trusted, or set promptCwdRoots on the embedding host's Motion debug context"
        }),
        warnings: []
      };
    }
  }
  // `motion.prompt.run` is draft_motion, and its failure path writes a receipt too
  // (agent_unavailable / agent_failed), so an unfenced receiptsRoot is a mkdir -p plus a file drop
  // anywhere on a machine with no agent CLI installed at all. Refuse before runMotionPrompt rather
  // than before the write: a refusal that still ran the agent has already spent the side effects.
  const receiptsRootRefusal = await callerReceiptsRootRefusal("motion.prompt.run", requestedReceiptsRoot, services);
  if (receiptsRootRefusal) return receiptsRootRefusal;
  if (executeAgentCommands && !services.executePromptCommands) return capabilityUnavailable("Prompt command execution is unavailable.");
  if (!promptRuntime) return capabilityUnavailable("Prompt execution is unavailable because this host did not inject a prompt runtime.");

  // Raw retention is a lifecycle promise, not a display option. It may run only when Motion can
  // retain the exact existing no-follow receipt root through provider execution, then use that
  // held descriptor for the linked agent and prompt receipts. Refuse before the provider runs.
  const rawRetentionRefusal = rawPromptRetentionRefusal(retention.value, receiptsRoot, services);
  if (rawRetentionRefusal) return rawRetentionRefusal;
  const rawReceiptReservation = retention.value.mode === "raw_request"
    ? await services.reserveRawPromptReceiptRoot!(receiptsRoot!)
    : undefined;
  if (retention.value.mode === "raw_request" && !rawReceiptReservation) {
    return capabilityUnavailable("Raw prompt retention requires the host's configured receipt root to be an existing stable non-symlink directory.");
  }
  const writeReceipt = rawReceiptReservation
    ? async (_root: string, receipt: OperationReceipt) => await rawReceiptReservation.writeReceipt(receipt)
    : services.writeReceipt;
  if (receiptsRoot && !writeReceipt) return capabilityUnavailable("Prompt receipt persistence is unavailable.");

  try {
    const promptResult = await runMotionPrompt({
      request, tier: services.tier, runtime: promptRuntime,
      agentId, packageId, cwd, retention: retention.value, ...(services.promptNow ? { now: services.promptNow } : {})
    });
    if (!promptResult.ok) {
      // Persist the child before its parent. A failed local process may still have a bounded agent
      // receipt; `agent_unavailable` intentionally does not synthesize one.
      const agentReceiptPath = promptResult.agent?.receipt && receiptsRoot
        ? await writeReceipt!(receiptsRoot, promptResult.agent.receipt)
        : undefined;
      const linkedPromptReceipt = agentReceiptPath && promptResult.receipt
        ? withPersistedAgentReceiptPath(promptResult.receipt, agentReceiptPath)
        : promptResult.receipt;
      const promptReceipt = linkedPromptReceipt && redactPromptReceipt(linkedPromptReceipt, services.promptNow);
      const receiptPath = promptReceipt && receiptsRoot
        ? await writeReceipt!(receiptsRoot, promptReceipt)
        : undefined;
      return {
        ok: false,
        error: promptResult.error,
        ...(promptReceipt ? { receiptId: promptReceipt.id } : {}),
        ...(promptReceipt ? {
          visibleState: {
            panel: "agent", operation: "prompt.run", packageId: promptReceipt.packageId,
            status: promptReceipt.status,
            ...(receiptPath ? { receiptPath } : {}), ...(agentReceiptPath ? { agentReceiptPath } : {})
          },
          result: {
            ok: false, packageId: promptReceipt.packageId, plan: promptResult.plan,
            ...(promptResult.agent ? { agent: promptResult.agent } : {}), receipt: promptReceipt,
            ...(receiptPath ? { receiptPath } : {}), ...(agentReceiptPath ? { agentReceiptPath } : {})
          }
        } : {}),
        warnings: promptReceipt?.warnings ?? []
      };
    }

    const agentReceiptPath = receiptsRoot
      ? await writeReceipt!(receiptsRoot, promptResult.agent.receipt)
      : undefined;

    let execution: PromptCommandExecutionSummary | undefined;
    let promptReceipt = promptResult.receipt;
    if (executeAgentCommands) {
      const proposals = parsePromptCommandProposals(promptResult.agent.structuredOutput);
      if (!proposals.ok) {
        const rejectedReceipt = redactPromptReceipt({
          ...promptReceipt,
          status: "failed" as const,
          warnings: dedupeWarnings([...promptReceipt.warnings, proposals.message])
        }, services.promptNow);
        if (receiptsRoot) await writeReceipt!(receiptsRoot, rejectedReceipt);
        return {
          ok: false,
          error: { code: "invalid_prompt_command_proposal", message: proposals.message },
          warnings: rejectedReceipt.warnings
        };
      }
      execution = await services.executePromptCommands!(proposals.proposals, receiptsRoot);
      promptReceipt = withPromptExecutionReceipt(promptReceipt, execution);
    }

    promptReceipt = redactPromptReceipt(promptReceipt, services.promptNow);
    const receiptPath = receiptsRoot ? await writeReceipt!(receiptsRoot, promptReceipt) : undefined;
    const failedExecution = execution?.commands.find((record) => !record.ok);
    if (failedExecution) {
      return {
        ok: false,
        error: failedExecution.error ?? { code: "prompt_command_failed", message: `${failedExecution.command} failed during prompt command execution.` },
        warnings: promptReceipt.warnings
      };
    }
    return {
      ok: true,
      receiptId: promptReceipt.id,
      visibleState: {
        panel: "agent", operation: "prompt.run", packageId: promptReceipt.packageId,
        status: promptReceipt.status,
        promptRetentionMode: promptReceipt.output.promptRetention.mode,
        rawRequestRetained: promptReceipt.output.promptRetention.rawRequestRetained,
        ...(promptReceipt.output.promptRetention.mode === "raw_request" ? {
          rawRequestDeleteAfter: promptReceipt.output.promptRetention.deleteAfter,
          rawRequestPurpose: promptReceipt.output.promptRetention.purpose
        } : {}),
        ...(receiptPath ? { receiptPath } : {}), ...(agentReceiptPath ? { agentReceiptPath } : {})
      },
      result: {
        ok: true, packageId: promptReceipt.packageId, plan: promptResult.plan,
        agent: promptResult.agent, receipt: promptReceipt,
        ...(execution ? { execution } : {}),
        ...(receiptPath ? { receiptPath } : {}), ...(agentReceiptPath ? { agentReceiptPath } : {})
      },
      warnings: promptReceipt.warnings
    };
  } finally {
    await rawReceiptReservation?.close();
  }
}

function redactPromptReceipt(receipt: PromptRunReceipt, now: (() => string) | undefined): PromptRunReceipt {
  return redactExpiredRawPrompt(receipt, now?.()).receipt;
}

function promptRetentionFromArgs(
  retainRawRequest: boolean,
  deleteAfter: string | undefined,
  purpose: string | undefined
): { ok: true; value: PromptRetentionInput } | { ok: false; message: string } {
  if (!retainRawRequest) {
    if (deleteAfter || purpose) return { ok: false, message: "rawRequestDeleteAfter and rawRequestPurpose require retainRawRequest=true." };
    return { ok: true, value: { mode: "summary_only" } };
  }
  if (!deleteAfter) return { ok: false, message: "Raw prompt retention requires rawRequestDeleteAfter." };
  if (!isPromptRawRetentionPurpose(purpose)) return { ok: false, message: "Raw prompt retention requires rawRequestPurpose user_requested_replay or debugging." };
  return { ok: true, value: { mode: "raw_request", deleteAfter, purpose } };
}

function isPromptRawRetentionPurpose(value: unknown): value is PromptRawRetentionPurpose {
  return value === "user_requested_replay" || value === "debugging";
}

function rawPromptRetentionRefusal(
  retention: PromptRetentionInput,
  receiptsRoot: string | undefined,
  services: AgentPromptRunServices
): MotionDebugResult | null {
  const error = rawPromptRetentionAdmissionError(retention, {
    receiptsRoot,
    receiptPersistenceAvailable: Boolean(services.reserveRawPromptReceiptRoot),
    hasStableReceiptPurgeCapability: services.hasStableReceiptPurgeCapability ?? hasStableReceiptStoreCapability
  });
  return error ? { ok: false, error, warnings: [] } : null;
}

function parsePromptCommandProposals(parsed: unknown): { ok: true; proposals: PromptCommandProposal[] } | { ok: false; message: string } {
  const record = objectArg(parsed);
  if (!record) return { ok: false, message: "Prompt agent output must be a JSON object." };
  const commands = record.debugCommands ?? record.commands;
  if (commands === undefined) return { ok: true, proposals: [] };
  if (!Array.isArray(commands)) return { ok: false, message: "Prompt command proposals must be an array." };
  if (commands.length > MAX_PROMPT_COMMAND_PROPOSALS) return { ok: false, message: `Prompt command proposals are limited to ${MAX_PROMPT_COMMAND_PROPOSALS} commands.` };
  const proposals: PromptCommandProposal[] = [];
  for (const [index, entry] of commands.entries()) {
    const proposal = objectArg(entry);
    if (!proposal) return { ok: false, message: `Prompt command proposal ${index} must be an object.` };
    const proposedCommand = proposal.command ?? proposal.call;
    if (typeof proposedCommand !== "string") return { ok: false, message: `Prompt command proposal ${index} requires a command string.` };
    if (proposedCommand === "motion.prompt.run") return { ok: false, message: "Prompt command proposals cannot recursively run motion.prompt.run." };
    const debugCommand = DEBUG_COMMANDS.find((candidate) => candidate === proposedCommand);
    if (!debugCommand) return { ok: false, message: `Prompt command proposal ${index} uses unknown debug command: ${proposedCommand}.` };
    proposals.push({ command: debugCommand, args: proposal.args ?? {} });
  }
  return { ok: true, proposals };
}

function withPromptExecutionReceipt(receipt: PromptRunReceipt, execution: PromptCommandExecutionSummary): PromptRunReceipt {
  const failed = execution.commands.find((record) => !record.ok);
  const executedCommands = execution.commands.map((record) => ({
    command: record.command, ok: record.ok, ...(record.receiptId ? { receiptId: record.receiptId } : {})
  }));
  const authoringJob: AgentAuthoringJob = withAgentAuthoringJobExecution(receipt.output.authoringJob, {
    executedCommands, at: new Date().toISOString()
  });
  const lastEvent = authoringJob.eventLog.at(-1);
  const executionWarnings = execution.commands.flatMap((record) => [
    ...record.warnings, ...(record.error ? [`${record.command} failed: ${record.error.message}`] : [])
  ]);
  return {
    ...receipt,
    status: failed ? "failed" : receipt.status,
    output: {
      ...receipt.output, executedCommands, linkedReceiptIds: execution.receiptIds,
      authoringJob, events: authoringJob.eventLog, eventCount: authoringJob.eventLog.length,
      lastEventSeq: lastEvent?.seq ?? 0, ...(lastEvent?.at ? { lastEventAt: lastEvent.at } : {}),
      mutationPolicy: authoringJob.mutationPolicy
    },
    warnings: dedupeWarnings([...receipt.warnings, ...executionWarnings])
  };
}

async function insideAnyRoot(path: string, roots: string[], contains: (root: string, path: string) => Promise<boolean>): Promise<boolean> {
  for (const root of roots) if (await contains(root, path)) return true;
  return false;
}

function dedupeWarnings(warnings: string[]): string[] { return [...new Set(warnings)]; }

function withPersistedAgentReceiptPath(receipt: PromptRunReceipt, agentReceiptPath: string): PromptRunReceipt {
  return {
    ...receipt,
    output: {
      ...receipt.output,
      agentReceiptPath,
      ...(receipt.output.agentReceiptId
        ? { linkedReceiptIds: [...new Set([...(receipt.output.linkedReceiptIds ?? []), receipt.output.agentReceiptId])] }
        : {})
    }
  };
}

function invalidArgs(message: string): MotionDebugResult { return { ok: false, error: { code: "invalid_args", message }, warnings: [] }; }
function capabilityUnavailable(message: string): MotionDebugResult {
  return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure the required host capability and retry." }, warnings: [] };
}
