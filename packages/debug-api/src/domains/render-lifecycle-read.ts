/** Read-only render status and queue views behind one receipt-derived capability. */
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { stringArg } from "./args.js";

interface StatusJob { status?: unknown; warnings?: string[] }
interface QueueJob { state?: unknown; availableActions: unknown[]; warnings?: string[] }

interface RenderLifecycleSnapshot {
  statusJobs: StatusJob[];
  queueJobs: QueueJob[];
  stateCounts: unknown;
}

export interface RenderLifecycleReadServices {
  receiptsRoot?: string;
  readRenderLifecycleState?: (receiptsRoot?: string) => Promise<RenderLifecycleSnapshot>;
}

export async function dispatchRenderLifecycleReadCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: RenderLifecycleReadServices
): Promise<MotionDebugResult | null> {
  if (command !== "motion.render.status" && command !== "motion.render.queue") return null;
  if (!services.readRenderLifecycleState) return capabilityUnavailable("Render lifecycle receipt reading is unavailable.");
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
  const snapshot = await services.readRenderLifecycleState(receiptsRoot);
  return command === "motion.render.status"
    ? statusResult(receiptsRoot, snapshot)
    : queueResult(receiptsRoot, snapshot);
}

function statusResult(receiptsRoot: string | undefined, snapshot: RenderLifecycleSnapshot): MotionDebugResult {
  const failedCount = snapshot.statusJobs.filter((job) => job.status === "failed").length;
  return {
    ok: true,
    visibleState: { panel: "render", jobCount: snapshot.statusJobs.length, failedCount, stateCounts: snapshot.stateCounts },
    result: {
      ok: true, ...(receiptsRoot ? { receiptsRoot } : {}), jobCount: snapshot.statusJobs.length,
      failedCount, stateCounts: snapshot.stateCounts, jobs: snapshot.statusJobs
    },
    warnings: snapshot.statusJobs.flatMap((job) => job.warnings ?? [])
  };
}

function queueResult(receiptsRoot: string | undefined, snapshot: RenderLifecycleSnapshot): MotionDebugResult {
  const failedCount = snapshot.queueJobs.filter((job) => job.state === "failed").length;
  const actionableCount = snapshot.queueJobs.filter((job) => job.availableActions.length > 0).length;
  return {
    ok: true,
    visibleState: {
      panel: "render", operation: "render.queue", jobCount: snapshot.queueJobs.length,
      actionableCount, failedCount, stateCounts: snapshot.stateCounts
    },
    result: {
      ok: true, ...(receiptsRoot ? { receiptsRoot } : {}), jobCount: snapshot.queueJobs.length,
      actionableCount, failedCount, stateCounts: snapshot.stateCounts, jobs: snapshot.queueJobs
    },
    warnings: snapshot.queueJobs.flatMap((job) => job.warnings ?? [])
  };
}

function capabilityUnavailable(message: string): MotionDebugResult {
  return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure the required host capability and retry." }, warnings: [] };
}
