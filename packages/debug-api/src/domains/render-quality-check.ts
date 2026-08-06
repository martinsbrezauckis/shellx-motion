/** Media, audio, frame, and baseline quality checks behind bounded analysis ports. */
import {
  audioQualityMeasurementRequired,
  evaluateAudioQuality,
  hashBuffer,
  type AudioQualityThresholds,
  type OperationReceipt
} from "@shellx-motion/core";
import { basename, join } from "node:path";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { booleanArg, finiteNumberArg, nonNegativeNumberArg, stringArg } from "./args.js";

export interface QualityMedia {
  width: number;
  height: number;
  audio: { present: boolean };
}

export interface QualityAudioLevels {
  maxVolumeDb: number | null;
  integratedLoudnessLufs?: number | null;
  truePeakDbtp?: number | null;
  loudnessRangeLu?: number | null;
}

export interface QualityFrameSummary {
  blankFrames: number;
  minBrightPixels: number;
  minEdgePixels: number;
  minTransparentPixels: number;
  minNonTransparentPixels: number;
}

export type QualityVisualDiff =
  | { ok: false; message: string }
  | { ok: true; changedPixels: number; meanAbsoluteError: number; psnrDb: number | null; ssim: number };

export interface QualityManifestDefaults {
  minBrightPixels: number;
  minEdgePixels: number;
  minTransparentPixels: number;
  minNonTransparentPixels: number;
  maxChangedPixels: number;
  maxMeanDiff: number;
  minPsnrDb?: number;
  minSsim?: number;
}

export interface RenderQualityCheckServices {
  scratchRoot?: string;
  receiptsRoot?: string;
  qualityInputRoots?: string[];
  qualityOutputRoots?: string[];
  isQualityPathInsideRoots?: (path: string, roots: string[]) => Promise<boolean>;
  probeQualityMedia?: (inputPath: string, inputRoots: string[]) => Promise<QualityMedia>;
  measureQualityAudio?: (inputPath: string, inputRoots: string[]) => Promise<QualityAudioLevels>;
  runQualityManifest?: (input: {
    inputPath: string;
    manifestPath: string;
    media: QualityMedia;
    outDir: string;
    inputRoots: string[];
    receiptsRoot?: string;
    packageId: string;
    defaults: QualityManifestDefaults;
  }) => Promise<MotionDebugResult>;
  extractQualityFrame?: (input: {
    inputPath: string;
    media: QualityMedia;
    framePath: string;
    atMs: number;
    inputRoots: string[];
  }) => Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  analyzeQualityFrame?: (framePath: string) => Promise<{ ok: true; quality: QualityFrameSummary } | { ok: false; message: string }>;
  compareQualityFrames?: (framePath: string, baselinePath: string) => Promise<QualityVisualDiff>;
  createQualityReceipt?: (input: {
    id: string;
    packageId: string;
    inputPath: string;
    output: Record<string, unknown>;
    warnings: string[];
    status?: OperationReceipt["status"];
  }) => Promise<OperationReceipt>;
  writeReceipt?: (root: string, receipt: OperationReceipt) => Promise<string>;
}

export async function dispatchRenderQualityCheckCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: RenderQualityCheckServices
): Promise<MotionDebugResult | null> {
  if (command !== "motion.quality.check") return null;
  const inputPath = stringArg(args, "inputPath");
  const manifestPath = stringArg(args, "manifestPath") ?? stringArg(args, "qualityManifestPath");
  const framePathArg = stringArg(args, "framePath");
  const baselinePath = stringArg(args, "baselinePath");
  const outDir = stringArg(args, "outDir") ?? services.scratchRoot ?? ".scratch/debug-quality";
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
  const packageId = stringArg(args, "packageId") || "quality-check";
  const expectWidth = finiteNumberArg(args, "expectWidth");
  const expectHeight = finiteNumberArg(args, "expectHeight");
  const maxAudioPeakDb = finiteNumberArg(args, "maxAudioPeakDb");
  const minAudioLoudnessLufs = finiteNumberArg(args, "minAudioLoudnessLufs");
  const maxAudioLoudnessLufs = finiteNumberArg(args, "maxAudioLoudnessLufs");
  const maxAudioTruePeakDbtp = finiteNumberArg(args, "maxAudioTruePeakDbtp");
  const maxAudioLoudnessRangeLu = nonNegativeNumberArg(args, "maxAudioLoudnessRangeLu");
  const minBrightPixels = nonNegativeNumberArg(args, "minBrightPixels");
  const minEdgePixels = nonNegativeNumberArg(args, "minEdgePixels");
  const minTransparentPixels = nonNegativeNumberArg(args, "minTransparentPixels");
  const minNonTransparentPixels = nonNegativeNumberArg(args, "minNonTransparentPixels");
  const atMs = nonNegativeNumberArg(args, "atMs") ?? 0;
  const maxChangedPixels = nonNegativeNumberArg(args, "maxChangedPixels");
  const maxMeanDiff = nonNegativeNumberArg(args, "maxMeanDiff");
  const minPsnrDb = finiteNumberArg(args, "minPsnrDb");
  const minSsim = finiteNumberArg(args, "minSsim");
  const expectAudio = booleanArg(args, "expectAudio") ?? false;
  if (!inputPath) return invalidArgs("motion.quality.check requires inputPath.");
  if (expectWidth === false) return invalidArgs("expectWidth must be a finite number.");
  if (expectHeight === false) return invalidArgs("expectHeight must be a finite number.");
  if (maxAudioPeakDb === false) return invalidArgs("maxAudioPeakDb must be a finite number.");
  if (minAudioLoudnessLufs === false) return invalidArgs("minAudioLoudnessLufs must be a finite number.");
  if (maxAudioLoudnessLufs === false) return invalidArgs("maxAudioLoudnessLufs must be a finite number.");
  if (maxAudioTruePeakDbtp === false) return invalidArgs("maxAudioTruePeakDbtp must be a finite number.");
  if (maxAudioLoudnessRangeLu === false) return invalidArgs("maxAudioLoudnessRangeLu must be a non-negative number.");
  if (minAudioLoudnessLufs !== null
    && maxAudioLoudnessLufs !== null
    && minAudioLoudnessLufs > maxAudioLoudnessLufs) {
    return invalidArgs("minAudioLoudnessLufs must be less than or equal to maxAudioLoudnessLufs.");
  }
  if (minBrightPixels === false) return invalidArgs("minBrightPixels must be a non-negative number.");
  if (minEdgePixels === false) return invalidArgs("minEdgePixels must be a non-negative number.");
  if (minTransparentPixels === false) return invalidArgs("minTransparentPixels must be a non-negative number.");
  if (minNonTransparentPixels === false) return invalidArgs("minNonTransparentPixels must be a non-negative number.");
  if (atMs === false) return invalidArgs("atMs must be a non-negative number.");
  if (maxChangedPixels === false) return invalidArgs("maxChangedPixels must be a non-negative number.");
  if (maxMeanDiff === false) return invalidArgs("maxMeanDiff must be a non-negative number.");
  if (minPsnrDb === false) return invalidArgs("minPsnrDb must be a finite number.");
  if (minSsim === false || (minSsim !== null && (minSsim < 0 || minSsim > 1))) {
    return invalidArgs("minSsim must be a finite number between 0 and 1.");
  }
  if (!manifestPath && !baselinePath && (minPsnrDb !== null || minSsim !== null)) {
    return invalidArgs("minPsnrDb and minSsim require baselinePath.");
  }

  const visualRequested = Boolean(framePathArg || baselinePath || minBrightPixels !== null || minEdgePixels !== null || minTransparentPixels !== null || minNonTransparentPixels !== null || maxChangedPixels !== null || maxMeanDiff !== null || minPsnrDb !== null || minSsim !== null);
  const checks = {
    ...(expectWidth !== null ? { expectWidth } : {}),
    ...(expectHeight !== null ? { expectHeight } : {}),
    ...(expectAudio ? { expectAudio } : {}),
    ...(maxAudioPeakDb !== null ? { maxAudioPeakDb } : {}),
    ...(minAudioLoudnessLufs !== null ? { minAudioLoudnessLufs } : {}),
    ...(maxAudioLoudnessLufs !== null ? { maxAudioLoudnessLufs } : {}),
    ...(maxAudioTruePeakDbtp !== null ? { maxAudioTruePeakDbtp } : {}),
    ...(maxAudioLoudnessRangeLu !== null ? { maxAudioLoudnessRangeLu } : {}),
    ...(visualRequested ? { atMs } : {}),
    ...(minBrightPixels !== null ? { minBrightPixels } : {}),
    ...(minEdgePixels !== null ? { minEdgePixels } : {}),
    ...(minTransparentPixels !== null ? { minTransparentPixels } : {}),
    ...(minNonTransparentPixels !== null ? { minNonTransparentPixels } : {}),
    ...(maxChangedPixels !== null ? { maxChangedPixels } : {}),
    ...(maxMeanDiff !== null ? { maxMeanDiff } : {}),
    ...(minPsnrDb !== null ? { minPsnrDb } : {}),
    ...(minSsim !== null ? { minSsim } : {})
  };
  const inputRoots = services.qualityInputRoots ?? [];
  const directVisual = visualRequested && !manifestPath;
  const audioPolicy: AudioQualityThresholds = {
    maxPeakDb: maxAudioPeakDb ?? undefined,
    minIntegratedLoudnessLufs: minAudioLoudnessLufs ?? undefined,
    maxIntegratedLoudnessLufs: maxAudioLoudnessLufs ?? undefined,
    maxTruePeakDbtp: maxAudioTruePeakDbtp ?? undefined,
    maxLoudnessRangeLu: maxAudioLoudnessRangeLu ?? undefined
  };
  const audioMeasurementRequested = audioQualityMeasurementRequired(audioPolicy);
  const unavailable = requiredCapabilities(services, {
    needsAudio: audioMeasurementRequested,
    needsManifest: Boolean(manifestPath),
    needsReceiptBuilder: !manifestPath,
    needsFrameAnalysis: directVisual,
    needsFrameExtraction: directVisual && !framePathArg,
    needsCompare: directVisual && Boolean(baselinePath),
    receiptsRoot: manifestPath ? undefined : receiptsRoot
  });
  if (unavailable) return unavailable;
  const unsafePath = await qualityPathPolicyFailure({
    services, manifestPath, framePath: framePathArg, baselinePath,
    outDir: manifestPath || (visualRequested && !framePathArg) ? outDir : undefined,
    receiptsRoot
  });
  if (unsafePath) return unsafePath;

  let media: QualityMedia;
  try {
    media = await services.probeQualityMedia!(inputPath, inputRoots);
  } catch (error) {
    return commandFailure("ffmpeg_failed", error);
  }
  const failureBase = { services, packageId, inputPath, receiptsRoot };
  if (expectWidth !== null && media.width !== expectWidth) {
    return qualityFailure({ ...failureBase, code: "media_quality_failed", message: `Media width is ${media.width}; expected ${expectWidth}.`, output: { inputPath, media, checks } });
  }
  if (expectHeight !== null && media.height !== expectHeight) {
    return qualityFailure({ ...failureBase, code: "media_quality_failed", message: `Media height is ${media.height}; expected ${expectHeight}.`, output: { inputPath, media, checks } });
  }
  if (expectAudio && !media.audio.present) {
    return qualityFailure({ ...failureBase, code: "audio_quality_failed", message: "Expected at least one audio stream, but media has none.", output: { inputPath, media, checks } });
  }

  let audioLevels: QualityAudioLevels | undefined;
  if (audioMeasurementRequested) {
    if (!media.audio.present) {
      return qualityFailure({ ...failureBase, code: "audio_quality_failed", message: "Expected at least one audio stream for audio peak check, but media has none.", output: { inputPath, media, checks } });
    }
    try {
      audioLevels = await services.measureQualityAudio!(inputPath, inputRoots);
    } catch (error) {
      return commandFailure("ffmpeg_failed", error);
    }
    const evaluation = evaluateAudioQuality(audioLevels, audioPolicy);
    if (!evaluation.ok) {
      return qualityFailure({ ...failureBase, code: "audio_quality_failed", message: evaluation.message, output: { inputPath, media, audioLevels, checks } });
    }
  }

  if (manifestPath) {
    return services.runQualityManifest!({
      inputPath, manifestPath, media, outDir, inputRoots, receiptsRoot, packageId,
      defaults: {
        minBrightPixels: minBrightPixels ?? 0,
        minEdgePixels: minEdgePixels ?? 0,
        minTransparentPixels: minTransparentPixels ?? 0,
        minNonTransparentPixels: minNonTransparentPixels ?? 0,
        maxChangedPixels: maxChangedPixels ?? 0,
        maxMeanDiff: maxMeanDiff ?? 0,
        ...(minPsnrDb !== null ? { minPsnrDb } : {}),
        ...(minSsim !== null ? { minSsim } : {})
      }
    });
  }

  const framePath = visualRequested ? framePathArg ?? join(outDir, `${basename(inputPath).replace(/\.[^.]+$/, "") || "media"}-frame.png`) : undefined;
  let quality: QualityFrameSummary | undefined;
  let visualDiff: QualityVisualDiff | undefined;
  if (visualRequested && framePath) {
    if (!framePathArg) {
      const extracted = await services.extractQualityFrame!({ inputPath, media, framePath, atMs, inputRoots });
      if (!extracted.ok) return { ok: false, error: { code: extracted.code, message: extracted.message }, warnings: [] };
    }
    const inspected = await services.analyzeQualityFrame!(framePath);
    if (!inspected.ok) {
      return qualityFailure({ ...failureBase, code: "visual_quality_failed", message: inspected.message, output: qualityOutput({ inputPath, media, audioLevels, framePath, atMs, checks }) });
    }
    quality = inspected.quality;
    const thresholds: Array<[number, number, string]> = [
      [quality.minBrightPixels, minBrightPixels ?? 0, "bright"],
      [quality.minEdgePixels, minEdgePixels ?? 0, "edge"],
      [quality.minTransparentPixels, minTransparentPixels ?? 0, "transparent"],
      [quality.minNonTransparentPixels, minNonTransparentPixels ?? 0, "non-transparent"]
    ];
    for (const [actual, expected, label] of thresholds) {
      if (actual < expected) {
        return qualityFailure({ ...failureBase, code: "visual_quality_failed", message: `Extracted frame has ${actual} ${label} pixels; expected at least ${expected}.`, output: qualityOutput({ inputPath, media, audioLevels, framePath, atMs, quality, checks }) });
      }
    }
    if (baselinePath) {
      visualDiff = await services.compareQualityFrames!(framePath, baselinePath);
      const diffOutput = () => qualityOutput({ inputPath, media, audioLevels, framePath, atMs, quality, baselinePath, visualDiff, checks });
      if (!visualDiff.ok) {
        return qualityFailure({ ...failureBase, code: "visual_regression_failed", message: visualDiff.message, output: diffOutput() });
      }
      const changedLimit = maxChangedPixels ?? 0;
      const meanLimit = maxMeanDiff ?? 0;
      if (visualDiff.changedPixels > changedLimit || visualDiff.meanAbsoluteError > meanLimit) {
        return qualityFailure({ ...failureBase, code: "visual_regression_failed", message: `Visual regression failed: ${visualDiff.changedPixels} changed pixels (max ${changedLimit}), mean diff ${formatMetric(visualDiff.meanAbsoluteError)} (max ${formatMetric(meanLimit)}).`, output: diffOutput() });
      }
      if (minPsnrDb !== null && visualDiff.psnrDb !== null && visualDiff.psnrDb < minPsnrDb) {
        return qualityFailure({ ...failureBase, code: "visual_regression_failed", message: `Visual regression failed: PSNR is ${formatMetric(visualDiff.psnrDb)} dB; expected at least ${formatMetric(minPsnrDb)} dB.`, output: diffOutput() });
      }
      if (minSsim !== null && visualDiff.ssim < minSsim) {
        return qualityFailure({ ...failureBase, code: "visual_regression_failed", message: `Visual regression failed: SSIM is ${formatMetric(visualDiff.ssim)}; expected at least ${formatMetric(minSsim)}.`, output: diffOutput() });
      }
    }
  }

  const output = qualityOutput({ inputPath, media, audioLevels, framePath: framePath ?? undefined, atMs, quality, baselinePath: baselinePath ?? undefined, visualDiff, checks });
  const receiptId = `quality-check-${hashBuffer(Buffer.from(JSON.stringify({ inputPath, media, audioLevels, framePath, quality, baselinePath, visualDiff, checks }), "utf8")).slice(0, 16)}`;
  const warnings = quality && quality.blankFrames > 0 ? ["Extracted frame is blank or visually empty."] : [];
  const receipt = await services.createQualityReceipt!({ id: receiptId, packageId, inputPath, output, warnings });
  const hostReceiptPath = receiptsRoot ? await services.writeReceipt!(receiptsRoot, receipt) : undefined;
  return {
    ok: true, receiptId,
    visibleState: { panel: "receipts", operation: "quality.check", inputPath, ok: true, status: receipt.status, ...(hostReceiptPath ? { hostReceiptPath } : {}) },
    result: { ok: true, ...output, receipt, ...(hostReceiptPath ? { hostReceiptPath } : {}) },
    warnings
  };
}

