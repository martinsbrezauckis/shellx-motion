/** Closed Debug/MCP entry for cancellable durable segmented final delivery. */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { packageAudioEncodeInput, resolvePackageAudioInputs } from "@shellx-motion/connectors";
import { bindFinalRenderReceiptLineage, createRenderReceipt, hashBuffer, prepareOutputFile, type MotionPackage, type OperationReceipt, type PackageRenderLineage, type ReceiptActor } from "@shellx-motion/core";
import {
  resolveGpuEffectModuleStaticPlanForUse,
  type GpuEffectModuleUseAuthority,
  type MotionBrowserRenderSessionFactory
} from "@shellx-motion/renderer-browser";
import {
  checkFfmpeg,
  renderSegmentedFinal,
  type FfmpegExportPreset,
  type FfmpegRunner,
  type RenderSegmentedFinalInput,
  type SegmentedFinalToolPolicy
} from "@shellx-motion/renderer-ffmpeg";
import type { MotionDebugResult } from "../command-registry.js";

export interface SegmentedFinalDebugContext {
  ffmpegRunner?: FfmpegRunner;
  scratchRoot?: string;
  callerId?: string;
  actor?: ReceiptActor;
  executionSignal?: AbortSignal;
  browserSessionFactory?: MotionBrowserRenderSessionFactory;
  activeScriptSessionAvailable?: boolean;
  /** Opaque server-owned GPU module authority; Debug arguments cannot provide or replace it. */
  gpuEffectModuleUseAuthority?: GpuEffectModuleUseAuthority;
  /** Host-only test seam; wire callers cannot inject a producer or a storage path. */
  segmentedFinalRenderer?: (input: RenderSegmentedFinalInput) => Promise<Awaited<ReturnType<typeof renderSegmentedFinal>>>;
}

