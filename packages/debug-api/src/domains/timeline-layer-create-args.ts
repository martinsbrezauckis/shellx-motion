/** Strict parsing for the rich layer payload accepted by timeline.layer.create. */
import { isDeepStrictEqual } from "node:util";
import {
  assertMotionPathRevealLayer, parseMotionPathViewBox, readGpuSceneStrokeDash, readMotionTextRuns, resolveMotionShapeGeometry, validateMotionPathData,
  type MotionLayer
} from "@shellx-motion/core";
import { objectArg, positiveNumberArg, recordArg, stringArg } from "./args.js";
import { timelineEffectsArg, timelineGradientArg } from "./timeline-layer-create-effects-arg.js";
import { timelinePointCloudArg } from "./timeline-point-cloud-arg.js";
import { optionalFiniteNumber, timelineParticleEmitterArg } from "./timeline-particle-emitter-arg.js";
import {
  allowedOriginsValue, blendModeValue, cropValue, duckingValue, environmentValue,
  keyframesValue, maskValue, transformValue, transitionsValue
} from "./timeline-layer-create-rich-values.js";

const REPRESENTABLE_LAYER_FIELDS = new Set([
  "id", "name", "type", "trackId", "startMs", "durationMs", "text", "textRuns", "shape", "geometry", "fill", "color",
  "width", "height", "opacity", "visible", "locked", "source", "src", "assetId", "assetRef",
  "trimStartMs", "trimDurationMs", "loop", "playbackRate", "includeAudio", "volume", "pan", "muted",
  "fadeInMs", "fadeOutMs", "fadeCurve", "normalizeLoudness", "ducking", "fit", "crop", "allowedOrigins",
  "transform", "style", "label", "keyframes", "transitions", "mask", "effects", "gradient", "environment",
  "pointCloud", "emitter", "blendMode", "pathReveal", "x-path", "x-path-viewBox", "x-path-fillRule"
]);

const DEFERRED_LAYER_FIELD_PROBLEMS: Record<string, string> = {
  childLayerIds: "layer.childLayerIds is owned by the active group authoring lane and is not admitted until its typed parser lands.",
  scene3d: "layer.scene3d is owned by the active scene3d authoring lane and is not admitted until its typed parser lands.",
  depth: "layer.depth is owned by the active depth authoring lane and is not admitted until its typed parser lands.",
  textFit: "layer.textFit is not yet admitted by motion.timeline.layer.create; it is refused before mutation rather than dropped.",
  keying: "layer.keying is not admitted by motion.timeline.layer.create; create the layer first, then use the existing keying authoring operations.",
  matte: "layer.matte is not yet admitted by motion.timeline.layer.create; it is refused before mutation rather than dropped.",
  effectModule: "layer.effectModule is not yet admitted by motion.timeline.layer.create; it is refused before mutation rather than dropped.",
  shader: "layer.shader is not yet admitted by motion.timeline.layer.create; it is refused before mutation rather than dropped."
};

export type TimelineLayerCreateParseResult =
  | { ok: true; layer: MotionLayer }
  | { ok: false; problem: string };

/**
 * Parses a create payload without allowing the historical projection to silently
 * replace it with a different layer. The nullable wrapper below remains for
 * existing callers until the structural dispatcher can surface `problem`.
 */
export function readTimelineLayerCreateArg(
  args: unknown,
  timing: { startMs?: number; durationMs?: number }
): TimelineLayerCreateParseResult {
  const source = layerCreateSource(args, timing);
  const fieldProblem = layerCreateFieldProblem(source);
  if (fieldProblem) return { ok: false, problem: fieldProblem };
  const textRunsProblem = layerCreateTextRunsProblem(source);
  if (textRunsProblem) return { ok: false, problem: textRunsProblem };
  const geometryProblem = layerCreateGeometryProblem(source);
  if (geometryProblem) return { ok: false, problem: geometryProblem };
  const dashProblem = layerCreateDashProblem(source);
  if (dashProblem) return { ok: false, problem: dashProblem };

  const layer = parseTimelineLayerCreateArg(args, timing);
  if (!layer) return { ok: false, problem: "layer contains an invalid value for the typed layer-create contract." };

  const lostField = firstLossyLayerField(source, layer);
  if (lostField) {
    return {
      ok: false,
      problem: `layer.${lostField} cannot be represented losslessly by motion.timeline.layer.create and is refused before mutation.`
    };
  }
  return { ok: true, layer };
}

/** Compatibility wrapper for callers that have not yet adopted the detailed parse result. */
export function timelineLayerCreateArg(
  args: unknown,
  timing: { startMs?: number; durationMs?: number }
): MotionLayer | null {
  const parsed = readTimelineLayerCreateArg(args, timing);
  return parsed.ok ? parsed.layer : null;
}

