import { canonicalJson } from "./canonical-json";
import type {
  MotionAudioFadeCurve,
  MotionAudioMasterBus,
  RenderAudioMasterReadback,
} from "./audio-types";
import type { MotionDocument, MotionLayer } from "./types";

const MIN_INTEGRATED_LOUDNESS_LUFS = -70;
// FFmpeg loudnorm's fixed-control bounds. Keeping the document contract inside
// these means a valid master can always be constructed without passing a
// renderer-shaped number through to FFmpeg and hoping it refuses safely.
const MAX_INTEGRATED_LOUDNESS_LUFS = -5;
const MIN_TRUE_PEAK_DBTP = -9;
const MAX_TRUE_PEAK_DBTP = 0;
const MIN_LOUDNESS_RANGE_LU = 1;
const MAX_LOUDNESS_RANGE_LU = 50;
const MAX_MASTER_VOLUME = 4;

export const MOTION_AUDIO_FADE_CURVES: readonly MotionAudioFadeCurve[] = ["linear", "equal-power"] as const;

export interface MotionAudioMasterSetResult {
  motion: MotionDocument;
  oldMaster: MotionAudioMasterBus | null;
  newMaster: MotionAudioMasterBus | null;
  changedPaths: string[];
  action: "updated" | "cleared";
}

export interface MotionAudioCrossfadeSetResult {
  motion: MotionDocument;
  fromLayerId: string;
  toLayerId: string;
  durationMs: number;
  curve: MotionAudioFadeCurve;
  changedPaths: string[];
}

/** Validate and clone the deliberately small document-level master-bus record. */
export function normalizeMotionAudioMaster(value: unknown): MotionAudioMasterBus | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new Error("Audio master must be an object.");
  const unknownKeys = Object.keys(value).filter((key) => !["volume", "fadeInMs", "fadeOutMs", "fadeCurve", "loudness"].includes(key));
  if (unknownKeys.length > 0) throw new Error(`Audio master does not allow ${unknownKeys.join(", ")}.`);
  const master: MotionAudioMasterBus = {};
  if (value.volume !== undefined) {
    if (!isFiniteInRange(value.volume, 0, MAX_MASTER_VOLUME)) throw new Error(`Audio master volume must be a finite number from 0 to ${MAX_MASTER_VOLUME}.`);
    master.volume = value.volume;
  }
  for (const key of ["fadeInMs", "fadeOutMs"] as const) {
    if (value[key] !== undefined) {
      if (!isFiniteInRange(value[key], 0, Number.MAX_SAFE_INTEGER)) throw new Error(`Audio master ${key} must be a non-negative finite number.`);
      master[key] = value[key];
    }
  }
  if (value.fadeCurve !== undefined) {
    if (!isFadeCurve(value.fadeCurve)) throw new Error('Audio master fadeCurve must be "linear" or "equal-power".');
    master.fadeCurve = value.fadeCurve;
  }
  if (value.loudness !== undefined) {
    if (!isRecord(value.loudness)) throw new Error("Audio master loudness must be an object.");
    const loudness = value.loudness;
    const loudnessUnknown = Object.keys(loudness).filter((key) => !["integratedLufs", "toleranceLufs", "maxTruePeakDbtp", "maxLoudnessRangeLu"].includes(key));
    if (loudnessUnknown.length > 0) throw new Error(`Audio master loudness does not allow ${loudnessUnknown.join(", ")}.`);
    if (!isFiniteInRange(loudness.integratedLufs, MIN_INTEGRATED_LOUDNESS_LUFS, MAX_INTEGRATED_LOUDNESS_LUFS)) {
      throw new Error(`Audio master loudness integratedLufs must be a finite number from ${MIN_INTEGRATED_LOUDNESS_LUFS} to ${MAX_INTEGRATED_LOUDNESS_LUFS}.`);
    }
    if (!isFiniteInRange(loudness.toleranceLufs, 0, 24)) throw new Error("Audio master loudness toleranceLufs must be a finite number from 0 to 24.");
    if (!isFiniteInRange(loudness.maxTruePeakDbtp, MIN_TRUE_PEAK_DBTP, MAX_TRUE_PEAK_DBTP)) {
      throw new Error(`Audio master loudness maxTruePeakDbtp must be a finite number from ${MIN_TRUE_PEAK_DBTP} to ${MAX_TRUE_PEAK_DBTP}.`);
    }
    if (loudness.maxLoudnessRangeLu !== undefined && !isFiniteInRange(loudness.maxLoudnessRangeLu, MIN_LOUDNESS_RANGE_LU, MAX_LOUDNESS_RANGE_LU)) {
      throw new Error(`Audio master loudness maxLoudnessRangeLu must be a finite number from ${MIN_LOUDNESS_RANGE_LU} to ${MAX_LOUDNESS_RANGE_LU}.`);
    }
    master.loudness = {
      integratedLufs: loudness.integratedLufs,
      toleranceLufs: loudness.toleranceLufs,
      maxTruePeakDbtp: loudness.maxTruePeakDbtp,
      ...(loudness.maxLoudnessRangeLu !== undefined ? { maxLoudnessRangeLu: loudness.maxLoudnessRangeLu } : {})
    };
  }
  if (Object.keys(master).length === 0) throw new Error("Audio master requires at least one control or use clear.");
  return master;
}

