import { hashBuffer } from "./receipts";
import { parseBoundedLottieJson } from "./lottie-json";
import { hasLottiePrecompLayers, lowerLottieGpuPrecomps, type LottieGpuPrecompLeafContext } from "./lottie-precomp-gpu-lowering";
import { prepareLottieLoweringAssets, type LottieBundledImageAsset } from "./lottie-lowering-assets";
import type { AdapterDiagnosticInput, AdapterDiagnosticResult, LottieLoweringResult } from "./adapter-diagnostics";
import type { MotionDocument, MotionLayer, OperationReceipt } from "./types";

export type LottieGpuPrecompStaticLeafLowerer = (input: LottieGpuPrecompLeafContext & {
  bundledImages: Map<string, LottieBundledImageAsset>;
  exactTiming: true;
}) => MotionLayer[];

/**
 * Dedicated adapter branch for the exact GPU group-compositor subset. This is
 * deliberately selected before the legacy diagnostic inventory, which reports
 * ty:0 as unsupported; callers must leave no-precomp imports on that legacy
 * path byte-for-byte unchanged.
 */
export function tryLowerStaticLottieGpuPrecomps(
  input: AdapterDiagnosticInput & { createdBy?: string; sourceApp?: "lottie" | "dotlottie"; bundledImages?: LottieBundledImageAsset[]; bundledFonts?: import("./lottie-lowering-assets").LottieBundledFontAsset[] },
  lowerLeaf: LottieGpuPrecompStaticLeafLowerer,
): LottieLoweringResult | null {
  const source = parseBoundedLottieJson(input.sourceText);
  if (!hasLottiePrecompLayers(source)) return null;
  const width = positive(source.w, "w"); const height = positive(source.h, "h"); const fps = positive(source.fr, "fr");
  const inFrame = finite(source.ip, "ip"); const outFrame = finite(source.op, "op");
  if (outFrame <= inFrame) throw new Error("Lottie GPU precomposition lowering requires op greater than ip.");
  const durationUs = frameToUs(outFrame - inFrame, fps);
  const preparedAssets = prepareLottieLoweringAssets(input.bundledImages, input.bundledFonts);
  const sourceSha256 = hashBuffer(Buffer.from(input.sourceText, "utf8"));
  const motion: Omit<MotionDocument, "layers"> = {
    schema: "shellx-motion/motion@1", id: `motion_lottie_${sourceSha256.slice(0, 16)}`,
    name: string(source.nm) ?? "Lottie Import", durationMs: durationUs / 1_000, fps, width, height, background: "#00000000", assets: preparedAssets.motionAssets,
    provenance: { sourceApp: input.sourceApp ?? "lottie", createdBy: boundedCreatedBy(input.createdBy), sourceSchema: string(source.v) ?? "lottie-json" }
  };
  const lowered = lowerLottieGpuPrecomps({
    sourceText: input.sourceText, baseMotion: motion,
    lowerLeaf: (context) => lowerLeaf({ ...context, bundledImages: preparedAssets.images, exactTiming: true })
  });
  if (!lowered) return null;
  if (lowered.sourceSha256 !== sourceSha256) throw new Error("Lottie GPU precomposition source hash changed during lowering.");
  const diagnostics = diagnostic(input, sourceSha256, lowered);
  const receipt: OperationReceipt = {
    schema: "shellx-motion/receipt@1", id: `adapter-lowering-lottie-${lowered.outputMotionSha256.slice(0, 16)}`,
    operation: "adapter.lower", status: "passed", packageId: input.normalizedPackagePath, inputHashes: { source: sourceSha256 },
    createdAt: input.createdAt ?? new Date().toISOString(), lane: "adapter",
    output: {
      adapterId: "adapter.lottie", format: "lottie", motionId: lowered.motion.id, motionSha256: lowered.outputMotionSha256,
      layerCount: lowered.motion.layers.length, bundledImageCount: preparedAssets.images.size, bundledFontCount: input.bundledFonts?.length ?? 0,
      lossiness: diagnostics.lossiness, acceptedWarningFeatures: [],
      lottieGpuPrecomposition: { schema: lowered.schema, sourceSha256, loweringFingerprint: lowered.loweringFingerprint, outputMotionSha256: lowered.outputMotionSha256, budget: lowered.budget, execution: "persistent-gpu-group-compositor-only; no direct Browser or Native claim" }
    }, warnings: []
  };
  return { schema: "shellx-motion/adapter-lowering@1", adapterId: "adapter.lottie", source: diagnostics.source, motion: lowered.motion, diagnostics, receipt };
}