function parseTimelineLayerCreateArg(
  args: unknown,
  timing: { startMs?: number; durationMs?: number }
): MotionLayer | null {
  const source = layerCreateSource(args, timing);
  const layerId = stringArg(args, "layerId") ?? stringArg(args, "layer");
  const type = stringArg(args, "type");
  const trackId = stringArg(args, "trackId") ?? stringArg(args, "track");
  const text = stringArg(args, "text");
  const shape = stringArg(args, "shape");
  const fill = stringArg(args, "fill");
  const mediaSource = stringArg(args, "source");
  const src = stringArg(args, "src");
  const assetId = stringArg(args, "assetId");
  const assetRef = stringArg(args, "assetRef");
  const color = stringArg(args, "color");
  const fontSize = positiveNumberArg(args, "fontSize");
  const width = positiveNumberArg(args, "width");
  const height = positiveNumberArg(args, "height");
  if (fontSize === false || width === false || height === false) return null;

  if (layerId) source.id = layerId;
  if (type) source.type = type;
  if (trackId) source.trackId = trackId;
  if (timing.startMs !== undefined) source.startMs = timing.startMs;
  if (timing.durationMs !== undefined) source.durationMs = timing.durationMs;
  if (text !== null) source.text = text;
  if (shape !== null) source.shape = shape;
  if (fill !== null) source.fill = fill;
  if (mediaSource !== null) source.source = mediaSource;
  if (src !== null) source.src = src;
  if (assetId !== null) source.assetId = assetId;
  if (assetRef !== null) source.assetRef = assetRef;
  if (width !== null) source.width = width;
  if (height !== null) source.height = height;
  if (color !== null || fontSize !== null) {
    source.style = {
      ...(objectArg(source.style) ?? {}),
      ...(color !== null ? { color } : {}),
      ...(fontSize !== null ? { fontSize } : {})
    };
  }

  const id = nonEmptyString(source, "id");
  const layerType = nonEmptyString(source, "type");
  const startMs = finiteNumber(source, "startMs");
  const durationMs = finiteNumber(source, "durationMs");
  if (!id || !layerType || startMs === null || durationMs === null) return null;

  const layer: MotionLayer = { id, type: layerType, startMs, durationMs };
  copyString(source, layer, "name");
  copyString(source, layer, "trackId");
  copyString(source, layer, "text");
  if (Object.hasOwn(source, "textRuns")) {
    try { layer.textRuns = readMotionTextRuns(source.textRuns, "layer.textRuns"); }
    catch { return null; }
  }
  copyString(source, layer, "shape");
  copyString(source, layer, "fill");
  copyString(source, layer, "color");
  copyString(source, layer, "source");
  copyString(source, layer, "src");
  copyString(source, layer, "assetId");
  copyString(source, layer, "assetRef");
  copyString(source, layer, "fit");
  copyNumber(source, layer, "width");
  copyNumber(source, layer, "height");
  copyNumber(source, layer, "opacity");
  copyNumber(source, layer, "trimStartMs");
  copyNumber(source, layer, "trimDurationMs");
  copyNumber(source, layer, "playbackRate");
  copyNumber(source, layer, "volume");
  copyNumber(source, layer, "pan");
  copyNumber(source, layer, "fadeInMs");
  copyNumber(source, layer, "fadeOutMs");
  copyBoolean(source, layer, "visible");
  copyBoolean(source, layer, "locked");
  copyBoolean(source, layer, "loop");
  copyBoolean(source, layer, "includeAudio");
  copyBoolean(source, layer, "muted");
  copyBoolean(source, layer, "normalizeLoudness");

  if (Object.hasOwn(source, "geometry")) {
    layer.geometry = structuredClone(source.geometry) as NonNullable<MotionLayer["geometry"]>;
    const geometry = resolveMotionShapeGeometry(layer);
    if (!geometry.ok || geometry.geometry.source !== "v1") return null;
  }

  const style = objectArg(source.style);
  if (style) layer.style = style;
  const label = objectArg(source.label);
  if (label) layer.label = label;
  const ducking = duckingValue(source.ducking);
  if (ducking === false) return null;
  if (ducking) layer.ducking = ducking;
  const crop = cropValue(source.crop);
  if (crop === false) return null;
  if (crop) layer.crop = crop;
  const allowedOrigins = allowedOriginsValue(source.allowedOrigins);
  if (allowedOrigins === false) return null;
  if (allowedOrigins) layer.allowedOrigins = allowedOrigins;
  const transform = transformValue(source.transform);
  if (transform === false) return null;
  if (transform) layer.transform = transform;
  const keyframes = keyframesValue(source.keyframes);
  if (keyframes === false) return null;
  if (keyframes) layer.keyframes = keyframes;
  const transitions = transitionsValue(source.transitions);
  if (transitions === false) return null;
  if (transitions) layer.transitions = transitions;
  const mask = maskValue(source.mask);
  if (mask === false) return null;
  if (mask) layer.mask = mask;
  const gradient = timelineGradientArg(source.gradient);
  if (gradient === false) return null;
  if (gradient) layer.gradient = gradient;
  const effects = timelineEffectsArg(source.effects);
  if (effects === false) return null;
  if (effects) layer.effects = effects;
  const environment = environmentValue(source.environment);
  if (environment === false) return null;
  if (environment) layer.environment = environment;
  const pointCloud = timelinePointCloudArg(source);
  if (pointCloud === false) return null;
  if (pointCloud) layer.pointCloud = pointCloud;
  const emitter = timelineParticleEmitterArg(source.emitter);
  if (emitter === false) return null;
  if (emitter) layer.emitter = emitter;
  const blendMode = blendModeValue(source.blendMode);
  if (blendMode === false) return null;
  if (blendMode) layer.blendMode = blendMode;
  const fadeCurve = fadeCurveValue(source.fadeCurve);
  if (fadeCurve === false) return null;
  if (fadeCurve) layer.fadeCurve = fadeCurve;
  const pathExtensions = pathExtensionValues(source);
  if (pathExtensions === false) return null;
  if (pathExtensions) Object.assign(layer, pathExtensions);
  const pathReveal = pathRevealValue(source.pathReveal);
  if (pathReveal === false) return null;
  if (pathReveal) {
    layer.pathReveal = pathReveal;
    try {
      assertMotionPathRevealLayer(layer, `motion.timeline.layer.create layer ${layer.id}`);
    } catch {
      return null;
    }
  }
  return layer;
}

