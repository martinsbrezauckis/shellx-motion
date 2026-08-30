import { resolveMotionColorPipeline } from "./color-pipeline";
import { resolveLinearSrgbSdrFinalRoute } from "./linear-srgb-sdr-final-route";
import type {
  CapabilityMatch,
  MotionDocument,
  RendererCapabilityCard,
  RendererCapabilityCardMatch,
  RendererCapabilityMatchOptions,
} from "./types";

export function recommendedRendererCapabilityLane(
  motion: MotionDocument,
  matches: readonly RendererCapabilityCardMatch[],
): RendererCapabilityCard["lane"] | null {
  if (resolveMotionColorPipeline(motion).intent === "linear-srgb-sdr@1") {
    return matches.find((match) => match.ok && match.lane === "ffmpeg")?.lane ?? null;
  }
  return matches.find((match) => match.ok)?.lane ?? null;
}

export function strictLinearSrgbSdrRouteCapabilityMatch(
  motion: MotionDocument,
  card: RendererCapabilityCard,
): CapabilityMatch | undefined {
  if (resolveMotionColorPipeline(motion).intent !== "linear-srgb-sdr@1" || (card.lane !== "gpu" && card.lane !== "ffmpeg")) return undefined;
  const resolution = resolveLinearSrgbSdrFinalRoute(motion, {
    target: "final",
    frameLane: "gpu",
    delivery: "streamed",
    finalLane: "ffmpeg",
    preset: "mp4-h264",
  });
  if (resolution.ok) return { ok: true, lane: card.lane, unsupported: [] };
  return {
    ok: false,
    lane: card.lane,
    unsupported: [{
      layerId: "__color_pipeline__",
      feature: "color-pipeline:linear-srgb-sdr@1",
      reason: resolution.refusal.message,
    }],
  };
}

export function rendererCapabilityCardOptionMatch(
  card: RendererCapabilityCard,
  options: RendererCapabilityMatchOptions,
  strictRouteLane: boolean,
): { outputOk: boolean; targetOk: boolean; alphaOk: boolean; audioOk: boolean; subtitlesOk: boolean } {
  if (strictRouteLane) {
    return {
      outputOk: !options.output || options.output === "mp4-h264",
      targetOk: !options.target || options.target === "final",
      alphaOk: options.needsAlpha !== true,
      audioOk: options.needsAudio !== true,
      subtitlesOk: options.needsSubtitles !== true,
    };
  }
  return {
    outputOk: !options.output || card.outputs.includes(options.output),
    targetOk: !options.target || card.renderTargets.includes(options.target),
    alphaOk: options.needsAlpha !== true || card.alpha,
    audioOk: options.needsAudio !== true || card.audio !== "none",
    subtitlesOk: options.needsSubtitles !== true || card.subtitles,
  };
}
