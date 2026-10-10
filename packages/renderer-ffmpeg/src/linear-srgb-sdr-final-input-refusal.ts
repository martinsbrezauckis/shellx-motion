import { extname, resolve } from "node:path";
import { isCoreDerivedOutputPublication } from "@shellx-motion/core/internal/derived-output-publication-authenticity";
import { matchesCurrentStrictSdrCandidateHeldPairRendererInput } from "@shellx-motion/core/internal/strict-sdr-candidate-held-pair";
import { assertSafeFfmpegOutputPath } from "./ffmpeg-path-safety.js";
import type { RenderStreamingFinalInput } from "./streaming-final-adapter-types.js";

/** Pure strict admission checks, including the active Core-held logical-output equivalence. */
export function strictLinearSrgbSdrFinalInputRefusal(input: RenderStreamingFinalInput, authenticatePublication = true): string | undefined {
  if (input.frameLane !== "gpu" || (input.preset ?? "mp4-h264") !== "mp4-h264") return "linear-srgb-sdr@1 requires the exact streamed GPU to FFmpeg mp4-h264 final route.";
  if (extname(input.outputPath).toLowerCase() !== ".mp4") return "linear-srgb-sdr@1 requires an .mp4 final output path.";
  if (input.transport && (input.transport.delivery !== "streamed" || input.transport.reason !== "stream_default")) return "linear-srgb-sdr@1 refuses every materialized frame transport.";
  if (input.audioPath || input.audio || (input.audioTracks?.length ?? 0) > 0 || input.audioMaster) return "linear-srgb-sdr@1 strict delivery refuses audio and audio muxing.";
  if (input.keepFrames === true || input.quality || input.qualityManifest) return "linear-srgb-sdr@1 strict delivery refuses frame retention and generic quality policies; it performs its own mandatory decoded comparison.";
  try {
    assertSafeFfmpegOutputPath(input.outputPath, input.outputRoots);
  } catch (error) {
    return safeLinearSrgbSdrFinalMessage(error);
  }
  if (authenticatePublication && input.outputPublication && (!isCoreDerivedOutputPublication(input.outputPublication)
    || input.outputPublication.kind !== "file"
    || (input.outputPublication.outputPath !== resolve(input.outputPath)
      && !matchesCurrentStrictSdrCandidateHeldPairRendererInput(input.outputPublication, input.linearSrgbSdrFinalPreparation?.fingerprint, input.outputPath)))) {
    return "linear-srgb-sdr@1 requires an identity-bound Motion file publication for the exact requested output.";
  }
  if (input.toolPolicy) return "linear-srgb-sdr@1 strict delivery uses Motion's fixed governed tools and refuses every generic tool-policy override.";
  if (input.now) return "linear-srgb-sdr@1 strict delivery refuses generic clock overrides.";
  return undefined;
}

export function safeLinearSrgbSdrFinalMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Strict linear-sRGB SDR final preflight failed.";
  return message.replace(/(?:[A-Za-z]:)?[\\/][^\s"']+/gu, "<path>").slice(0, 360);
}
