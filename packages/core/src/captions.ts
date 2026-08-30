import { compareCodeUnits } from "./canonical-json";
import { MAX_CAPTION_LAYER_PREFIX_LENGTH, normalizeCaptionIdentifier } from "./caption-identifiers";
import type { MotionDocument, MotionLayer, MotionTrack } from "./types";

export type CaptionSourceFormat = "srt" | "vtt" | "plain";

export interface CaptionCue {
  id: string;
  startMs: number;
  durationMs: number;
  text: string;
}

export interface CaptionParseOptions {
  format?: CaptionSourceFormat;
  defaultCueDurationMs?: number;
  gapMs?: number;
}

export interface TimelineCaptionUpsertInput {
  id: string;
  text: string;
  startMs: number;
  durationMs: number;
  trackId?: string;
  trackName?: string;
  transform?: Record<string, unknown>;
  style?: Record<string, unknown>;
  sourceCueId?: string;
}

export interface TimelineCaptionUpsertResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "inserted" | "replaced";
  layer: MotionLayer;
  previousLayer?: MotionLayer;
  trackId: string;
  trackCreated: boolean;
  track: MotionTrack;
}

export interface TimelineCaptionImportInput extends CaptionParseOptions {
  source: string;
  trackId?: string;
  trackName?: string;
  layerPrefix?: string;
  transform?: Record<string, unknown>;
  style?: Record<string, unknown>;
}

export interface TimelineCaptionImportResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "imported";
  format: CaptionSourceFormat;
  cueCount: number;
  insertedLayerIds: string[];
  replacedLayerIds: string[];
  trackId: string;
  trackCreated: boolean;
  track: MotionTrack;
  cues: CaptionCue[];
}

const DEFAULT_TRACK_ID = "captions";
const DEFAULT_TRACK_NAME = "Captions";
const DEFAULT_LAYER_PREFIX = "caption";

export function parseCaptionCues(source: string, options: CaptionParseOptions = {}): CaptionCue[] {
  const format = options.format ?? inferCaptionFormat(source);
  if (format === "plain") return parsePlainCaptions(source, options);
  return parseTimedCaptions(source, format);
}

export function importTimelineCaptions(motion: MotionDocument, input: TimelineCaptionImportInput): TimelineCaptionImportResult {
  const format = input.format ?? inferCaptionFormat(input.source);
  const cues = parseCaptionCues(input.source, { ...input, format });
  if (cues.length === 0) throw new Error("Caption source did not contain any cues.");

  let nextMotion = motion;
  const changedPaths: string[] = [];
  const insertedLayerIds: string[] = [];
  const replacedLayerIds: string[] = [];
  let trackCreated = false;
  let track: MotionTrack | undefined;
  const trackId = input.trackId ?? DEFAULT_TRACK_ID;
  const layerPrefix = normalizeCaptionIdentifier(input.layerPrefix ?? DEFAULT_LAYER_PREFIX, {
    label: "Caption layerPrefix",
    maxLength: MAX_CAPTION_LAYER_PREFIX_LENGTH,
  });

  cues.forEach((cue, index) => {
    const upsert = upsertTimelineCaption(nextMotion, {
      id: `${layerPrefix}_${String(index + 1).padStart(4, "0")}`,
      text: cue.text,
      startMs: cue.startMs,
      durationMs: cue.durationMs,
      trackId,
      trackName: input.trackName ?? DEFAULT_TRACK_NAME,
      transform: input.transform ?? defaultCaptionTransform(nextMotion),
      style: input.style ?? defaultCaptionStyle(nextMotion),
      sourceCueId: cue.id
    });
    nextMotion = upsert.motion;
    trackCreated ||= upsert.trackCreated;
    track = upsert.track;
    changedPaths.push(...upsert.changedPaths.filter((path) => !changedPaths.includes(path)));
    if (upsert.action === "inserted") {
      insertedLayerIds.push(upsert.layer.id);
    } else {
      replacedLayerIds.push(upsert.layer.id);
    }
  });

  return {
    motion: nextMotion,
    changedPaths,
    action: "imported",
    format,
    cueCount: cues.length,
    insertedLayerIds,
    replacedLayerIds,
    trackId,
    trackCreated,
    track: track ?? requireCaptionTrack(nextMotion, trackId),
    cues
  };
}