export function setMotionAudioMaster(motion: MotionDocument, value: unknown): MotionAudioMasterSetResult {
  const oldMaster = motion.audio?.master ? structuredClone(motion.audio.master) : null;
  const newMaster = normalizeMotionAudioMaster(value);
  if (newMaster) assertMotionAudioMasterDuration(newMaster, motion.durationMs);
  if (canonicalJson(oldMaster) === canonicalJson(newMaster)) throw new Error("Audio master already matches the requested value.");
  const next = structuredClone(motion);
  if (newMaster === null) {
    if (next.audio) {
      const { master: _master, ...rest } = next.audio;
      if (Object.keys(rest).length === 0) delete next.audio;
      else next.audio = rest;
    }
  } else {
    next.audio = { ...(next.audio ?? {}), master: newMaster };
  }
  return { motion: next, oldMaster, newMaster, changedPaths: ["/audio/master"], action: newMaster ? "updated" : "cleared" };
}

/** Refuse a document master whose declared fades cannot be realized exactly. */
export function assertMotionAudioMasterDuration(master: MotionAudioMasterBus, durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("Audio master requires a positive finite document duration.");
  for (const key of ["fadeInMs", "fadeOutMs"] as const) {
    const value = master[key];
    if (value !== undefined && value > durationMs) {
      throw new Error(`Audio master ${key} must not exceed document duration ${durationMs}ms.`);
    }
  }
}

/**
 * Set a real crossfade between two already-overlapping audio sources. This
 * never moves layers: exact alignment prevents unrelated fades being called a
 * crossfade.
 */
