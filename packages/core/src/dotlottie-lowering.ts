import { lowerStaticLottieToMotion, type AdapterDiagnosticInput, type LottieLoweringResult } from "./adapter-diagnostics";
import { hashBuffer } from "./receipts";
import type { DotLottieManifestAnimation } from "./dotlottie-types";
import type { AppliedDotLottieTheme } from "./dotlottie-theme";
import type { LottieBundledFontAsset, LottieBundledImageAsset } from "./lottie-lowering-assets";

export function lowerSelectedDotLottieToMotion(input: AdapterDiagnosticInput & {
  createdBy?: string;
  animation: DotLottieManifestAnimation;
  appliedTheme?: Omit<AppliedDotLottieTheme, "animationText">;
  bundledImages?: LottieBundledImageAsset[];
  bundledFonts?: LottieBundledFontAsset[];
}): LottieLoweringResult {
  const lowered = lowerStaticLottieToMotion({
    ...input,
    sourceApp: "dotlottie",
    bundledImages: input.bundledImages,
    bundledFonts: input.bundledFonts
  });
  if (input.animation.background === undefined && !input.appliedTheme) return lowered;
  const background = input.animation.background === undefined ? undefined : dotLottieRgbaU32(input.animation.background);
  const motion = background ? { ...lowered.motion, background } : lowered.motion;
  const motionSha256 = hashBuffer(Buffer.from(`${JSON.stringify(motion, null, 2)}\n`, "utf8"));
  const previousOutput = readRecord(lowered.receipt.output);
  return {
    ...lowered,
    motion,
    receipt: {
      ...lowered.receipt,
      id: `adapter-lowering-lottie-${motionSha256.slice(0, 16)}`,
      output: {
        ...previousOutput,
        motionSha256,
        ...(background ? { dotLottieBackground: { source: input.animation.background, motion: background } } : {}),
        ...(input.appliedTheme ? { dotLottieTheme: input.appliedTheme } : {})
      }
    }
  };
}

export function dotLottieRgbaU32(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error("dotLottie background must be a u32 RGBA value.");
  return `#${value.toString(16).padStart(8, "0")}`;
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}
