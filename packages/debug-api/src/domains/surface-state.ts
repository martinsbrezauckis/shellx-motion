/** Aggregate Motion state surface behind explicit read-only capabilities. */
import type { MotionPackage } from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { stringArg } from "./args.js";

interface TimelineStateView {
  timeline: Record<string, unknown>;
  warnings: string[];
}

interface ReceiptRenderStateView {
  receipts: unknown[];
  jobs: Array<{ status?: unknown }>;
  failedCount: number;
  stateCounts: unknown;
  warnings: string[];
}

export interface SurfaceStateServices {
  receiptsRoot?: string;
  packageLoader?: (packageRoot: string) => Promise<MotionPackage>;
  hashPackageIdentity?: (pkg: MotionPackage) => Promise<Record<string, string>>;
  readTimelineState?: (pkg: MotionPackage) => Promise<TimelineStateView>;
  readReceiptRenderState?: (receiptsRoot?: string) => Promise<ReceiptRenderStateView>;
}

export async function dispatchSurfaceStateCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: SurfaceStateServices
): Promise<MotionDebugResult | null> {
  if (command !== "motion.state") return null;
  const packageRoot = stringArg(args, "packageRoot") ?? undefined;
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
  if (!packageRoot) return { ok: true, result: { packageOpen: false, jobs: [] }, warnings: [] };
  if (!services.packageLoader || !services.hashPackageIdentity || !services.readTimelineState) {
    return capabilityUnavailable("Aggregate package state reading is unavailable.");
  }
  if (!services.readReceiptRenderState) {
    return capabilityUnavailable("Aggregate receipt and render state reading is unavailable.");
  }
  const pkg = await services.packageLoader(packageRoot);
  const [inputHashes, timelineState, receiptState] = await Promise.all([
    services.hashPackageIdentity(pkg),
    services.readTimelineState(pkg),
    services.readReceiptRenderState(receiptsRoot)
  ]);
  return {
    ok: true,
    visibleState: {
      panel: "timeline", packageOpen: true, packageId: pkg.manifest.id, motionId: pkg.motion.id,
      layerCount: pkg.motion.layers.length, receiptCount: receiptState.receipts.length,
      renderJobCount: receiptState.jobs.length
    },
    result: {
      ok: true, packageOpen: true, packageRoot: pkg.root, packageId: pkg.manifest.id, motionId: pkg.motion.id,
      package: {
        id: pkg.manifest.id, name: pkg.manifest.name, sourceApp: pkg.manifest.sourceApp,
        compatibility: pkg.manifest.compatibility, inputHashes
      },
      motion: {
        durationMs: pkg.motion.durationMs, fps: pkg.motion.fps, width: pkg.motion.width,
        height: pkg.motion.height, layerCount: pkg.motion.layers.length, assetCount: pkg.motion.assets.length
      },
      timeline: timelineState.timeline,
      receipts: {
        ...(receiptsRoot ? { receiptsRoot } : {}),
        receiptCount: receiptState.receipts.length, receipts: receiptState.receipts
      },
      render: {
        jobCount: receiptState.jobs.length, failedCount: receiptState.failedCount,
        stateCounts: receiptState.stateCounts, jobs: receiptState.jobs
      }
    },
    warnings: [...receiptState.warnings, ...timelineState.warnings]
  };
}

function capabilityUnavailable(message: string): MotionDebugResult {
  return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure the required host capability and retry." }, warnings: [] };
}