export function setMotionAudioCrossfade(
  motion: MotionDocument,
  input: { fromLayerId: string; toLayerId: string; durationMs: number; curve?: MotionAudioFadeCurve }
): MotionAudioCrossfadeSetResult {
  if (!isNonEmpty(input.fromLayerId) || !isNonEmpty(input.toLayerId) || input.fromLayerId === input.toLayerId) {
    throw new Error("Audio crossfade requires two different layer ids.");
  }
  if (!isFiniteInRange(input.durationMs, 1, Number.MAX_SAFE_INTEGER)) throw new Error("Audio crossfade durationMs must be a positive finite number.");
  const curve = input.curve ?? "equal-power";
  if (!isFadeCurve(curve)) throw new Error('Audio crossfade curve must be "linear" or "equal-power".');
  const from = motion.layers.find((layer) => layer.id === input.fromLayerId);
  const to = motion.layers.find((layer) => layer.id === input.toLayerId);
  if (!from || !to) throw new Error("Audio crossfade layer not found.");
  if (!isAudioMixLayer(from) || !isAudioMixLayer(to)) throw new Error("Audio crossfade layers must be audio or video layers with includeAudio true.");
  if (from.locked || to.locked) throw new Error("Cannot set an audio crossfade on a locked layer.");
  if (lockedTrackForLayer(motion, from) || lockedTrackForLayer(motion, to)) throw new Error("Cannot set an audio crossfade on a locked track.");
  const fromFadeStartMs = from.startMs + from.durationMs - input.durationMs;
  if (input.durationMs > from.durationMs || input.durationMs > to.durationMs || Math.abs(to.startMs - fromFadeStartMs) > 0.000001) {
    throw new Error("Audio crossfade duration must exactly match the overlap from the outgoing layer end to the incoming layer start.");
  }
  const next = structuredClone(motion);
  const fromIndex = next.layers.findIndex((layer) => layer.id === input.fromLayerId);
  const toIndex = next.layers.findIndex((layer) => layer.id === input.toLayerId);
  next.layers[fromIndex] = { ...next.layers[fromIndex], fadeOutMs: input.durationMs, fadeCurve: curve };
  next.layers[toIndex] = { ...next.layers[toIndex], fadeInMs: input.durationMs, fadeCurve: curve };
  return {
    motion: next,
    fromLayerId: input.fromLayerId,
    toLayerId: input.toLayerId,
    durationMs: input.durationMs,
    curve,
    changedPaths: [
      `/layers/${input.fromLayerId}/fadeOutMs`, `/layers/${input.fromLayerId}/fadeCurve`,
      `/layers/${input.toLayerId}/fadeInMs`, `/layers/${input.toLayerId}/fadeCurve`
    ]
  };
}

export function motionAudioFadeCurve(value: unknown): MotionAudioFadeCurve {
  return value === "equal-power" ? "equal-power" : "linear";
}

/** Fail-closed evaluation of the delivered program against a document target. */
export function evaluateMotionAudioMasterLoudness(
  master: MotionAudioMasterBus,
  readback: RenderAudioMasterReadback | null
): { ok: true } | { ok: false; message: string } {
  const target = master.loudness;
  if (!target) return { ok: true };
  if (!readback || readback.integratedLufs === null || readback.truePeakDbtp === null
    || (target.maxLoudnessRangeLu !== undefined && readback.loudnessRangeLu === null)) {
    return { ok: false, message: "Audio master loudness target requires a complete delivered-program readback." };
  }
  const distance = Math.abs(readback.integratedLufs - target.integratedLufs);
  if (distance > target.toleranceLufs) {
    return { ok: false, message: `Delivered integrated loudness is ${format(readback.integratedLufs)} LUFS; target is ${format(target.integratedLufs)} +/- ${format(target.toleranceLufs)} LU.` };
  }
  if (readback.truePeakDbtp > target.maxTruePeakDbtp) {
    return { ok: false, message: `Delivered true peak is ${format(readback.truePeakDbtp)} dBTP; expected at most ${format(target.maxTruePeakDbtp)} dBTP.` };
  }
  if (target.maxLoudnessRangeLu !== undefined && readback.loudnessRangeLu! > target.maxLoudnessRangeLu) {
    return { ok: false, message: `Delivered loudness range is ${format(readback.loudnessRangeLu!)} LU; expected at most ${format(target.maxLoudnessRangeLu)} LU.` };
  }
  return { ok: true };
}

function isAudioMixLayer(layer: MotionLayer): boolean {
  return layer.type === "audio" || (layer.type === "video" && layer.includeAudio === true);
}
function lockedTrackForLayer(motion: MotionDocument, layer: MotionLayer): string | undefined {
  return motion.tracks?.find((track) => track.locked && (track.id === layer.trackId || track.layerIds?.includes(layer.id)))?.id;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  // The renderer is callable from runtime JavaScript, so do not let a getter
  // execute while merely validating what must be data-only controls.
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => "value" in descriptor);
}
function isFadeCurve(value: unknown): value is MotionAudioFadeCurve { return value === "linear" || value === "equal-power"; }
function isNonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function isFiniteInRange(value: unknown, min: number, max: number): value is number { return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max; }
function format(value: number): string { return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, ""); }
