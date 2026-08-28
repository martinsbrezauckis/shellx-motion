import {
  resolvePackageAsset,
  timelineLayerMutedTrackId,
  timelineLayerSoloedTrackId,
  timelineLayerTrackFade,
  timelineLayerTrackPan,
  timelineLayerTrackVolume,
  motionAudioFadeCurve,
  type MotionAudioDucking,
  type MotionAudioMasterBus,
  type MotionKeyframe,
  type MotionLayer,
  type MotionPackage
} from "@shellx-motion/core";
import type { FfmpegAudioInput } from "@shellx-motion/renderer-ffmpeg";

const DEFAULT_DUCK_TO_VOLUME = 0.35;
const DEFAULT_DUCK_ATTACK_MS = 120;
const DEFAULT_DUCK_RELEASE_MS = 250;

export function packageAudioEncodeInput(pkg: MotionPackage): { audio?: FfmpegAudioInput; audioTracks?: FfmpegAudioInput[]; audioMaster?: MotionAudioMasterBus } {
  const audioInputs = resolvePackageAudioInputs(pkg);
  const audioMaster = pkg.motion.audio?.master ? structuredClone(pkg.motion.audio.master) : undefined;
  return {
    ...(audioInputs.length > 1
      ? { audioTracks: audioInputs }
      : audioInputs.length === 1
        ? { audio: audioInputs[0] }
        : {}),
    ...(audioMaster ? { audioMaster } : {})
  };
}

export function resolvePackageAudioInputs(pkg: MotionPackage): FfmpegAudioInput[] {
  const hasSoloedTrack = hasSoloedTimelineTrack(pkg);
  const timelineLayers = globalTimelineLayers(pkg.motion.layers, pkg.motion.durationMs);
  return timelineLayers
    .filter((layer) => layer.startMs < pkg.motion.durationMs && layer.startMs + layer.durationMs > 0)
    .map((layer): FfmpegAudioInput | null => packageLayerAudioInput(pkg, layer, hasSoloedTrack, timelineLayers))
    .filter((audio): audio is FfmpegAudioInput => audio !== null);
}

function packageLayerAudioInput(pkg: MotionPackage, layer: MotionLayer, hasSoloedTrack: boolean, timelineLayers: readonly MotionLayer[]): FfmpegAudioInput | null {
  if (layer.type !== "audio" && !(layer.type === "video" && layer.includeAudio === true)) return null;
  if (hasSoloedTrack && !timelineLayerSoloedTrackId(pkg.motion, layer)) return null;
  if (timelineLayerMutedTrackId(pkg.motion, layer)) return null;
  const ref = audioLayerAssetRef(pkg, layer);
  if (!ref || !isLocalAssetRef(ref)) return null;
  const volume = effectiveAudioLayerVolume(pkg, layer);
  const pan = effectiveAudioLayerPan(pkg, layer);
  const fade = effectiveAudioLayerFade(pkg, layer);
  const ducking = readAudioDucking(layer.ducking);
  const volumeKeyframes = Array.isArray(layer.keyframes?.volume)
    ? layer.keyframes.volume
    : duckingVolumeKeyframes(pkg, ducking, timelineLayers);
  const panKeyframes = Array.isArray(layer.keyframes?.pan) ? layer.keyframes.pan : undefined;
  return {
    path: resolvePackageAsset(pkg, ref),
    // Carry the source layer id so the renderer can correlate a sidechain
    // ducking layer's triggerLayerIds back to the concrete FFmpeg input index.
    layerId: layer.id,
    ...(layer.startMs > 0 ? { startMs: layer.startMs } : {}),
    durationMs: layer.durationMs,
    ...(typeof layer.trimStartMs === "number" ? { trimStartMs: layer.trimStartMs } : {}),
    ...(typeof layer.trimDurationMs === "number" ? { trimDurationMs: layer.trimDurationMs } : {}),
    ...(typeof layer.loop === "boolean" ? { loop: layer.loop } : {}),
    ...(volume !== undefined ? { volume } : {}),
    ...(pan !== undefined && !panKeyframes ? { pan } : {}),
    ...(typeof layer.muted === "boolean" ? { muted: layer.muted } : {}),
    ...(fade.fadeInMs !== undefined ? { fadeInMs: fade.fadeInMs } : {}),
    ...(fade.fadeOutMs !== undefined ? { fadeOutMs: fade.fadeOutMs } : {}),
    ...(fade.fadeCurve !== undefined ? { fadeCurve: fade.fadeCurve } : {}),
    ...(typeof layer.normalizeLoudness === "boolean" ? { normalizeLoudness: layer.normalizeLoudness } : {}),
    ...(typeof layer.playbackRate === "number" ? { playbackRate: layer.playbackRate } : {}),
    ...(ducking ? { ducking } : {}),
    ...(volumeKeyframes && volumeKeyframes.length > 0 ? { volumeKeyframes } : {}),
    ...(panKeyframes && panKeyframes.length > 0 ? { panKeyframes } : {})
  };
}

