/**
 * Internal final-encode policy helpers shared by the materialized and streamed paths.
 *
 * This file intentionally has no package-barrel export. It keeps receipt-relevant decisions (audio
 * resolution, loudness evidence, delivered-colour grading, and input hashes) byte-for-byte shared
 * without making a transport helper part of renderer-ffmpeg's public API.
 */
import {
  hashFile,
  type MotionAudioDucking,
  type MotionKeyframe,
  type RenderAudioMasterEvidence,
  type RenderLoudnessSummary,
  type RenderLoudnessTrack
} from "@shellx-motion/core";
import type {
  AudioLevelResult,
  FfmpegAudioInput,
  FfmpegColorTag,
  FfmpegExportPresetSpec,
  FfmpegObservedColor,
  LoudnormMeasurement,
  ProbeMediaResult
} from "./index.js";
import { summarizeFfmpegDiagnostic } from "./ffmpeg-process-control.js";

export function resolveFinalAudioInputs(input: {
  audioTracks?: FfmpegAudioInput[];
  audio?: FfmpegAudioInput;
  audioPath?: string;
}): FfmpegAudioInput[] {
  if (input.audioTracks && input.audioTracks.length > 0) return input.audioTracks;
  if (input.audio) return [input.audio];
  return input.audioPath ? [{ path: input.audioPath }] : [];
}