export function upsertTimelineCaption(motion: MotionDocument, input: TimelineCaptionUpsertInput): TimelineCaptionUpsertResult {
  validateCaptionInput(input);
  const trackId = input.trackId ?? DEFAULT_TRACK_ID;
  const layerIndex = motion.layers.findIndex((layer) => layer.id === input.id);
  const previousLayer = layerIndex === -1 ? undefined : motion.layers[layerIndex];
  if (previousLayer && previousLayer.type !== "caption") {
    throw new Error(`Caption layer id collides with non-caption layer: ${input.id}.`);
  }
  assertCaptionTracksEditable(motion, input.id, trackId);
  if (previousLayer?.locked === true) {
    throw new Error(`Cannot edit locked layer: ${previousLayer.id}.`);
  }

  const preparedTrack = ensureCaptionTrack(motion, trackId, input.trackName ?? DEFAULT_TRACK_NAME);
  const captionLayer: MotionLayer = {
    id: input.id,
    type: "caption",
    text: input.text,
    trackId,
    startMs: input.startMs,
    durationMs: input.durationMs,
    ...(input.transform ? { transform: { ...input.transform } } : { transform: defaultCaptionTransform(motion) }),
    ...(input.style ? { style: { ...input.style } } : { style: defaultCaptionStyle(motion) }),
    ...(input.sourceCueId ? { sourceCueId: input.sourceCueId } : {})
  };
  const nextLayers = layerIndex === -1
    ? [...motion.layers, captionLayer]
    : motion.layers.map((layer, index) => index === layerIndex ? captionLayer : { ...layer });
  const trackRefChanged = new Set<string>();
  const tracksWithoutCaption = preparedTrack.tracks.map((track) => {
    const layerIds = track.layerIds ?? [];
    if (!layerIds.includes(input.id)) return track;
    trackRefChanged.add(track.id);
    return { ...track, layerIds: without(layerIds, input.id) };
  });
  const targetTrack = tracksWithoutCaption.find((track) => track.id === trackId) ?? preparedTrack.track;
  const targetLayerIds = [...(targetTrack.layerIds ?? []), input.id];
  const nextTargetTrack = {
    ...targetTrack,
    layerIds: sortLayerIdsByTime(targetLayerIds, nextLayers)
  };
  trackRefChanged.add(trackId);
  const nextTracks = tracksWithoutCaption.map((track) => track.id === trackId ? nextTargetTrack : track);
  const nextMotion: MotionDocument = {
    ...motion,
    tracks: nextTracks,
    layers: nextLayers
  };
  const nextDurationMs = Math.max(motion.durationMs, ...nextLayers.map((layer) => layer.startMs + layer.durationMs));
  const changedPaths = [`/layers/${input.id}`];
  if (preparedTrack.created) changedPaths.push(`/tracks/${trackId}`);
  for (const changedTrackId of trackRefChanged) changedPaths.push(`/tracks/${changedTrackId}/layerIds`);
  if (nextDurationMs !== motion.durationMs) {
    nextMotion.durationMs = nextDurationMs;
    changedPaths.push("/durationMs");
  }

  return {
    motion: nextMotion,
    changedPaths: [...new Set(changedPaths)],
    action: previousLayer ? "replaced" : "inserted",
    layer: captionLayer,
    ...(previousLayer ? { previousLayer } : {}),
    trackId,
    trackCreated: preparedTrack.created,
    track: nextTargetTrack
  };
}

function parseTimedCaptions(source: string, format: CaptionSourceFormat): CaptionCue[] {
  const normalized = source.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  const blocks = normalized.split(/\n{2,}/g);
  const cues: CaptionCue[] = [];

  for (const block of blocks) {
    let lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    if (format === "vtt" && lines[0].toUpperCase().startsWith("WEBVTT")) {
      lines = lines.slice(1);
      if (lines.length === 0) continue;
    }
    if (format === "vtt" && lines[0].startsWith("NOTE")) continue;

    let cueId: string | undefined;
    let timeLineIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeLineIndex === -1) continue;
    if (timeLineIndex > 0 && !/^\d+$/.test(lines[timeLineIndex - 1])) {
      cueId = lines[timeLineIndex - 1];
    }

    const match = lines[timeLineIndex].match(/^(.+?)\s+-->\s+(.+?)(?:\s+.+)?$/);
    if (!match) continue;
    const startMs = parseCaptionTimestamp(match[1]);
    const endMs = parseCaptionTimestamp(match[2]);
    if (endMs <= startMs) throw new Error("Caption cue end time must be after start time.");
    const text = lines.slice(timeLineIndex + 1).join("\n").trim();
    if (!text) continue;
    cues.push({
      id: cueId ? normalizeCaptionIdentifier(cueId, { label: "Caption cue id" }) : `cue_${String(cues.length + 1).padStart(4, "0")}`,
      startMs,
      durationMs: endMs - startMs,
      text
    });
  }

  return cues;
}

function parsePlainCaptions(source: string, options: CaptionParseOptions): CaptionCue[] {
  const durationMs = options.defaultCueDurationMs ?? 2000;
  const gapMs = options.gapMs ?? 0;
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("Plain caption duration must be positive.");
  if (!Number.isFinite(gapMs) || gapMs < 0) throw new Error("Plain caption gap must be non-negative.");
  return source.replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((text, index) => ({
      id: `cue_${String(index + 1).padStart(4, "0")}`,
      startMs: index * (durationMs + gapMs),
      durationMs,
      text
    }));
}