function readAudioDucking(value: unknown): MotionAudioDucking | undefined {
  const record = readRecord(value);
  if (!Array.isArray(record.triggerLayerIds)) return undefined;
  const triggerLayerIds = record.triggerLayerIds.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  if (triggerLayerIds.length === 0) return undefined;
  return {
    triggerLayerIds,
    ...(record.mode === "timed" || record.mode === "sidechain" ? { mode: record.mode } : {}),
    ...(typeof record.duckToVolume === "number" && Number.isFinite(record.duckToVolume) && record.duckToVolume >= 0 ? { duckToVolume: record.duckToVolume } : {}),
    ...(typeof record.attackMs === "number" && Number.isFinite(record.attackMs) && record.attackMs >= 0 ? { attackMs: record.attackMs } : {}),
    ...(typeof record.releaseMs === "number" && Number.isFinite(record.releaseMs) && record.releaseMs >= 0 ? { releaseMs: record.releaseMs } : {}),
    ...(typeof record.threshold === "number" && Number.isFinite(record.threshold) && record.threshold > 0 && record.threshold <= 1 ? { threshold: record.threshold } : {}),
    ...(typeof record.ratio === "number" && Number.isFinite(record.ratio) && record.ratio >= 1 ? { ratio: record.ratio } : {})
  };
}

function duckingVolumeKeyframes(pkg: MotionPackage, ducking: MotionAudioDucking | undefined, timelineLayers: readonly MotionLayer[]): MotionKeyframe[] | undefined {
  if (!ducking) return undefined;
  // "sidechain" ducking is realized by the FFmpeg sidechaincompress filter at
  // render time, so it must NOT be pre-lowered into volume keyframes here.
  // Only the default "timed" mode precomputes a time-window volume envelope.
  if (ducking.mode === "sidechain") return undefined;
  const duckToVolume = ducking.duckToVolume ?? DEFAULT_DUCK_TO_VOLUME;
  const attackMs = ducking.attackMs ?? DEFAULT_DUCK_ATTACK_MS;
  const releaseMs = ducking.releaseMs ?? DEFAULT_DUCK_RELEASE_MS;
  const intervals = mergedDuckingIntervals(pkg, ducking, attackMs, releaseMs, timelineLayers);
  if (intervals.length === 0) return undefined;
  const keyframes: MotionKeyframe[] = [];
  for (const interval of intervals) {
    if (interval.attackStartMs < interval.duckStartMs) {
      keyframes.push({ atMs: interval.attackStartMs, value: 1, easing: "ease-out" });
      keyframes.push({ atMs: interval.duckStartMs, value: duckToVolume });
    } else {
      keyframes.push({ atMs: interval.duckStartMs, value: duckToVolume });
    }
    if (interval.releaseEndMs > interval.duckEndMs) {
      keyframes.push({ atMs: interval.duckEndMs, value: duckToVolume, easing: "ease-in" });
      keyframes.push({ atMs: interval.releaseEndMs, value: 1 });
    } else {
      keyframes.push({ atMs: interval.duckEndMs, value: 1 });
    }
  }
  return coalesceDuckingKeyframes(keyframes);
}

interface DuckingInterval {
  attackStartMs: number;
  duckStartMs: number;
  duckEndMs: number;
  releaseEndMs: number;
}

function mergedDuckingIntervals(pkg: MotionPackage, ducking: MotionAudioDucking, attackMs: number, releaseMs: number, timelineLayers: readonly MotionLayer[]): DuckingInterval[] {
  const intervals = ducking.triggerLayerIds
    .map((layerId) => timelineLayers.find((layer) => layer.id === layerId))
    .filter((layer): layer is MotionLayer => Boolean(layer))
    .map((layer) => {
      const duckStartMs = Math.max(0, Math.min(pkg.motion.durationMs, layer.startMs));
      const duckEndMs = Math.max(duckStartMs, Math.min(pkg.motion.durationMs, layer.startMs + layer.durationMs));
      return {
        attackStartMs: Math.max(0, duckStartMs - attackMs),
        duckStartMs,
        duckEndMs,
        releaseEndMs: Math.min(pkg.motion.durationMs, duckEndMs + releaseMs)
      };
    })
    .filter((interval) => interval.duckEndMs > interval.duckStartMs)
    .sort((a, b) => a.attackStartMs - b.attackStartMs);
  const merged: DuckingInterval[] = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (!last || interval.attackStartMs > last.releaseEndMs) {
      merged.push({ ...interval });
      continue;
    }
    last.duckEndMs = Math.max(last.duckEndMs, interval.duckEndMs);
    last.releaseEndMs = Math.max(last.releaseEndMs, interval.releaseEndMs);
  }
  return merged;
}