function qualityOutput(input: {
  inputPath: string;
  media: QualityMedia;
  audioLevels?: QualityAudioLevels;
  framePath?: string;
  atMs: number;
  quality?: QualityFrameSummary;
  baselinePath?: string;
  visualDiff?: QualityVisualDiff;
  checks: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    inputPath: input.inputPath, media: input.media,
    ...(input.audioLevels ? { audioLevels: input.audioLevels } : {}),
    ...(input.framePath ? { framePath: input.framePath, atMs: input.atMs } : {}),
    ...(input.quality ? { quality: input.quality } : {}),
    ...(input.baselinePath ? { baselinePath: input.baselinePath } : {}),
    ...(input.visualDiff ? { visualDiff: input.visualDiff } : {}),
    checks: input.checks
  };
}

async function qualityFailure(input: {
  services: RenderQualityCheckServices;
  code: string;
  message: string;
  packageId: string;
  inputPath: string;
  receiptsRoot?: string;
  output: Record<string, unknown>;
}): Promise<MotionDebugResult> {
  const output = { ...input.output, error: { code: input.code, message: input.message } };
  const receiptId = `quality-check-${hashBuffer(Buffer.from(JSON.stringify({ inputPath: input.inputPath, output, status: "failed" }), "utf8")).slice(0, 16)}`;
  const receipt = await input.services.createQualityReceipt!({ id: receiptId, packageId: input.packageId, inputPath: input.inputPath, output, warnings: [input.message], status: "failed" });
  const hostReceiptPath = input.receiptsRoot ? await input.services.writeReceipt!(input.receiptsRoot, receipt) : undefined;
  return {
    ok: false,
    error: { code: input.code, message: input.message, detail: { receiptId, receipt, ...(hostReceiptPath ? { hostReceiptPath } : {}) } },
    warnings: [input.message]
  };
}