function parseCaptionTimestamp(value: string): number {
  const normalized = value.trim().replace(",", ".");
  const parts = normalized.split(":");
  if (parts.length < 2 || parts.length > 3) throw new Error(`Invalid caption timestamp: ${value}`);
  const secondsPart = parts.pop() ?? "";
  const minutesPart = parts.pop() ?? "";
  const hoursPart = parts.pop() ?? "0";
  const seconds = Number(secondsPart);
  const minutes = Number(minutesPart);
  const hours = Number(hoursPart);
  if (![hours, minutes, seconds].every(Number.isFinite)) throw new Error(`Invalid caption timestamp: ${value}`);
  return Math.round(((hours * 60 * 60) + (minutes * 60) + seconds) * 1000);
}

function inferCaptionFormat(source: string): CaptionSourceFormat {
  const trimmed = source.trimStart();
  if (trimmed.toUpperCase().startsWith("WEBVTT")) return "vtt";
  if (trimmed.includes("-->")) return "srt";
  return "plain";
}

function validateCaptionInput(input: TimelineCaptionUpsertInput): void {
  if (!input.id.trim()) throw new Error("Caption id is required.");
  if (!input.text.trim()) throw new Error("Caption text is required.");
  if (!Number.isFinite(input.startMs) || input.startMs < 0) throw new Error("Caption startMs must be a non-negative finite number.");
  if (!Number.isFinite(input.durationMs) || input.durationMs <= 0) throw new Error("Caption durationMs must be a positive finite number.");
}

function ensureCaptionTrack(motion: MotionDocument, trackId: string, trackName: string): { tracks: MotionTrack[]; track: MotionTrack; created: boolean } {
  const tracks = (motion.tracks ?? []).map((track) => ({ ...track, ...(track.layerIds ? { layerIds: [...track.layerIds] } : {}) }));
  const existingIndex = tracks.findIndex((track) => track.id === trackId);
  if (existingIndex !== -1) {
    if (tracks[existingIndex].type !== "caption") throw new Error(`Track ${trackId} is not a caption track.`);
    return { tracks, track: { ...tracks[existingIndex], layerIds: [...(tracks[existingIndex].layerIds ?? [])] }, created: false };
  }
  const nextOrder = Math.max(0, ...tracks.map((track) => typeof track.order === "number" ? track.order : 0)) + 1;
  const track: MotionTrack = { id: trackId, type: "caption", name: trackName, order: nextOrder, layerIds: [] };
  tracks.push(track);
  return { tracks, track, created: true };
}

function requireCaptionTrack(motion: MotionDocument, trackId: string): MotionTrack {
  const track = motion.tracks?.find((candidate) => candidate.id === trackId);
  if (!track) throw new Error(`Motion track not found: ${trackId}.`);
  return track;
}

function assertCaptionTracksEditable(motion: MotionDocument, layerId: string, targetTrackId: string): void {
  const tracks = motion.tracks ?? [];
  const target = tracks.find((track) => track.id === targetTrackId);
  if (target && target.type !== "caption") throw new Error(`Track ${targetTrackId} is not a caption track.`);
  if (target?.locked) throw new Error(`Target caption track is locked: ${targetTrackId}.`);
  for (const track of tracks) {
    if (track.layerIds?.includes(layerId) && track.locked) throw new Error(`Source caption track is locked: ${track.id}.`);
  }
}

function sortLayerIdsByTime(layerIds: string[], layers: MotionLayer[]): string[] {
  const layerById = new Map(layers.map((layer) => [layer.id, layer]));
  return [...new Set(layerIds)].sort((left, right) => {
    const leftLayer = layerById.get(left);
    const rightLayer = layerById.get(right);
    // Code-unit order, not localeCompare: the returned order becomes track.layerIds in
    // motion.json, so a locale-dependent tie-break between cues that share a start time rewrites
    // the document bytes and every hash taken over them.
    return (leftLayer?.startMs ?? 0) - (rightLayer?.startMs ?? 0) || compareCodeUnits(left, right);
  });
}

function without(values: string[], value: string): string[] {
  return values.filter((candidate) => candidate !== value);
}

function defaultCaptionTransform(motion: MotionDocument): Record<string, unknown> {
  return {
    x: Math.round(motion.width * 0.1),
    y: Math.round(motion.height * 0.78),
    width: Math.round(motion.width * 0.8),
    height: Math.round(motion.height * 0.16)
  };
}

function defaultCaptionStyle(motion: MotionDocument): Record<string, unknown> {
  return {
    color: "#ffffff",
    fontSize: Math.max(18, Math.round(motion.height * 0.06)),
    textAlign: "center"
  };
}