function nonEmptyString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function finiteNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? [...value] : null;
}

function copyString<K extends keyof MotionLayer>(source: Record<string, unknown>, layer: MotionLayer, key: K): void {
  const value = source[key as string];
  if (typeof value === "string") (layer as unknown as Record<string, unknown>)[key as string] = value;
}

function copyNumber<K extends keyof MotionLayer>(source: Record<string, unknown>, layer: MotionLayer, key: K): void {
  const value = source[key as string];
  if (typeof value === "number" && Number.isFinite(value)) (layer as unknown as Record<string, unknown>)[key as string] = value;
}

function copyBoolean<K extends keyof MotionLayer>(source: Record<string, unknown>, layer: MotionLayer, key: K): void {
  const value = source[key as string];
  if (typeof value === "boolean") (layer as unknown as Record<string, unknown>)[key as string] = value;
}

/** Applies the established shorthand form before the lossless-field guard compares values. */
function layerCreateSource(
  args: unknown,
  timing: { startMs?: number; durationMs?: number }
): Record<string, unknown> {
  const layerRecord = recordArg(args, "layer");
  const source: Record<string, unknown> = layerRecord ? structuredClone(layerRecord) : {};
  const layerId = stringArg(args, "layerId") ?? stringArg(args, "layer");
  const type = stringArg(args, "type");
  const trackId = stringArg(args, "trackId") ?? stringArg(args, "track");
  const text = stringArg(args, "text");
  const shape = stringArg(args, "shape");
  const fill = stringArg(args, "fill");
  const mediaSource = stringArg(args, "source");
  const src = stringArg(args, "src");
  const assetId = stringArg(args, "assetId");
  const assetRef = stringArg(args, "assetRef");
  const color = stringArg(args, "color");
  const fontSize = positiveNumberArg(args, "fontSize");
  const width = positiveNumberArg(args, "width");
  const height = positiveNumberArg(args, "height");

  if (layerId) source.id = layerId;
  if (type) source.type = type;
  if (trackId) source.trackId = trackId;
  if (timing.startMs !== undefined) source.startMs = timing.startMs;
  if (timing.durationMs !== undefined) source.durationMs = timing.durationMs;
  if (text !== null) source.text = text;
  if (shape !== null) source.shape = shape;
  if (fill !== null) source.fill = fill;
  if (mediaSource !== null) source.source = mediaSource;
  if (src !== null) source.src = src;
  if (assetId !== null) source.assetId = assetId;
  if (assetRef !== null) source.assetRef = assetRef;
  if (width !== null && width !== false) source.width = width;
  if (height !== null && height !== false) source.height = height;
  if (color !== null || (fontSize !== null && fontSize !== false)) {
    source.style = {
      ...(objectArg(source.style) ?? {}),
      ...(color !== null ? { color } : {}),
      ...(fontSize !== null && fontSize !== false ? { fontSize } : {})
    };
  }
  return source;
}

