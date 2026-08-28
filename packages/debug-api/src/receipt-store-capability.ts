import type { MotionDebugCommand, MotionDebugResult } from "./command-registry.js";

/**
 * The stable reader is deliberately Linux-only: its safety proof retains an O_NOFOLLOW directory
 * chain through /proc/self/fd rather than reopening caller-controlled path names. This gate keeps
 * command admission above every domain handler, so an unsupported host cannot turn a receipt-backed
 * panel into a false empty list or reach a control-receipt write after an untrustworthy lookup.
 */
export function stableReceiptStoreRequired(
  command: MotionDebugCommand,
  args: unknown,
  context: StableReceiptStoreRootContext
): boolean {
  const receiptsRoot = ownStringDebugArg(args, "receiptsRoot") ?? context.receiptsRoot;
  if (!receiptsRoot) return false;
  switch (command) {
    case "motion.receipts.list":
    case "motion.receipts.panel":
    case "motion.agent.transcript":
    case "motion.prompt.queue":
    case "motion.prompt.cancel":
    case "motion.prompt.retry":
    case "motion.render.status":
    case "motion.render.queue":
    case "motion.render.cancel":
    case "motion.render.retry":
    case "motion.platform.verification.panel":
    case "motion.export.panel":
    case "motion.export.plan":
    case "motion.support.bundle":
    case "motion.state":
      return true;
    case "motion.agent.snapshot":
      // Snapshot treats an empty string as an omitted input and falls back to the host root.
      return Boolean(ownStringDebugArg(args, "receiptsRoot") || context.receiptsRoot);
    case "motion.receipts.read":
      return Boolean(
        ownStringDebugArg(args, "receiptPath")
        ?? ownStringDebugArg(args, "path")
        ?? ownStringDebugArg(args, "receiptId")
        ?? ownStringDebugArg(args, "id")
      );
    case "motion.agent.revision.plan":
      return hasStableReceiptReference(args, "qualityReceiptPath", "qualityReceiptPaths")
        || hasStableReceiptReference(args, "qualityReceiptId", "qualityReceiptIds");
    default:
      return false;
  }
}

export interface StableReceiptStoreRootContext {
  receiptsRoot?: string;
}

export interface StableReceiptStorePlatformContext {
  stableReceiptStorePlatform?: NodeJS.Platform;
  /** Test-only host seam; never derived from command arguments. */
  stableReceiptStoreProcSelfFdUsable?: () => boolean;
}

export function stableReceiptStoreCapabilityUnavailable(
  command: MotionDebugCommand | "motion.agent.snapshot",
  context: StableReceiptStorePlatformContext
): MotionDebugResult {
  const platform = context.stableReceiptStorePlatform ?? process.platform;
  return {
    ok: false,
    error: {
      code: "capability_unavailable",
      message: `${command} requires Linux descriptor-relative no-follow receipt-store capability; it is unavailable on ${platform}.`,
      suggestedAction: "Run this receipt-backed operation on a Linux host with descriptor-relative no-follow support."
    },
    warnings: []
  };
}

function hasStableReceiptReference(args: unknown, singleKey: string, arrayKey: string): boolean {
  if (ownStringDebugArg(args, singleKey)) return true;
  const record = ownDebugArgRecord(args);
  const array = record ? ownDebugArgValue(record, arrayKey) : undefined;
  return Array.isArray(array) && array.some((value) => typeof value === "string" && value.length > 0);
}

function ownStringDebugArg(args: unknown, key: string): string | undefined {
  const record = ownDebugArgRecord(args);
  const value = record ? ownDebugArgValue(record, key) : undefined;
  return typeof value === "string" ? value : undefined;
}

function ownDebugArgRecord(args: unknown): Record<string, unknown> | null {
  return typeof args === "object" && args !== null && !Array.isArray(args) ? args as Record<string, unknown> : null;
}

function ownDebugArgValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
