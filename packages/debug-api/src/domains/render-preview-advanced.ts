/** Playhead and strip preview artifacts with deterministic receipts. */
import {
  analyzeFrameSequenceMotion,
  hashBuffer,
  motionDensityWarnings,
  type MotionPackage,
  type OperationReceipt,
  type ReceiptArtifact
} from "@shellx-motion/core";
import { join } from "node:path";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import type { BrowserFrameRenderer } from "./integration-browser-workflow.js";
import { nonNegativeNumberArg, positiveIntegerArg, stringArg } from "./args.js";

interface PreviewTimelineState {
  playheadMs: number;
  visibleState: Record<string, unknown>;
  warnings: string[];
}

export interface RenderPreviewAdvancedServices {
  scratchRoot?: string;
  receiptsRoot?: string;
  packageLoader?: (packageRoot: string) => Promise<MotionPackage>;
  browserFrameRenderer?: BrowserFrameRenderer;
  ensureDirectory?: (path: string) => Promise<void>;
  readPreviewTimelineState?: (pkg: MotionPackage) => Promise<PreviewTimelineState>;
  hashPackageIdentity?: (pkg: MotionPackage) => Promise<Record<string, string>>;
  writeReceipt?: (root: string, receipt: OperationReceipt) => Promise<string>;
}

export async function dispatchRenderPreviewAdvancedCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: RenderPreviewAdvancedServices
): Promise<MotionDebugResult | null> {
  if (command === "motion.preview.playhead") return playhead(args, services);
  if (command === "motion.preview.strip") return strip(args, services);
  return null;
}

async function playhead(args: unknown, services: RenderPreviewAdvancedServices): Promise<MotionDebugResult> {
  const packageRoot = stringArg(args, "packageRoot");
  const outDir = stringArg(args, "outDir") ?? services.scratchRoot ?? ".scratch/debug-preview-playhead";
  const outputPathArg = stringArg(args, "outputPath") ?? undefined;
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
  const createdAt = stringArg(args, "createdAt") ?? undefined;
  if (!packageRoot) return invalidArgs("motion.preview.playhead requires packageRoot.");
  const unavailable = requiredCapabilities(services, receiptsRoot, true);
  if (unavailable) return unavailable;
  try {
    const pkg = await services.packageLoader!(packageRoot);
    const timeline = await services.readPreviewTimelineState!(pkg);
    const atMs = timeline.playheadMs;
    const outputPath = outputPathArg ?? join(outDir, `${safeFileToken(pkg.manifest.id)}-playhead-${atMs}ms.png`);
    await services.ensureDirectory!(outDir);
    const preview = await services.browserFrameRenderer!(pkg, { atMs, outDir, outputPath, ...(createdAt ? { now: () => createdAt } : {}) });
    const warnings = [...timeline.warnings, ...preview.receipt.warnings];
    const inputHashes = {
      ...preview.receipt.inputHashes,
      timelineState: hashBuffer(Buffer.from(JSON.stringify(timeline.visibleState), "utf8"))
    };
    const output = { ...preview.output, playheadMs: atMs, timelineState: timeline.visibleState };
    const receiptId = `preview-playhead-${pkg.manifest.id}-${hashBuffer(Buffer.from(JSON.stringify({ inputHashes, output }), "utf8")).slice(0, 16)}`;
    const receiptPath = receiptsRoot ? join(receiptsRoot, `${safeFileToken(receiptId)}.receipt.json`) : undefined;
    const artifacts: ReceiptArtifact[] = [
      { role: "preview_frame", path: preview.output.path, status: "available", mediaType: "image/png", primary: true },
      ...(receiptPath ? [{ role: "preview_receipt", path: receiptPath, status: "available", mediaType: "application/json" } satisfies ReceiptArtifact] : [])
    ];
    const receipt: OperationReceipt = {
      schema: "shellx-motion/receipt@1", id: receiptId, operation: "preview.playhead",
      status: warnings.length > 0 ? "warning" : "passed", packageId: pkg.manifest.id,
      inputHashes, createdAt: createdAt ?? new Date().toISOString(), lane: "browser",
      output: { ...output, artifacts }, artifacts, warnings
    };
    const writtenReceiptPath = receiptsRoot ? await services.writeReceipt!(receiptsRoot, receipt) : undefined;
    return {
      ok: true, receiptId: receipt.id,
      visibleState: {
        panel: "preview", operation: "preview.playhead", packageId: pkg.manifest.id,
        playheadMs: atMs, atMs, outputPath: preview.output.path,
        ...(writtenReceiptPath ? { receiptPath: writtenReceiptPath } : {})
      },
      result: {
        ok: true, lane: "browser", packageId: pkg.manifest.id, playheadMs: atMs,
        output: preview.output, timelineState: timeline.visibleState, receipt, artifacts,
        ...(writtenReceiptPath ? { receiptPath: writtenReceiptPath } : {})
      },
      warnings
    };
  } catch (error) {
    return commandFailure("preview_playhead_failed", error);
  }
}

