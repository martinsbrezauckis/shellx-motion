/** Prompt queue and cancel/retry controls behind bounded receipt-derived ports. */
import { hashBuffer, JOB_STATES, type JobState, type OperationReceipt } from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import type { StableReceiptSnapshot } from "../receipt-store-stable-reader.js";
import { stringArg } from "./args.js";

interface PromptQueueJob { state: string; availableActions: unknown[]; warnings?: string[] }

export type PromptControlTarget =
  | { kind: "missing" }
  | { kind: "not_prompt" }
  | {
      kind: "prompt";
      receipt: OperationReceipt;
      path: string;
      state: string;
      request: unknown;
      agentId?: string;
      snapshot: StableReceiptSnapshot;
      retryCount: number;
    };

export interface AgentPromptLifecycleServices {
  receiptsRoot?: string;
  readPromptLifecycleState?: (receiptsRoot: string) => Promise<{ jobs: PromptQueueJob[]; stateCounts: unknown }>;
  readPromptControlTarget?: (receiptsRoot: string, receiptId: string) => Promise<PromptControlTarget>;
  writeReceipt?: (root: string, receipt: OperationReceipt) => Promise<string>;
}

export async function dispatchAgentPromptLifecycleCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: AgentPromptLifecycleServices
): Promise<MotionDebugResult | null> {
  if (command === "motion.prompt.queue") return queue(args, services);
  if (command !== "motion.prompt.cancel" && command !== "motion.prompt.retry") return null;
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
  const receiptId = stringArg(args, "receiptId") ?? stringArg(args, "id");
  const reason = stringArg(args, "reason") ?? undefined;
  if (!receiptsRoot) return invalidArgs(`${command} requires receiptsRoot.`);
  if (!receiptId) return invalidArgs(`${command} requires receiptId.`);
  if (!services.readPromptControlTarget || !services.writeReceipt) return capabilityUnavailable("Prompt lifecycle control persistence is unavailable.");
  const target = await services.readPromptControlTarget(receiptsRoot, receiptId);
  if (target.kind === "missing") return invalidArgs(`Prompt receipt not found: ${receiptId}.`);
  if (target.kind === "not_prompt") return invalidArgs(`Receipt is not a prompt job: ${receiptId}.`);
  return command === "motion.prompt.cancel"
    ? cancel(receiptsRoot, target, reason, services)
    : retry(receiptsRoot, target, reason, services);
}

async function queue(args: unknown, services: AgentPromptLifecycleServices): Promise<MotionDebugResult> {
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
  if (!receiptsRoot) return queueResult(undefined, [], zeroStateCounts());
  if (!services.readPromptLifecycleState) return capabilityUnavailable("Prompt lifecycle receipt reading is unavailable.");
  const snapshot = await services.readPromptLifecycleState(receiptsRoot);
  return queueResult(receiptsRoot, snapshot.jobs, snapshot.stateCounts);
}

function queueResult(receiptsRoot: string | undefined, jobs: PromptQueueJob[], stateCounts: unknown): MotionDebugResult {
  const failedCount = jobs.filter((job) => job.state === "failed").length;
  const actionableCount = jobs.filter((job) => job.availableActions.length > 0).length;
  return {
    ok: true,
    visibleState: { panel: "agent", operation: "prompt.queue", jobCount: jobs.length, actionableCount, failedCount, stateCounts },
    result: {
      ok: true, ...(receiptsRoot ? { receiptsRoot } : {}), jobCount: jobs.length,
      actionableCount, failedCount, stateCounts, jobs
    },
    warnings: jobs.flatMap((job) => job.warnings ?? [])
  };
}