export async function collectFinalRenderInputHashes(
  frameSequenceHash: string,
  audioInputs: FfmpegAudioInput[]
): Promise<Record<string, string>> {
  const hashes = new Map<string, string>();
  hashes.set("frames", frameSequenceHash);
  for (const [index, audio] of audioInputs.entries()) {
    hashes.set(`audio:${index}`, audio.snapshotSha256 ?? await hashFile(audio.path));
  }
  return Object.fromEntries([...hashes.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function finalReceiptAudioOutput(
  audioInputs: FfmpegAudioInput[],
  codec: string,
  loudness?: RenderLoudnessSummary,
  master?: RenderAudioMasterEvidence
): {
  path?: string;
  codec: string;
  mix?: "amix";
  loudness?: RenderLoudnessSummary;
  master?: RenderAudioMasterEvidence;
  tracks?: ReturnType<typeof finalReceiptAudioTrack>[];
  startMs?: number;
  durationMs?: number;
  trimStartMs?: number;
  trimDurationMs?: number;
  loop?: boolean;
  volume?: number;
  muted?: boolean;
  pan?: number;
  fadeInMs?: number;
  fadeOutMs?: number;
  fadeCurve?: "linear" | "equal-power";
  normalizeLoudness?: boolean;
  playbackRate?: number;
  ducking?: MotionAudioDucking;
  volumeKeyframes?: MotionKeyframe[];
  panKeyframes?: MotionKeyframe[];
} {
  if (audioInputs.length > 1) {
    return {
      codec: finalReceiptAudioCodec(codec),
      mix: "amix",
      ...(loudness ? { loudness } : {}),
      ...(master ? { master } : {}),
      tracks: audioInputs.map(finalReceiptAudioTrack)
    };
  }
  const audio = audioInputs[0];
  return {
    path: audio.receiptPath ?? audio.path,
    codec: finalReceiptAudioCodec(codec),
    ...(loudness ? { loudness } : {}),
    ...(master ? { master } : {}),
    ...finalReceiptAudioFields(audio)
  };
}

function finalReceiptAudioCodec(codec: string): string {
  return codec.startsWith("lib") ? codec.slice(3) : codec;
}

function finalReceiptAudioTrack(audio: FfmpegAudioInput): {
  path: string;
  startMs?: number;
  durationMs?: number;
  trimStartMs?: number;
  trimDurationMs?: number;
  loop?: boolean;
  volume?: number;
  muted?: boolean;
  pan?: number;
  fadeInMs?: number;
  fadeOutMs?: number;
  fadeCurve?: "linear" | "equal-power";
  normalizeLoudness?: boolean;
  playbackRate?: number;
  ducking?: MotionAudioDucking;
  volumeKeyframes?: MotionKeyframe[];
  panKeyframes?: MotionKeyframe[];
} {
  return { path: audio.receiptPath ?? audio.path, ...finalReceiptAudioFields(audio) };
}

function finalReceiptAudioFields(audio: FfmpegAudioInput): Omit<ReturnType<typeof finalReceiptAudioTrack>, "path"> {
  return {
    ...(audio.startMs !== undefined ? { startMs: audio.startMs } : {}),
    ...(audio.durationMs !== undefined ? { durationMs: audio.durationMs } : {}),
    ...(audio.trimStartMs !== undefined ? { trimStartMs: audio.trimStartMs } : {}),
    ...(audio.trimDurationMs !== undefined ? { trimDurationMs: audio.trimDurationMs } : {}),
    ...(audio.loop !== undefined ? { loop: audio.loop } : {}),
    ...(audio.volume !== undefined ? { volume: audio.volume } : {}),
    ...(audio.pan !== undefined ? { pan: audio.pan } : {}),
    ...(audio.muted !== undefined ? { muted: audio.muted } : {}),
    ...(audio.fadeInMs !== undefined ? { fadeInMs: audio.fadeInMs } : {}),
    ...(audio.fadeOutMs !== undefined ? { fadeOutMs: audio.fadeOutMs } : {}),
    ...(audio.fadeCurve !== undefined ? { fadeCurve: audio.fadeCurve } : {}),
    ...(audio.normalizeLoudness !== undefined ? { normalizeLoudness: audio.normalizeLoudness } : {}),
    ...(audio.playbackRate !== undefined ? { playbackRate: audio.playbackRate } : {}),
    ...(audio.ducking !== undefined ? { ducking: audio.ducking } : {}),
    ...(audio.volumeKeyframes !== undefined ? { volumeKeyframes: audio.volumeKeyframes } : {}),
    ...(audio.panKeyframes !== undefined ? { panKeyframes: audio.panKeyframes } : {})
  };
}

interface FinalLoudnessMeasurementResult {
  inputs: FfmpegAudioInput[];
  tracks: RenderLoudnessTrack[];
}

export async function measureFinalLoudnessInputs(
  audioInputs: FfmpegAudioInput[],
  options: {
    measure(path: string): Promise<AudioLevelResult>;
  }
): Promise<FinalLoudnessMeasurementResult> {
  const inputs: FfmpegAudioInput[] = [];
  const tracks: RenderLoudnessTrack[] = [];
  for (const audio of audioInputs) {
    if (!audio.normalizeLoudness) {
      inputs.push(audio);
      continue;
    }
    let measured: LoudnormMeasurement | undefined;
    let note: string | undefined;
    try {
      const level = await options.measure(audio.path);
      if (hasFiniteLoudnessMeasurement(level)) {
        measured = {
          integratedLufs: level.integratedLoudnessLufs as number,
          truePeakDbtp: level.truePeakDbtp as number,
          lra: level.loudnessRangeLu as number,
          thresholdLufs: level.loudnessThresholdLufs as number,
          offsetLu: level.targetOffsetLu as number
        };
      } else {
        note = "Loudness measurement incomplete; applied single-pass loudnorm.";
      }
    } catch (error) {
      const diagnostic = summarizeFfmpegDiagnostic(error instanceof Error ? error.message : String(error))
        || "measurement did not provide a diagnostic";
      note = `Loudness measurement failed (${diagnostic}); applied single-pass loudnorm.`;
    }
    inputs.push(measured ? { ...audio, loudnormMeasured: measured } : audio);
    tracks.push({
      path: audio.receiptPath ?? audio.path,
      ...(audio.layerId ? { layerId: audio.layerId } : {}),
      integratedLufs: measured?.integratedLufs ?? null,
      truePeakDbtp: measured?.truePeakDbtp ?? null,
      lra: measured?.lra ?? null,
      thresholdLufs: measured?.thresholdLufs ?? null,
      offsetLu: measured?.offsetLu ?? null,
      mode: measured ? "two-pass" : "single-pass-fallback",
      ...(note ? { note } : {})
    });
  }
  return { inputs, tracks };
}

export async function measureFinalProgramLoudness(
  outputPath: string,
  options: { measure(path: string): Promise<AudioLevelResult> }
): Promise<RenderLoudnessSummary["output"]> {
  try {
    const level = await options.measure(outputPath);
    return {
      integratedLufs: level.integratedLoudnessLufs,
      truePeakDbtp: level.truePeakDbtp,
      lra: level.loudnessRangeLu
    };
  } catch {
    return null;
  }
}

export function buildFinalLoudnessSummary(
  tracks: RenderLoudnessTrack[],
  output: RenderLoudnessSummary["output"]
): RenderLoudnessSummary {
  const allTwoPass = tracks.every((track) => track.mode === "two-pass");
  const allFallback = tracks.every((track) => track.mode === "single-pass-fallback");
  return {
    measurement: "ebu-r128",
    target: { integratedLufs: -16, truePeakDbtp: -1.5, lra: 11 },
    mode: allTwoPass ? "two-pass" : allFallback ? "single-pass-fallback" : "mixed",
    tracks,
    output
  };
}

export async function gradeFinalDeliveredColor(
  path: string,
  preset: FfmpegExportPresetSpec,
  options: { probe(path: string): Promise<ProbeMediaResult> }
): Promise<{ observed: FfmpegObservedColor; warning?: string } | null> {
  const declared = preset.color;
  if (!declared) return null;
  let probed: ProbeMediaResult;
  try {
    probed = await options.probe(path);
  } catch {
    return null;
  }
  const observed: FfmpegObservedColor = {
    primaries: probed.color.primaries,
    transfer: probed.color.transfer,
    matrix: probed.color.space,
    range: probed.color.range
  };
  const notSignaled = new Set(preset.colorTagsNotSignaled ?? []);
  const missing: FfmpegColorTag[] = [];
  const mismatched: string[] = [];
  for (const tag of ["primaries", "transfer", "matrix", "range"] as const) {
    if (notSignaled.has(tag)) continue;
    const actual = observed[tag];
    if (actual === null) missing.push(tag);
    else if (actual !== declared[tag]) mismatched.push(`${tag} is ${actual}, declared ${declared[tag]}`);
  }
  if (missing.length === 0 && mismatched.length === 0) return { observed };
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`missing ${missing.join(", ")}`);
  if (mismatched.length > 0) parts.push(mismatched.join("; "));
  return {
    observed,
    warning: `Delivered ${preset.preset} colour does not match the ${declared.profile} profile the preset declares: `
      + `${parts.join("; ")}. The delivered file is what a player sees; output.color.observed records it. `
      + "This is usually an FFmpeg build that does not carry every colour tag through to this container."
  };
}

function hasFiniteLoudnessMeasurement(level: AudioLevelResult): boolean {
  return [level.integratedLoudnessLufs, level.truePeakDbtp, level.loudnessRangeLu, level.loudnessThresholdLufs, level.targetOffsetLu]
    .every((value) => typeof value === "number" && Number.isFinite(value));
}
