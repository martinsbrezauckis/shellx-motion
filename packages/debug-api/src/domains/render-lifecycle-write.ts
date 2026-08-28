/** Render cancel/retry control receipts behind bounded lookup and persistence ports. */
import { hashBuffer, type OperationReceipt } from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import type { StableReceiptSnapshot } from "../receipt-store-stable-reader.js";
import { receiptOwner } from "../receipt-ownership.js";
import { stringArg } from "./args.js";

export type RenderControlTarget =
  | { kind: "missing" }
  | { kind: "not_render" }
  | { kind: "not_visible" }
  | {
      kind: "render";
      receipt: OperationReceipt;
      path: string;
      state: string;
      snapshot: StableReceiptSnapshot;
      retryCount: number;
      outputPath?: string;
    };

export interface RenderLifecycleWriteServices {
  receiptsRoot?: string;
  /** Host-authenticated logical caller; never derived from command input. */
  lifecycleCallerId?: string;
  /** Host-operator grant for the exceptional cross-caller historical-control route. */
  lifecycleCrossCallerScopeGranted?: boolean;
  readRenderControlTarget?: (receiptsRoot: string, receiptId: string) => Promise<RenderControlTarget>;
  writeReceipt?: (root: string, receipt: OperationReceipt) => Promise<string>;
}

export async function dispatchRenderLifecycleWriteCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: RenderLifecycleWriteServices
): Promise<MotionDebugResult | null> {
  if (command !== "motion.render.cancel" && command !== "motion.render.retry") return null;
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
  const receiptId = stringArg(args, "receiptId") ?? stringArg(args, "id");
  const reason = stringArg(args, "reason") ?? undefined;
  if (!receiptsRoot) return invalidArgs(`${command} requires receiptsRoot.`);
  if (!receiptId) return invalidArgs(`${command} requires receiptId.`);
  if (!services.lifecycleCallerId?.trim()) {
    return ownerPrincipalUnavailable();
  }
  if (!services.readRenderControlTarget || !services.writeReceipt) {
    return capabilityUnavailable("Render lifecycle control persistence is unavailable.");
  }
  const target = await services.readRenderControlTarget(receiptsRoot, receiptId);
  if (target.kind === "missing") return invalidArgs(`Render receipt not found: ${receiptId}.`);
  if (target.kind === "not_render") return invalidArgs(`Receipt is not a render job: ${receiptId}.`);
  if (target.kind === "not_visible") return notVisible();
  return command === "motion.render.cancel"
    ? cancel(receiptsRoot, target, reason, services)
    : retry(receiptsRoot, target, reason, services);
}

async function cancel(
  receiptsRoot: string,
  target: Extract<RenderControlTarget, { kind: "render" }>,
  reason: string | undefined,
  services: RenderLifecycleWriteServices
): Promise<MotionDebugResult> {
  if (target.state === "succeeded" || target.state === "failed" || target.state === "cancelled") {
    return invalidArgs(`Cannot cancel ${target.state} render job: ${target.receipt.id}.`);
  }
  const output = {
    ...(receiptOwner(target.receipt) ? { callerId: receiptOwner(target.receipt) } : {}),
    targetReceiptId: target.receipt.id,
    targetReceiptPath: target.path,
    targetOperation: target.receipt.operation,
    targetStatus: target.receipt.status,
    targetState: target.state,
    targetReceiptSnapshot: target.snapshot,
    ...(reason ? { reason } : {})
  };
  const inputHashes = { targetReceipt: target.snapshot.sha256 };
  const receipt: OperationReceipt = {
    schema: "shellx-motion/receipt@1",
    id: `render-cancel-${safeFileToken(target.receipt.id)}-${hashBuffer(Buffer.from(JSON.stringify({ inputHashes, output }), "utf8")).slice(0, 16)}`,
    operation: "render.cancel", status: "passed", packageId: target.receipt.packageId,
    inputHashes, createdAt: new Date().toISOString(), lane: "debug-api", output,
    artifacts: [{ role: "target_receipt", path: target.path, status: "available", mediaType: "application/json" }],
    warnings: []
  };
  const controlReceiptPath = await services.writeReceipt!(receiptsRoot, receipt);
  return {
    ok: true, receiptId: receipt.id,
    visibleState: {
      panel: "render", operation: "render.cancel", receiptId: target.receipt.id,
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
  source: Extract<RenderControlTarget, { kind: "render" }>,
  reason: string | undefined,
  services: RenderLifecycleWriteServices
): Promise<MotionDebugResult> {
  if (source.state !== "failed" && source.state !== "cancelled") {
    return invalidArgs(`Cannot retry ${source.state} render job: ${source.receipt.id}.`);
  }
  const retryAttempt = source.retryCount + 1;
  const output = {
    ...(receiptOwner(source.receipt) ? { callerId: receiptOwner(source.receipt) } : {}),
    sourceReceiptId: source.receipt.id,
    sourceReceiptPath: source.path,
    sourceOperation: source.receipt.operation,
    sourceStatus: source.receipt.status,
    sourceState: source.state,
    sourceReceiptSnapshot: source.snapshot,
    retryAttempt,
    ...(source.outputPath ? { sourceOutputPath: source.outputPath } : {}),
    ...(reason ? { reason } : {})
  };
  const inputHashes = { sourceReceipt: source.snapshot.sha256 };
  const receipt: OperationReceipt = {
    schema: "shellx-motion/receipt@1",
    id: `render-retry-${safeFileToken(source.receipt.id)}-${hashBuffer(Buffer.from(JSON.stringify({ inputHashes, output }), "utf8")).slice(0, 16)}`,
    operation: "render.retry", status: "not_run", packageId: source.receipt.packageId,
    inputHashes, createdAt: new Date().toISOString(), lane: source.receipt.lane, output,
    artifacts: [{ role: "source_receipt", path: source.path, status: "available", mediaType: "application/json" }],
    warnings: []
  };
  const controlReceiptPath = await services.writeReceipt!(receiptsRoot, receipt);
  return {
    ok: true, receiptId: receipt.id,
    visibleState: {
      panel: "render", operation: "render.retry", receiptId: receipt.id,
      sourceReceiptId: source.receipt.id, state: "pending", controlReceiptPath
    },
    result: {
      ok: true, sourceReceiptId: source.receipt.id, sourceReceiptPath: source.path,
      state: "pending", retryAttempt, receipt, controlReceiptPath
    },
    warnings: []
  };
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

function ownerPrincipalUnavailable(): MotionDebugResult {
  return {
    ok: false,
    error: {
      code: "capability_unavailable",
      message: "Render lifecycle control requires a server-authenticated owner principal.",
      suggestedAction: "Ask the host operator to use an authenticated Motion transport or configure a trusted in-process caller identity."
    },
    warnings: []
  };
}

function notVisible(): MotionDebugResult {
  return {
    ok: false,
    error: {
      code: "permission_denied",
      message: "Render receipt is not visible to this caller.",
      suggestedAction: "Use the caller that created the render, or ask the host operator for an explicit cross-caller lifecycle grant."
    },
    warnings: []
  };
}