async function cancel(
  receiptsRoot: string,
  target: Extract<PromptControlTarget, { kind: "prompt" }>,
  reason: string | undefined,
  services: AgentPromptLifecycleServices
): Promise<MotionDebugResult> {
  if (target.state === "succeeded" || target.state === "failed" || target.state === "cancelled") {
    return invalidArgs(`Cannot cancel ${target.state} prompt job: ${target.receipt.id}.`);
  }
  const output = {
    targetReceiptId: target.receipt.id, targetReceiptPath: target.path,
    targetOperation: target.receipt.operation, targetStatus: target.receipt.status,
    targetState: target.state, targetReceiptSnapshot: target.snapshot, request: target.request,
    ...(target.agentId ? { agentId: target.agentId } : {}), ...(reason ? { reason } : {})
  };
  const inputHashes = { targetReceipt: target.snapshot.sha256 };
  const receipt: OperationReceipt = {
    schema: "shellx-motion/receipt@1",
    id: `prompt-cancel-${safeFileToken(target.receipt.id)}-${hashBuffer(Buffer.from(JSON.stringify({ inputHashes, output }), "utf8")).slice(0, 16)}`,
    operation: "prompt.cancel", status: "passed", packageId: target.receipt.packageId,
    inputHashes, createdAt: new Date().toISOString(), lane: "debug-api", output,
    artifacts: [{ role: "target_receipt", path: target.path, status: "available", mediaType: "application/json" }], warnings: []
  };
  const controlReceiptPath = await services.writeReceipt!(receiptsRoot, receipt);
  return {
    ok: true, receiptId: receipt.id,
    visibleState: {
      panel: "agent", operation: "prompt.cancel", receiptId: target.receipt.id,
      targetReceiptId: target.receipt.id, state: "cancelled", controlReceiptPath
    },
    result: {
      ok: true, targetReceiptId: target.receipt.id, targetReceiptPath: target.path,
      targetState: target.state, state: "cancelled", receipt, controlReceiptPath
    },
    warnings: []
  };
}

async function retry(
  receiptsRoot: string,
  source: Extract<PromptControlTarget, { kind: "prompt" }>,
  reason: string | undefined,
  services: AgentPromptLifecycleServices
): Promise<MotionDebugResult> {
  if (source.state !== "failed" && source.state !== "cancelled") {
    return invalidArgs(`Cannot retry ${source.state} prompt job: ${source.receipt.id}.`);
  }
  const retryAttempt = source.retryCount + 1;
  const output = {
    sourceReceiptId: source.receipt.id, sourceReceiptPath: source.path,
    sourceOperation: source.receipt.operation, sourceStatus: source.receipt.status,
    sourceState: source.state, sourceReceiptSnapshot: source.snapshot, request: source.request,
    ...(source.agentId ? { agentId: source.agentId } : {}), retryAttempt,
    ...(reason ? { reason } : {})
  };
  const inputHashes = { sourceReceipt: source.snapshot.sha256 };
  const receipt: OperationReceipt = {
    schema: "shellx-motion/receipt@1",
    id: `prompt-retry-${safeFileToken(source.receipt.id)}-${hashBuffer(Buffer.from(JSON.stringify({ inputHashes, output }), "utf8")).slice(0, 16)}`,
    operation: "prompt.retry", status: "not_run", packageId: source.receipt.packageId,
    inputHashes, createdAt: new Date().toISOString(), lane: source.receipt.lane, output,
    artifacts: [{ role: "source_receipt", path: source.path, status: "available", mediaType: "application/json" }], warnings: []
  };
  const controlReceiptPath = await services.writeReceipt!(receiptsRoot, receipt);
  return {
    ok: true, receiptId: receipt.id,
    visibleState: {
      panel: "agent", operation: "prompt.retry", receiptId: receipt.id,
      sourceReceiptId: source.receipt.id, state: "pending", controlReceiptPath
    },
    result: {
      ok: true, sourceReceiptId: source.receipt.id, sourceReceiptPath: source.path,
      sourceState: source.state, state: "pending", retryAttempt, receipt, controlReceiptPath
    },
    warnings: []
  };
}

function zeroStateCounts(): Record<JobState, number> {
  // Derived from the contract: a hand-written literal is how these counts drifted before.
  return Object.fromEntries(JOB_STATES.map((state) => [state, 0])) as Record<JobState, number>;
}

function safeFileToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "receipt";
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

function capabilityUnavailable(message: string): MotionDebugResult {
  return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure the required host capability and retry." }, warnings: [] };
}