/** Expands bounded group-local timing into the global audio timeline. */
function globalTimelineLayers(layers: readonly MotionLayer[], durationMs: number): MotionLayer[] {
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  const owned = new Set<string>();
  for (const layer of layers) if (layer.type === "group") {
    for (const childId of layer.childLayerIds ?? []) owned.add(childId);
  }
  const result: MotionLayer[] = [];
  const visit = (layer: MotionLayer, parentStartMs: number, parentEndMs: number, ancestry: readonly string[]): void => {
    const startMs = parentStartMs + layer.startMs;
    const endMs = Math.min(durationMs, parentEndMs, startMs + layer.durationMs);
    if (endMs <= startMs || startMs >= durationMs || endMs <= 0) return;
    if (layer.type !== "group") {
      result.push(startMs === layer.startMs && endMs - startMs === layer.durationMs
        ? layer
        : { ...layer, startMs, durationMs: endMs - startMs });
      return;
    }
    if (ancestry.includes(layer.id) || ancestry.length >= 4) return;
    const nextAncestry = [...ancestry, layer.id];
    for (const childId of layer.childLayerIds ?? []) {
      const child = byId.get(childId);
      if (child) visit(child, startMs, endMs, nextAncestry);
    }
  };
  for (const layer of layers) if (!owned.has(layer.id)) visit(layer, 0, durationMs, []);
  return result;
}

function coalesceDuckingKeyframes(keyframes: MotionKeyframe[]): MotionKeyframe[] {
  const result: MotionKeyframe[] = [];
  for (const keyframe of keyframes) {
    const previous = result[result.length - 1];
    if (previous && previous.atMs === keyframe.atMs) {
      result[result.length - 1] = keyframe;
    } else {
      result.push(keyframe);
    }
  }
  return result;
}

function audioLayerAssetRef(pkg: MotionPackage, layer: MotionLayer): string | undefined {
  for (const value of [layer.assetRef, layer.source, layer.src]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const assetId = typeof layer.assetId === "string" && layer.assetId.trim() ? layer.assetId.trim() : undefined;
  return assetId ? findAssetPath(pkg, assetId) : undefined;
}

function findAssetPath(pkg: MotionPackage, assetId: string): string | undefined {
  for (const asset of pkg.motion.assets) {
    const record = readRecord(asset);
    if (record.id !== assetId) continue;
    const source = readRecord(record.source);
    const path = source.path;
    if (typeof path === "string" && path.trim()) return path.trim();
  }
  return undefined;
}

function effectiveAudioLayerVolume(pkg: MotionPackage, layer: MotionLayer): number | undefined {
  const trackVolume = timelineLayerTrackVolume(pkg.motion, layer);
  const layerVolume = typeof layer.volume === "number" ? layer.volume : undefined;
  if (trackVolume === undefined && layerVolume === undefined) return undefined;
  return (trackVolume ?? 1) * (layerVolume ?? 1);
}

function effectiveAudioLayerPan(pkg: MotionPackage, layer: MotionLayer): number | undefined {
  return typeof layer.pan === "number" ? layer.pan : timelineLayerTrackPan(pkg.motion, layer);
}

function effectiveAudioLayerFade(pkg: MotionPackage, layer: MotionLayer): { fadeInMs?: number; fadeOutMs?: number; fadeCurve?: "linear" | "equal-power" } {
  const trackFade = timelineLayerTrackFade(pkg.motion, layer);
  const hasFade = typeof layer.fadeInMs === "number"
    || typeof layer.fadeOutMs === "number"
    || trackFade.fadeInMs !== undefined
    || trackFade.fadeOutMs !== undefined;
  return {
    ...(typeof layer.fadeInMs === "number" ? { fadeInMs: layer.fadeInMs } : trackFade.fadeInMs !== undefined ? { fadeInMs: trackFade.fadeInMs } : {}),
    ...(typeof layer.fadeOutMs === "number" ? { fadeOutMs: layer.fadeOutMs } : trackFade.fadeOutMs !== undefined ? { fadeOutMs: trackFade.fadeOutMs } : {}),
    ...(hasFade ? { fadeCurve: motionAudioFadeCurve(layer.fadeCurve) } : {})
  };
}

function hasSoloedTimelineTrack(pkg: MotionPackage): boolean {
  return (pkg.motion.tracks ?? []).some((track) => track.solo === true);
}

function isLocalAssetRef(ref: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(ref);
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}
