/** Parsing for the object and shorthand forms accepted by timeline.track.create. */
import type { MotionTrack } from "@shellx-motion/core";
import { booleanArg, objectArg, recordArg, stringArg, stringArrayArg } from "./args.js";

export function timelineTrackCreateArg(
  args: unknown,
  values: { order?: number; volume?: number; pan?: number; fadeInMs?: number; fadeOutMs?: number }
): MotionTrack | null {
  const trackRecord = recordArg(args, "track");
  const source: Record<string, unknown> = trackRecord ? structuredClone(trackRecord) : {};
  const trackId = stringArg(args, "trackId") ?? stringArg(args, "track");
  const type = stringArg(args, "type");
  const name = stringArg(args, "name");
  const layerIds = stringArrayArg(args, "layerIds") ?? stringArrayArg(args, "layers");
  const locked = booleanArg(args, "locked");
  const muted = booleanArg(args, "muted");
  const solo = booleanArg(args, "solo");
  if (trackId) source.id = trackId;
  if (type) source.type = type;
  if (name !== null) source.name = name;
  if (layerIds) source.layerIds = layerIds;
  if (values.order !== undefined) source.order = values.order;
  if (locked !== null) source.locked = locked;
  if (muted !== null) source.muted = muted;
  if (solo !== null) source.solo = solo;
  if (values.volume !== undefined) source.volume = values.volume;
  if (values.pan !== undefined) source.pan = values.pan;
  if (values.fadeInMs !== undefined) source.fadeInMs = values.fadeInMs;
  if (values.fadeOutMs !== undefined) source.fadeOutMs = values.fadeOutMs;

  const id = nonEmptyString(source, "id");
  const trackType = nonEmptyString(source, "type");
  if (!id || !trackType) return null;
  const track: MotionTrack = { id, type: trackType };
  copyString(source, track, "name");
  const sourceLayerIds = stringArray(source.layerIds);
  if (sourceLayerIds) track.layerIds = sourceLayerIds;
  copyNumber(source, track, "order");
  copyNumber(source, track, "volume");
  copyNumber(source, track, "pan");
  copyNumber(source, track, "fadeInMs");
  copyNumber(source, track, "fadeOutMs");
  copyBoolean(source, track, "locked");
  copyBoolean(source, track, "muted");
  copyBoolean(source, track, "solo");
  return track;
}

function nonEmptyString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? [...value] : null;
}

function copyString(source: Record<string, unknown>, track: MotionTrack, key: "name"): void {
  if (typeof source[key] === "string") track[key] = source[key];
}

function copyNumber(source: Record<string, unknown>, track: MotionTrack, key: "order" | "volume" | "pan" | "fadeInMs" | "fadeOutMs"): void {
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value)) track[key] = value;
}

function copyBoolean(source: Record<string, unknown>, track: MotionTrack, key: "locked" | "muted" | "solo"): void {
  if (typeof source[key] === "boolean") track[key] = source[key];
}