function diagnostic(input: AdapterDiagnosticInput, sourceSha256: string, lowered: NonNullable<ReturnType<typeof lowerLottieGpuPrecomps>>): AdapterDiagnosticResult {
  const supportedFeatures = [{ path: "lottie", feature: "lottie.composition", status: "supported" as const, reason: "Composition dimensions and exact microsecond frame bounds map to a Motion document." }, ...lowered.diagnostics.map((entry) => ({ path: entry.path, feature: entry.code, status: "supported" as const, reason: entry.message }))];
  const lossiness = { level: "none" as const, budget: "Exact static/hold affine precomposition lowering is bounded to the persistent GPU group compositor.", unsupportedCount: 0, warningCount: 0, supportedCount: supportedFeatures.length };
  const result = {
    schema: "shellx-motion/adapter-diagnostics@1" as const, adapterId: "adapter.lottie", format: "lottie" as const,
    source: { path: input.sourcePath, sha256: sourceSha256 }, normalizedPackagePath: input.normalizedPackagePath,
    supportedFeatures, warningFeatures: [], unsupportedFeatures: [], recommendedFallbackLane: "none" as const, lossiness,
    suggestedNextAction: "This lowering is exact only for the persistent GPU group compositor; it does not claim a direct Browser or Native renderer path."
  };
  return { ...result, receipt: diagnosticReceipt({ ...result, createdAt: input.createdAt ?? new Date().toISOString() }, lowered) };
}

function diagnosticReceipt(input: Omit<AdapterDiagnosticResult, "receipt"> & { createdAt: string }, lowered: NonNullable<ReturnType<typeof lowerLottieGpuPrecomps>>): OperationReceipt {
  return { schema: "shellx-motion/receipt@1", id: `adapter-diagnostics-lottie-${input.source.sha256.slice(0, 16)}`, operation: "adapter.diagnostics", status: "passed", packageId: input.normalizedPackagePath, inputHashes: { source: input.source.sha256 }, createdAt: input.createdAt, lane: "adapter", output: { adapterId: input.adapterId, format: input.format, source: input.source, normalizedPackagePath: input.normalizedPackagePath, supportedFeatures: input.supportedFeatures, warningFeatures: [], unsupportedFeatures: [], recommendedFallbackLane: "none", lossiness: input.lossiness, suggestedNextAction: input.suggestedNextAction, lottieGpuPrecomposition: { schema: lowered.schema, sourceSha256: lowered.sourceSha256, loweringFingerprint: lowered.loweringFingerprint, outputMotionSha256: lowered.outputMotionSha256, budget: lowered.budget } }, warnings: [] };
}

function positive(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 32_768) throw new Error(`Lottie ${label} must be a positive bounded number.`); return value; }
function finite(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1_000_000) throw new Error(`Lottie ${label} must be a bounded finite number.`); return value; }
function frameToUs(frames: number, fps: number): number { const value = frames * 1_000_000 / fps; if (!Number.isSafeInteger(value)) throw new Error("Lottie GPU precomposition frame time cannot map losslessly to a safe integer microsecond."); return value; }
function string(value: unknown): string | undefined { return typeof value === "string" && value.length <= 128 ? value : undefined; }
function boundedCreatedBy(value: string | undefined): string { return value && value.length <= 128 ? value : "adapter"; }