function requiredCapabilities(
  services: RenderQualityCheckServices,
  input: {
    needsAudio: boolean;
    needsManifest: boolean;
    needsReceiptBuilder: boolean;
    needsFrameAnalysis: boolean;
    needsFrameExtraction: boolean;
    needsCompare: boolean;
    receiptsRoot?: string;
  }
): MotionDebugResult | null {
  if (!services.probeQualityMedia || !services.isQualityPathInsideRoots) return capabilityUnavailable("Quality media analysis is unavailable.");
  if (input.needsReceiptBuilder && !services.createQualityReceipt) return capabilityUnavailable("Quality receipt construction is unavailable.");
  if (input.needsAudio && !services.measureQualityAudio) return capabilityUnavailable("Quality audio analysis is unavailable.");
  if (input.needsManifest && !services.runQualityManifest) return capabilityUnavailable("Quality manifest execution is unavailable.");
  if (input.needsFrameAnalysis && !services.analyzeQualityFrame) return capabilityUnavailable("Quality frame analysis is unavailable.");
  if (input.needsFrameExtraction && !services.extractQualityFrame) return capabilityUnavailable("Quality frame extraction is unavailable.");
  if (input.needsCompare && !services.compareQualityFrames) return capabilityUnavailable("Quality baseline comparison is unavailable.");
  if (input.receiptsRoot && !services.writeReceipt) return capabilityUnavailable("Quality receipt persistence is unavailable.");
  return null;
}