async function strip(args: unknown, services: RenderPreviewAdvancedServices): Promise<MotionDebugResult> {
  const packageRoot = stringArg(args, "packageRoot");
  const outDir = stringArg(args, "outDir") ?? services.scratchRoot ?? ".scratch/debug-preview-strip";
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
  const frameCountArg = positiveIntegerArg(args, "frameCount");
  const framesArg = frameCountArg === null ? positiveIntegerArg(args, "frames") : null;
  const startMsArg = nonNegativeNumberArg(args, "startMs");
  const endMsArg = nonNegativeNumberArg(args, "endMs");
  const createdAt = stringArg(args, "createdAt") ?? undefined;
  if (!packageRoot) return invalidArgs("motion.preview.strip requires packageRoot.");
  if (frameCountArg === false || framesArg === false) return invalidArgs("frameCount must be a positive integer.");
  if (startMsArg === false) return invalidArgs("startMs must be a non-negative number.");
  if (endMsArg === false) return invalidArgs("endMs must be a non-negative number.");
  const frameCount = frameCountArg ?? framesArg ?? 5;
  if (frameCount > 60) return invalidArgs("frameCount must be 60 or less.");
  const startMs = startMsArg ?? 0;
  if (endMsArg !== null && endMsArg < startMs) return invalidArgs("endMs must be greater than or equal to startMs.");
  const unavailable = requiredCapabilities(services, receiptsRoot, false);
  if (unavailable) return unavailable;
  try {
    const pkg = await services.packageLoader!(packageRoot);
    const endMs = endMsArg ?? Math.max(0, pkg.motion.durationMs);
    if (startMs > pkg.motion.durationMs) return invalidArgs("startMs must be within motion duration.");
    if (endMs < startMs) return invalidArgs("endMs must be greater than or equal to startMs.");
    if (endMs > pkg.motion.durationMs) return invalidArgs("endMs must be within motion duration.");
    await services.ensureDirectory!(outDir);
    const frames: Array<{ index: number; atMs: number; path: string; sha256: string; width: number; height: number }> = [];
    const frameReceipts: OperationReceipt[] = [];
    for (let index = 0; index < frameCount; index += 1) {
      const atMs = stripFrameTimestampMs(index, frameCount, startMs, endMs);
      const outputPath = join(outDir, `${safeFileToken(pkg.manifest.id)}-strip-${String(index + 1).padStart(2, "0")}-${atMs}ms.png`);
      const preview = await services.browserFrameRenderer!(pkg, { atMs, outDir, outputPath, ...(createdAt ? { now: () => createdAt } : {}) });
      frames.push({ index, atMs, path: preview.output.path, sha256: preview.output.sha256, width: preview.output.width, height: preview.output.height });
      frameReceipts.push(preview.receipt);
    }
    // The cheap "does this actually move?" answer. A strip renders a handful of frames and encodes
    // nothing, so an agent can iterate on motion here instead of discovering a frozen piece only
    // after a full render. It is the SAME measurement the render receipt reports (core's
    // motion-density), just over sampled frames — and it is reported as sampled evidence, because
    // frames seconds apart cannot back a frozen percentage.
    const motion = await analyzeFrameSequenceMotion(
      frames.map((frame) => frame.path),
      frames.map((frame) => frame.atMs),
      { durationMs: pkg.motion.durationMs }
    );
    // Two kinds of note, deliberately kept apart.
    //
    // `renderWarnings` describe the PREVIEW ITSELF going less than perfectly (a frame lane fallback,
    // a missing glyph) and keep their existing power to downgrade the receipt's status.
    //
    // `motionDensityWarnings` describe the CONTENT: how much of the piece moves. A deliberately
    // static title card is legitimate output, so an observation about it must never make a good
    // preview report `warning` — status is the field hosts and gates read as "did this work". This
    // must not downgrade successful output merely because an advisory note shares the response.
    // Status describes the final deliverable. The observation still rides `warnings` — that is where authors,
    // the debug API response and the MCP surface already look — and the full measurement is on the
    // receipt as its own `motion` field.
    const renderWarnings = frameReceipts.flatMap((receipt) => receipt.warnings);
    const warnings = [...renderWarnings, ...motionDensityWarnings(motion)];
    const artifacts: ReceiptArtifact[] = frames.map((frame, index) => ({
      role: "preview_frame", path: frame.path, status: "available",
      label: `Preview strip frame ${index + 1} at ${frame.atMs}ms`, mediaType: "image/png",
      ...(index === 0 ? { primary: true } : {})
    }));
    const inputHashes = await services.hashPackageIdentity!(pkg);
    const output = { frameCount, startMs, endMs, frames, motion, artifacts };
    const receiptId = `preview-strip-${pkg.manifest.id}-${hashBuffer(Buffer.from(JSON.stringify({ inputHashes, output }), "utf8")).slice(0, 16)}`;
    const receiptPath = receiptsRoot ? join(receiptsRoot, `${safeFileToken(receiptId)}.receipt.json`) : undefined;
    const allArtifacts = receiptPath
      ? [...artifacts, { role: "preview_receipt", path: receiptPath, status: "available", mediaType: "application/json" } satisfies ReceiptArtifact]
      : artifacts;
    const receipt: OperationReceipt = {
      schema: "shellx-motion/receipt@1", id: receiptId, operation: "preview.strip",
      status: renderWarnings.length > 0 ? "warning" : "passed", packageId: pkg.manifest.id,
      inputHashes, createdAt: createdAt ?? new Date().toISOString(), lane: "browser",
      output: { ...output, artifacts: allArtifacts }, artifacts: allArtifacts, warnings
    };
    const writtenReceiptPath = receiptsRoot ? await services.writeReceipt!(receiptsRoot, receipt) : undefined;
    return {
      ok: true, receiptId: receipt.id,
      visibleState: {
        panel: "preview", operation: "preview.strip", packageId: pkg.manifest.id,
        frameCount, startMs, endMs, ...(writtenReceiptPath ? { receiptPath: writtenReceiptPath } : {})
      },
      result: {
        ok: true, lane: "browser", packageId: pkg.manifest.id, frameCount, startMs, endMs,
        frames, motion, receipt, artifacts: allArtifacts, ...(writtenReceiptPath ? { receiptPath: writtenReceiptPath } : {})
      },
      warnings
    };
  } catch (error) {
    return commandFailure("preview_strip_failed", error);
  }
}

function requiredCapabilities(
  services: RenderPreviewAdvancedServices,
  receiptsRoot: string | undefined,
  needsTimeline: boolean
): MotionDebugResult | null {
  if (!services.packageLoader || !services.browserFrameRenderer || !services.ensureDirectory || !services.hashPackageIdentity) {
    return capabilityUnavailable("Preview artifact rendering is unavailable.");
  }
  if (needsTimeline && !services.readPreviewTimelineState) return capabilityUnavailable("Preview timeline state reading is unavailable.");
  if (receiptsRoot && !services.writeReceipt) return capabilityUnavailable("Preview receipt persistence is unavailable.");
  return null;
}

function stripFrameTimestampMs(index: number, count: number, startMs: number, endMs: number): number {
  if (count <= 1) return Math.round(startMs);
  return Math.round(startMs + ((endMs - startMs) * index) / (count - 1));
}

function safeFileToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "preview";
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

function capabilityUnavailable(message: string): MotionDebugResult {
  return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure the required host capability and retry." }, warnings: [] };
}

function commandFailure(code: string, error: unknown): MotionDebugResult {
  return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) }, warnings: [] };
}