/** A typed mutation is closed: public package extensions are not an authoring tunnel. */
function layerCreateFieldProblem(source: Record<string, unknown>): string | null {
  for (const field of Object.keys(source)) {
    const deferred = DEFERRED_LAYER_FIELD_PROBLEMS[field];
    if (deferred) return deferred;
    if (REPRESENTABLE_LAYER_FIELDS.has(field)) continue;
    if (field.startsWith("x-")) {
      return `layer.${field} is an unrecognized extension field. motion.timeline.layer.create admits only validated x-path fields.`;
    }
    return `layer.${field} is not a recognized MotionLayer field for motion.timeline.layer.create.`;
  }
  return null;
}

function layerCreateGeometryProblem(source: Record<string, unknown>): string | null {
  if (!Object.hasOwn(source, "geometry")) return null;
  if (source.type !== "shape") return "layer.geometry is supported only on shape layers.";
  const resolved = resolveMotionShapeGeometry(structuredClone(source) as unknown as MotionLayer);
  return resolved.ok && resolved.geometry.source === "v1" ? null : resolved.ok
    ? "layer.geometry must use the v1 authored geometry record."
    : `layer.geometry is invalid: ${resolved.message}`;
}

function layerCreateTextRunsProblem(source: Record<string, unknown>): string | null {
  if (!Object.hasOwn(source, "textRuns")) return null;
  if (Object.hasOwn(source, "text")) return "layer.text and layer.textRuns are mutually exclusive; textRuns owns complete text content.";
  const style = objectArg(source.style);
  if (!style) return null;
  const field = ["fontFamily", "fontWeight", "fontStyle"].find((key) => Object.hasOwn(style, key));
  return field ? `layer.style.${field} must be absent when layer.textRuns uses immutable manifest font assets as its sole face authority.` : null;
}

function layerCreateDashProblem(source: Record<string, unknown>): string | null {
  const style = objectArg(source.style);
  if (!style || (!Object.hasOwn(style, "strokeDasharray") && !Object.hasOwn(style, "strokeDashoffset"))) return null;
  if (!Object.hasOwn(source, "geometry")) return "layer.style stroke dash is supported only with v1 layer.geometry.";
  const dash = readGpuSceneStrokeDash(style, "motion.timeline.layer.create layer.style");
  if (!dash.ok) return dash.message;
  if (dash.dash && (typeof style.stroke !== "string" || style.stroke.trim().length === 0)) {
    return "motion.timeline.layer.create layer.style strokeDasharray requires an explicit supported visible stroke.";
  }
  return null;
}

/** Identifies the first field that the legacy typed projection would otherwise have stripped or rewritten. */
function firstLossyLayerField(source: Record<string, unknown>, layer: MotionLayer): string | null {
  const output = layer as unknown as Record<string, unknown>;
  for (const field of Object.keys(source)) {
    if (!Object.hasOwn(output, field) || !isDeepStrictEqual(source[field], output[field])) return field;
  }
  for (const field of Object.keys(output)) {
    if (!Object.hasOwn(source, field)) return field;
  }
  return null;
}

function fadeCurveValue(value: unknown): MotionLayer["fadeCurve"] | false | null {
  if (value === undefined) return null;
  return value === "linear" || value === "equal-power" ? value : false;
}

/** Preserves the established path extensions byte-for-byte after bounded Core validation. */
function pathExtensionValues(source: Record<string, unknown>): Record<string, unknown> | false | null {
  const hasPath = Object.hasOwn(source, "x-path");
  const hasViewBox = Object.hasOwn(source, "x-path-viewBox");
  const hasFillRule = Object.hasOwn(source, "x-path-fillRule");
  if (!hasPath && !hasViewBox && !hasFillRule) return null;
  if (source.type !== "shape" || (source.shape !== "path" && source.shape !== "freeform")) return false;
  if (!hasPath) return false;
  try {
    validateMotionPathData(source["x-path"], "motion.timeline.layer.create x-path");
    if (hasViewBox) parseMotionPathViewBox(source["x-path-viewBox"], "motion.timeline.layer.create x-path-viewBox");
  } catch {
    return false;
  }
  if (hasFillRule && source["x-path-fillRule"] !== "nonzero" && source["x-path-fillRule"] !== "evenodd") return false;
  return {
    "x-path": source["x-path"],
    ...(hasViewBox ? { "x-path-viewBox": source["x-path-viewBox"] } : {}),
    ...(hasFillRule ? { "x-path-fillRule": source["x-path-fillRule"] } : {})
  };
}

function pathRevealValue(value: unknown): MotionLayer["pathReveal"] | false | null {
  if (value === undefined) return null;
  const record = objectArg(value);
  if (!record || !onlyKeys(record, ["start", "end"])) return false;
  const start = optionalFiniteNumber(record, "start");
  const end = optionalFiniteNumber(record, "end");
  if (start === false || start === null || end === false || end === null || start < 0 || start > 1 || end < 0 || end > 1) return false;
  return { start, end };
}

function onlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}