async function qualityPathPolicyFailure(input: {
  services: RenderQualityCheckServices;
  manifestPath: string | null;
  framePath: string | null;
  baselinePath: string | null;
  outDir?: string;
  receiptsRoot?: string;
}): Promise<MotionDebugResult | null> {
  const inputRoots = input.services.qualityInputRoots ?? [];
  const outputRoots = input.services.qualityOutputRoots ?? [];
  const checks: Array<{ path: string | null | undefined; roots: string[]; label: string }> = [
    { path: input.manifestPath, roots: inputRoots, label: "manifestPath" },
    { path: input.framePath, roots: inputRoots, label: "framePath" },
    { path: input.baselinePath, roots: inputRoots, label: "baselinePath" },
    { path: input.outDir, roots: outputRoots, label: "outDir" },
    { path: input.receiptsRoot, roots: outputRoots, label: "receiptsRoot" }
  ];
  for (const check of checks) {
    if (!check.path) continue;
    if (check.roots.length === 0 || !await input.services.isQualityPathInsideRoots!(check.path, check.roots)) {
      return invalidArgs(`motion.quality.check ${check.label} must be inside a trusted quality ${check.label === "outDir" || check.label === "receiptsRoot" ? "output" : "input"} root.`);
    }
  }
  return null;
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

function formatMetric(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