export async function runSegmentedFinalDebugRender(input: {
  pkg: MotionPackage;
  lineage: PackageRenderLineage;
  outputPath: string;
  frameLane: "browser" | "native" | "gpu";
  preset: FfmpegExportPreset;
  segmented: { segmentFrames: number; resume?: boolean };
  quality?: { minUniqueFrameHashes: number };
  receiptsRoot?: string;
  warnings: string[];
  context: SegmentedFinalDebugContext;
  dryRun: boolean;
  persistReceipt(receiptsRoot: string, receipt: OperationReceipt, actor?: ReceiptActor): Promise<string>;
}): Promise<MotionDebugResult> {
  const { pkg, lineage, outputPath, frameLane, preset, segmented, quality, receiptsRoot, warnings, context, dryRun, persistReceipt } = input;
  if (dryRun) {
    return {
      ok: true,
      visibleState: { panel: "receipts", operation: "render.final", packageId: pkg.manifest.id, outputPath, status: "planned" },
      result: {
        ok: true, lane: "ffmpeg", frameLane, preset, packageId: pkg.manifest.id, outputPath,
        dryRun: true,
        segmented: { segmentFrames: segmented.segmentFrames, resume: segmented.resume === true, store: "derived-from-output" }
      },
      warnings
    };
  }
  const missingGpuModuleAuthority = await missingGpuModuleAuthorityFailure(pkg, frameLane, context.gpuEffectModuleUseAuthority);
  if (missingGpuModuleAuthority) return { ok: false, error: missingGpuModuleAuthority, warnings: [] };
  const outputGuard = await prepareOutputFile(outputPath, { force: false });
  if (!outputGuard.ok) return { ok: false, error: outputGuard.error, warnings };
  const health = await checkFfmpeg({ runner: context.ffmpegRunner });
  if (!health.ok) return { ok: false, error: health.error, warnings: [] };
  await mkdir(dirname(outputPath), { recursive: true });

  const audioTracks = resolvePackageAudioInputs(pkg);
  const audioMaster = packageAudioEncodeInput(pkg).audioMaster;
  const rendered = await (context.segmentedFinalRenderer ?? renderSegmentedFinal)({
    pkg, frameLane, outputPath, preset, segmented,
    ...(audioTracks.length === 1 ? { audio: audioTracks[0] } : {}),
    ...(audioTracks.length > 1 ? { audioTracks } : {}),
    ...(audioMaster ? { audioMaster } : {}),
    inputRoots: [pkg.root], outputRoots: [dirname(outputPath)],
    ...(quality ? { quality } : {}),
    ...(context.executionSignal ? { signal: context.executionSignal } : {}),
    ...(context.scratchRoot ? { scratchRoot: context.scratchRoot } : {}),
    ...(context.callerId ? { callerId: context.callerId } : {}),
    toolPolicy: segmentedFinalToolPolicy(context, frameLane, health.version)
  });
  if (!rendered.ok) {
    const receipt = createRenderReceipt({
      id: `segmented-final-failed-${hashBuffer(Buffer.from(`${pkg.manifest.id}\n${outputPath}\n${rendered.error.code}`)).slice(0, 16)}`,
      packageId: pkg.manifest.id,
      lane: "ffmpeg",
      status: "failed",
      inputHashes: {},
      output: null,
      warnings: []
    });
    await bindFinalRenderReceiptLineage(receipt, pkg, lineage);
    const receiptPath = receiptsRoot ? await persistReceipt(receiptsRoot, receipt, context.actor) : undefined;
    return {
      ok: false,
      receiptId: receipt.id,
      error: { code: rendered.error.code, message: rendered.error.message, detail: { retryable: rendered.error.retryable, segmented: rendered.error.evidence } },
      result: {
        lane: "ffmpeg", frameLane, preset, packageId: pkg.manifest.id, outputPath,
        receipt, ...(receiptPath ? { receiptPath } : {}), segmented: { segmentFrames: segmented.segmentFrames, resume: segmented.resume === true, store: "derived-from-output" }
      },
      warnings
    };
  }
  await bindFinalRenderReceiptLineage(rendered.receipt, pkg, lineage);
  const receiptPath = receiptsRoot ? await persistReceipt(receiptsRoot, rendered.receipt, context.actor) : undefined;
  return {
    ok: true,
    receiptId: rendered.receipt.id,
    visibleState: { panel: "receipts", operation: "render.final", packageId: pkg.manifest.id, outputPath, status: rendered.receipt.status },
    result: {
      ok: true, lane: "ffmpeg", frameLane, preset, packageId: pkg.manifest.id, outputPath,
      output: rendered.receipt.output, receipt: rendered.receipt,
      ...(receiptPath ? { receiptPath } : {}),
      frameTransport: rendered.transport,
      segmented: { segmentFrames: segmented.segmentFrames, resume: segmented.resume === true, store: "derived-from-output" },
      warnings: rendered.receipt.warnings
    },
    warnings: rendered.receipt.warnings
  };
}

/** Same central Debug host projection for durable segments; no wire field can alter it. */
export function segmentedFinalToolPolicy(
  context: SegmentedFinalDebugContext,
  frameLane: "browser" | "native" | "gpu",
  ffmpegVersion: string | null | undefined
): SegmentedFinalToolPolicy {
  return {
    ...(context.ffmpegRunner ? { runner: context.ffmpegRunner } : {}),
    ...(ffmpegVersion ? { ffmpegVersion } : {}),
    ...(frameLane === "browser" ? {
      browser: {
        ...(context.browserSessionFactory ? { sessionFactory: context.browserSessionFactory } : {}),
        ...(context.activeScriptSessionAvailable ? { activeScriptSessionAvailable: true } : {})
      }
    } : {}),
    ...(frameLane === "gpu" && context.gpuEffectModuleUseAuthority
      ? { gpu: { effectModuleUseAuthority: context.gpuEffectModuleUseAuthority } }
      : {})
  };
}

/** Keep absent host authority on a cheap static path: no FFmpeg probe, browser launch, or output setup. */
async function missingGpuModuleAuthorityFailure(
  pkg: MotionPackage,
  frameLane: "browser" | "native" | "gpu",
  authority: GpuEffectModuleUseAuthority | undefined
): Promise<{ code: string; message: string } | undefined> {
  if (frameLane !== "gpu" || authority) return undefined;
  const preflight = await resolveGpuEffectModuleStaticPlanForUse(pkg.motion, undefined);
  return !preflight.ok && preflight.failure.code === "gpu_resource_refused"
    ? preflight.failure
    : undefined;
}
