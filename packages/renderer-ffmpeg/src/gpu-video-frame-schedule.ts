import {
  expandGpuSceneGroups,
  gpuSceneImageAssetRef,
  streamingFrameTimestampMs,
  type GpuScene2dFailure,
  type MotionLayer,
  type MotionPackage,
} from "@shellx-motion/core";

export const MAX_GPU_VIDEO_LOOP_SEGMENTS = 1_024;

export type GpuVideoDecodeSegment = {
  startOrdinal: number;
  frameCount: number;
  sourceStartMs: number;
};

export type GpuVideoFrameSchedule = {
  layer: MotionLayer;
  assetRef: string;
  atMs: number[];
  frameIndices: number[];
  sourceAtMs: number[];
  segments: readonly GpuVideoDecodeSegment[];
};

/** Finds unsupported playback timing on only the video frames final staging would visit. */
export function activeGpuVideoKeyframedPlaybackRateLayer(pkg: MotionPackage): { ok: true; layer?: MotionLayer } | { ok: false; failure: GpuScene2dFailure } {
  const hasCandidate = pkg.motion.layers.some((layer) => layer.type === "video" && layer.visible !== false && (layer.keyframes?.playbackRate?.length ?? 0) > 0);
  if (!hasCandidate) return { ok: true };
  let found: MotionLayer | undefined;
  const failure = forEachActiveGpuVideoFrame(pkg, (layer) => {
    if (layer.keyframes?.playbackRate?.length) {
      found = layer;
      return false;
    }
  });
  return failure ? { ok: false, failure } : { ok: true, ...(found ? { layer: found } : {}) };
}

/** Build data-only canonical video times before any source is opened or probed. */
export function gpuVideoFrameSchedules(pkg: MotionPackage): GpuVideoFrameSchedule[] {
  const byLayer = new Map<string, GpuVideoFrameSchedule>();
  const failure = forEachActiveGpuVideoFrame(pkg, (layer, atMs, index) => {
    if (layer.keyframes?.playbackRate?.length) throw new Error(`GPU video layer ${layer.id} keyframed playbackRate is not implemented safely yet.`);
    const assetRef = gpuSceneImageAssetRef(pkg.motion, layer);
    if (!assetRef || !pkg.manifest.assets.includes(assetRef)) throw new Error(`GPU video layer ${layer.id} must reference a declared package asset.`);
    const playbackRate = layer.playbackRate ?? 1;
    if (!Number.isFinite(playbackRate) || playbackRate <= 0 || playbackRate > 16) throw new Error(`GPU video layer ${layer.id} playbackRate must be within 0..16.`);
    const sourceAtMs = (layer.trimStartMs ?? 0) + ((atMs - layer.startMs) * playbackRate);
    const current = byLayer.get(layer.id) ?? { layer, assetRef, atMs: [], frameIndices: [], sourceAtMs: [], segments: [] };
    current.atMs.push(atMs);
    current.frameIndices.push(index);
    current.sourceAtMs.push(sourceAtMs);
    byLayer.set(layer.id, current);
  });
  if (failure) throw new Error(failure.message);
  return [...byLayer.values()];
}

function forEachActiveGpuVideoFrame(pkg: MotionPackage, visit: (layer: MotionLayer, atMs: number, frameIndex: number) => boolean | void): GpuScene2dFailure | undefined {
  const frameCount = Math.ceil((pkg.motion.durationMs / 1_000) * pkg.motion.fps);
  for (let index = 0; index < frameCount; index += 1) {
    const atMs = streamingFrameTimestampMs(index, pkg.motion.fps, pkg.motion.durationMs);
    const expanded = expandGpuSceneGroups(pkg.motion, atMs);
    if (!expanded.ok) return expanded.failure;
    for (const entry of expanded.entries) {
      if (entry.kind !== "layer" || entry.sourceLayer.type !== "video" || entry.sourceLayer.visible === false) continue;
      if (visit(entry.sourceLayer, entry.atMs, index) === false) return;
    }
  }
}

/** Bind loop windows to the immutable source duration and split every wrap before decoding. */
export function resolveGpuVideoFrameSchedules(
  schedules: readonly GpuVideoFrameSchedule[],
  durationFor: (assetRef: string) => number,
): GpuVideoFrameSchedule[] {
  return schedules.map((schedule) => {
    const sourceDurationMs = durationFor(schedule.assetRef);
    const trimStartMs = schedule.layer.trimStartMs ?? 0;
    const trimDurationMs = schedule.layer.trimDurationMs ?? (sourceDurationMs - trimStartMs);
    if (!Number.isFinite(sourceDurationMs) || sourceDurationMs <= 0 || !Number.isFinite(trimStartMs) || trimStartMs < 0
      || !Number.isFinite(trimDurationMs) || trimDurationMs <= 0 || trimStartMs + trimDurationMs > sourceDurationMs) {
      throw new Error(`GPU video layer ${schedule.layer.id} has a trim window outside its immutable source duration.`);
    }
    const cycles: number[] = [];
    const sourceAtMs = schedule.sourceAtMs.map((unwrapped) => {
      const elapsed = unwrapped - trimStartMs;
      if (!Number.isFinite(elapsed) || elapsed < 0) throw new Error(`GPU video layer ${schedule.layer.id} requests a negative source time.`);
      if (schedule.layer.loop === true) {
        const cycle = Math.floor(elapsed / trimDurationMs);
        cycles.push(cycle);
        return trimStartMs + (elapsed - (cycle * trimDurationMs));
      }
      cycles.push(0);
      if (elapsed >= trimDurationMs || unwrapped >= sourceDurationMs) {
        throw new Error(`GPU video layer ${schedule.layer.id} exceeds its non-looping trim window.`);
      }
      return unwrapped;
    });
    const segments = decodeSegments(sourceAtMs, cycles, schedule.frameIndices);
    if (segments.length > MAX_GPU_VIDEO_LOOP_SEGMENTS) {
      throw new Error(`GPU video layer ${schedule.layer.id} exceeds its ${MAX_GPU_VIDEO_LOOP_SEGMENTS}-segment loop staging bound.`);
    }
    return { ...schedule, sourceAtMs, segments };
  });
}

function decodeSegments(sourceAtMs: readonly number[], cycles: readonly number[], frameIndices: readonly number[]): GpuVideoDecodeSegment[] {
  const segments: GpuVideoDecodeSegment[] = [];
  for (let ordinal = 0; ordinal < sourceAtMs.length; ordinal += 1) {
    const prior = segments.at(-1);
    if (!prior || cycles[ordinal] !== cycles[ordinal - 1] || frameIndices[ordinal] !== frameIndices[ordinal - 1]! + 1) {
      segments.push({ startOrdinal: ordinal, frameCount: 1, sourceStartMs: sourceAtMs[ordinal]! });
    } else {
      prior.frameCount += 1;
    }
  }
  return segments;
}
