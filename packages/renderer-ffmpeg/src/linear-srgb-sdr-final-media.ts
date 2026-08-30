import { canonicalJsonSha256 } from "@shellx-motion/core";
import type { ProbeMediaResult } from "./index.js";

export const LINEAR_SRGB_SDR_FINAL_MEDIA_OBSERVATION_SCHEMA = "shellx-motion/linear-srgb-sdr-final-media-observation@1" as const;

export interface LinearSrgbSdrFinalMediaObservation {
  readonly schema: typeof LINEAR_SRGB_SDR_FINAL_MEDIA_OBSERVATION_SCHEMA;
  readonly codec: "h264";
  readonly width: number;
  readonly height: number;
  readonly durationMs: number;
  readonly fps: number;
  readonly container: string;
  readonly color: { readonly pixelFormat: "yuv420p"; readonly space: "bt709"; readonly transfer: "bt709"; readonly primaries: "bt709"; readonly range: "tv" };
  readonly alpha: { readonly present: false };
  readonly audio: { readonly present: false; readonly streamCount: 0 };
  readonly fingerprint: string;
}

/** Hard validation of what FFprobe observed, with the host path removed from retained evidence. */
export function validateLinearSrgbSdrFinalMedia(input: {
  readonly media: ProbeMediaResult;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly frameCount: number;
}): LinearSrgbSdrFinalMediaObservation {
  const { media } = input;
  const expectedDurationMs = (input.frameCount * 1_000) / input.fps;
  const durationToleranceMs = Math.max(2, 1_000 / input.fps);
  if (media.codec !== "h264" || media.width !== input.width || media.height !== input.height
    || Math.abs(media.fps - input.fps) > 0.000_001
    || Math.abs(media.durationMs - expectedDurationMs) > durationToleranceMs
    || !media.container.split(",").includes("mp4")
    || media.color.pixelFormat !== "yuv420p" || media.color.space !== "bt709"
    || media.color.transfer !== "bt709" || media.color.primaries !== "bt709" || media.color.range !== "tv"
    || media.alpha.present || media.audio.present || media.audio.streamCount !== 0) {
    throw new Error("Strict SDR FFprobe readback does not match the fixed H.264 BT.709 limited-range contract.");
  }
  const base = {
    schema: LINEAR_SRGB_SDR_FINAL_MEDIA_OBSERVATION_SCHEMA,
    codec: "h264" as const,
    width: media.width,
    height: media.height,
    durationMs: media.durationMs,
    fps: media.fps,
    container: media.container,
    color: { pixelFormat: "yuv420p" as const, space: "bt709" as const, transfer: "bt709" as const, primaries: "bt709" as const, range: "tv" as const },
    alpha: { present: false as const },
    audio: { present: false as const, streamCount: 0 as const },
  };
  return freeze({ ...base, fingerprint: canonicalJsonSha256(base) });
}

function freeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) freeze(child); Object.freeze(value); } return value; }
