import { canonicalJsonSha256 } from "./canonical-json";
import { COLOR_PIPELINE_SCHEMA, resolveMotionColorPipeline, type ColorPipelineContract, type MotionColorPipelineDeclaration } from "./color-pipeline";
import { admitLinearSrgbSdrFinalMotion, type LinearSrgbSdrFinalMotionAdmission } from "./linear-srgb-sdr-final-admission";
import { motionDocumentBudgetError } from "./job-governor";
import { parseCanonicalSrgbHex, type CanonicalSrgbHex, type LinearSrgbSdrGradient, type LinearSrgbSdrGradientStop } from "./linear-srgb-sdr-final-math";
import type { MotionDocument } from "./types";

export { admitLinearSrgbSdrFinalMotion } from "./linear-srgb-sdr-final-admission";
export type { LinearSrgbSdrFinalMotionAdmission } from "./linear-srgb-sdr-final-admission";

export {
  composeGammaWrongEncodedSourceOver,
  composeLinearSrgbSourceOver,
  decodeSrgbChannel,
  encodeLinearSrgbChannel,
  linearSourceOver,
  linearSrgbGradientPosition,
  interpolateGammaWrongEncodedGradientStops,
  interpolateLinearSrgbGradientStops,
  parseCanonicalSrgbHex,
  premultipliedLinearToStraightSrgb,
  straightSrgbToPremultipliedLinear,
  sampleLinearSrgbGradient,
  type CanonicalSrgbHex,
  type LinearSrgbSdrGradient,
  type LinearSrgbSdrGradientStop,
  type LinearSrgbSdrPremultipliedRgba,
  type LinearSrgbSdrStraightRgba,
} from "./linear-srgb-sdr-final-math";

/** Closed strict linear-SDR route contract shared by capability discovery and final delivery. */
export const LINEAR_SRGB_SDR_FINAL_ROUTE_SCHEMA = "shellx-motion/linear-srgb-sdr-final-route@1" as const;
export const LINEAR_SRGB_SDR_FINAL_ADMISSION_SCHEMA = "shellx-motion/linear-srgb-sdr-final-admission@1" as const;
export const LINEAR_SRGB_SDR_FINAL_MAX_RECTS = 64;
export const LINEAR_SRGB_SDR_FINAL_MAX_WIDTH = 1920;
export const LINEAR_SRGB_SDR_FINAL_MAX_HEIGHT = 1080;

export interface LinearSrgbSdrFinalRouteRequest {
  readonly target: "final";
  readonly frameLane: "gpu";
  readonly delivery: "streamed";
  readonly finalLane: "ffmpeg";
  readonly preset: "mp4-h264";
}

interface LinearSrgbSdrFinalRectBase {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** The strict route's sole source-alpha spelling: top-level layer.opacity, defaulting to one. */
  readonly opacity: number;
}

export type LinearSrgbSdrFinalRect =
  | Readonly<LinearSrgbSdrFinalRectBase & { readonly fill: CanonicalSrgbHex }>
  | Readonly<LinearSrgbSdrFinalRectBase & { readonly gradient: LinearSrgbSdrGradient }>;

export interface LinearSrgbSdrFinalRoute {
  readonly schema: typeof LINEAR_SRGB_SDR_FINAL_ROUTE_SCHEMA;
  readonly admission: {
    readonly schema: typeof LINEAR_SRGB_SDR_FINAL_ADMISSION_SCHEMA;
    readonly target: "final";
    readonly frameLane: "gpu";
    readonly delivery: "streamed";
    readonly finalLane: "ffmpeg";
    readonly preset: "mp4-h264";
    readonly composition: "normal-source-over-document-order";
    readonly working: "premultiplied-linear-srgb-rgba16float";
    readonly frameBoundary: "straight-srgb-rgba8";
  };
  readonly contract: ColorPipelineContract;
  readonly canvas: { readonly width: number; readonly height: number; readonly durationMs: number; readonly fps: number; readonly background: CanonicalSrgbHex };
  readonly rects: readonly LinearSrgbSdrFinalRect[];
  readonly documentFingerprint: string;
  readonly fingerprint: string;
}

export interface LinearSrgbSdrFinalRouteRefusal {
  readonly code: "linear_srgb_sdr_final_unsupported";
  readonly message: string;
}

export type LinearSrgbSdrFinalRouteResolution =
  | Readonly<{ readonly ok: true; readonly route: LinearSrgbSdrFinalRoute }>
  | Readonly<{ readonly ok: false; readonly refusal: LinearSrgbSdrFinalRouteRefusal }>;

const REQUEST_KEYS = ["delivery", "finalLane", "frameLane", "preset", "target"] as const;
const ROOT_KEYS = ["assets", "background", "colorPipeline", "durationMs", "fps", "height", "id", "layers", "name", "provenance", "schema", "width"] as const;
const LAYER_KEYS = ["blendMode", "durationMs", "fill", "gradient", "id", "opacity", "shape", "startMs", "transform", "type"] as const;
const TRANSFORM_KEYS = ["height", "width", "x", "y"] as const;
const LINEAR_GRADIENT_KEYS = ["angle", "stops", "type"] as const;
const RADIAL_GRADIENT_KEYS = ["centerX", "centerY", "stops", "type"] as const;
const GRADIENT_STOP_KEYS = ["color", "offset"] as const;
const COLOR_PIPELINE_KEYS = ["intent", "schema"] as const;
const PROVENANCE_KEYS = ["createdBy", "sourceApp"] as const;

/**
 * Admits the one bounded strict geometry and final-delivery shape. It is pure and
 * performs no package, GPU, output, process, or allocation work. Callers must
 * still preflight the exact Browser and FFmpeg route before reserving output.
 */
export function resolveLinearSrgbSdrFinalRoute(motion: unknown, request: LinearSrgbSdrFinalRouteRequest): LinearSrgbSdrFinalRouteResolution {
  if (!exactRequest(request)) {
    return refused("The strict linear-sRGB SDR final route requires final streamed GPU-to-FFmpeg mp4-h264 delivery.");
  }
  const admitted = admitLinearSrgbSdrFinalMotion(motion);
  if (!admitted.ok) return refused(admitted.message);
  return resolveAdmittedLinearSrgbSdrFinalRoute(admitted.motion);
}

function resolveAdmittedLinearSrgbSdrFinalRoute(motion: MotionDocument): LinearSrgbSdrFinalRouteResolution {
  const root = record(motion);
  if (!sameKeys(root, ROOT_KEYS) || root.schema !== "shellx-motion/motion@1") return refused("The strict linear-sRGB SDR final route accepts only its closed static Motion document shape.");
  if (!nonEmptyString(root.id) || !nonEmptyString(root.name) || !exactProvenance(root.provenance)) {
    return refused("The strict linear-sRGB SDR final route requires non-empty document id/name and exactly non-empty provenance.sourceApp/createdBy fields.");
  }
  if (!exactStrictColorPipeline(root.colorPipeline)) {
    return refused("The strict linear-sRGB SDR final route requires the exact closed linear-srgb-sdr@1 colorPipeline declaration.");
  }
  // This call is safe only after exactStrictColorPipeline: the shared resolver intentionally throws
  // on malformed declarations for its public validation callers, while this strict route must return a typed refusal.
  const contract = resolveMotionColorPipeline({ colorPipeline: root.colorPipeline });
  if (!positiveSafeInteger(root.width, LINEAR_SRGB_SDR_FINAL_MAX_WIDTH) || !positiveSafeInteger(root.height, LINEAR_SRGB_SDR_FINAL_MAX_HEIGHT)
    || !positiveSafeInteger(root.durationMs) || !positiveFinite(root.fps)) {
    return refused(`The strict linear-sRGB SDR final route requires positive canvas dimensions up to ${LINEAR_SRGB_SDR_FINAL_MAX_WIDTH}x${LINEAR_SRGB_SDR_FINAL_MAX_HEIGHT}, duration, and fps.`);
  }
  const budgetError = motionDocumentBudgetError({ width: root.width, height: root.height, fps: root.fps, durationMs: root.durationMs });
  if (budgetError) return refused(`The strict linear-sRGB SDR final route refuses this document before GPU/output allocation: ${budgetError}`);
  const background = parseCanonicalSrgbHex(root.background);
  if (!background) return refused("The strict linear-sRGB SDR final route requires an opaque lower-case #rrggbb background.");
  if (!Array.isArray(root.assets) || root.assets.length !== 0) return refused("The strict linear-sRGB SDR final route refuses every asset source before allocation.");
  if (!Array.isArray(root.layers) || root.layers.length > LINEAR_SRGB_SDR_FINAL_MAX_RECTS) return refused(`The strict linear-sRGB SDR final route accepts at most ${LINEAR_SRGB_SDR_FINAL_MAX_RECTS} visible rectangles.`);

  const rects: LinearSrgbSdrFinalRect[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < root.layers.length; index += 1) {
    const parsed = parseRect(root.layers[index], index, root.width, root.height, root.durationMs, ids);
    if (!parsed.ok) return refused(parsed.message);
    ids.add(parsed.rect.id);
    rects.push(parsed.rect);
  }
  const admission = {
    schema: LINEAR_SRGB_SDR_FINAL_ADMISSION_SCHEMA,
    target: "final" as const,
    frameLane: "gpu" as const,
    delivery: "streamed" as const,
    finalLane: "ffmpeg" as const,
    preset: "mp4-h264" as const,
    composition: "normal-source-over-document-order" as const,
    working: "premultiplied-linear-srgb-rgba16float" as const,
    frameBoundary: "straight-srgb-rgba8" as const,
  };
  const documentFingerprint = canonicalJsonSha256(motion);
  const base = {
    schema: LINEAR_SRGB_SDR_FINAL_ROUTE_SCHEMA,
    admission,
    contract,
    canvas: { width: root.width, height: root.height, durationMs: root.durationMs, fps: root.fps, background },
    rects,
    documentFingerprint,
  };
  return Object.freeze({ ok: true, route: freeze({ ...base, fingerprint: canonicalJsonSha256(base) }) });
}

function parseRect(value: unknown, index: number, canvasWidth: number, canvasHeight: number, durationMs: number, ids: ReadonlySet<string>): { ok: true; rect: LinearSrgbSdrFinalRect } | { ok: false; message: string } {
  const layer = record(value);
  const label = `Layer ${index}`;
  if (!onlyAllowedKeys(layer, LAYER_KEYS)) return fail(`${label} contains an unsupported animation, style, geometry, transform alias, or layer field.`);
  if (!identifier(layer.id) || ids.has(layer.id)) return fail(`${label} requires one unique bounded rectangle id.`);
  if (layer.type !== "shape" || layer.shape !== "rect") return fail(`${label} must be a shape rect; groups and every non-rect layer are refused.`);
  if (layer.startMs !== 0 || layer.durationMs !== durationMs) return fail(`${label} must be visible for the complete static document duration.`);
  if (layer.blendMode !== undefined && layer.blendMode !== "normal") return fail(`${label} supports normal ordered source-over only.`);
  const hasFill = Object.hasOwn(layer, "fill"), hasGradient = Object.hasOwn(layer, "gradient");
  if (hasFill === hasGradient) return fail(`${label} requires exactly one lower-case #rrggbb fill or one admitted F2a gradient; mixed paint, alpha colours, and aliases are refused.`);
  const paint = hasFill ? parseCanonicalSrgbHex(layer.fill) : parseGradient(layer.gradient);
  if (!paint) return fail(hasFill ? `${label} requires one lower-case #rrggbb fill; alpha colours and colour aliases are refused.` : `${label} has an unsupported F2a gradient.`);
  const opacity = layer.opacity === undefined ? 1 : boundedOpacity(layer.opacity);
  if (opacity === null) return fail(`${label} opacity must be a finite number in 0..1.`);
  const transform = record(layer.transform);
  if (!sameKeys(transform, TRANSFORM_KEYS)) return fail(`${label} requires exactly transform.x/y/width/height; all transform behavior and aliases are refused.`);
  if (!integer(transform.x) || !integer(transform.y) || !positiveSafeInteger(transform.width) || !positiveSafeInteger(transform.height)
    || transform.x < 0 || transform.y < 0 || transform.x + transform.width > canvasWidth || transform.y + transform.height > canvasHeight) {
    return fail(`${label} rectangle must use positive integer geometry contained by the canvas.`);
  }
  const base = { id: layer.id, x: transform.x, y: transform.y, width: transform.width, height: transform.height, opacity };
  return { ok: true, rect: hasFill ? { ...base, fill: paint as CanonicalSrgbHex } : { ...base, gradient: paint as LinearSrgbSdrGradient } };
}

function parseGradient(value: unknown): LinearSrgbSdrGradient | null {
  const gradient = record(value);
  if (!gradient || (gradient.type !== "linear" && gradient.type !== "radial") || !sameKeys(gradient, gradient.type === "linear" ? LINEAR_GRADIENT_KEYS : RADIAL_GRADIENT_KEYS)) return null;
  const stops = parseGradientStops(gradient.stops);
  if (!stops) return null;
  if (gradient.type === "linear") {
    if (!finiteInRange(gradient.angle, 0, 360)) return null;
    return { type: "linear", angleDeg: gradient.angle, stops };
  }
  if (!finiteInRange(gradient.centerX, 0, 1) || !finiteInRange(gradient.centerY, 0, 1)) return null;
  return { type: "radial", centerX: gradient.centerX, centerY: gradient.centerY, stops };
}

function parseGradientStops(value: unknown): readonly LinearSrgbSdrGradientStop[] | null {
  if (!Array.isArray(value) || value.length < 2 || value.length > 16) return null;
  const stops: LinearSrgbSdrGradientStop[] = [];
  let prior = -1;
  for (const stopValue of value) {
    const stop = record(stopValue);
    if (!stop || !sameKeys(stop, GRADIENT_STOP_KEYS) || !finiteInRange(stop.offset, 0, 1) || stop.offset <= prior) return null;
    const color = parseCanonicalSrgbHex(stop.color);
    if (!color) return null;
    prior = stop.offset;
    stops.push({ offset: stop.offset, color });
  }
  return stops[0]?.offset === 0 && stops.at(-1)?.offset === 1 ? stops : null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype ? value as Record<string, unknown> : undefined;
}

function sameKeys(value: Record<string, unknown> | undefined, expected: readonly string[]): value is Record<string, unknown> {
  if (!value) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function onlyAllowedKeys(value: Record<string, unknown> | undefined, allowed: readonly string[]): value is Record<string, unknown> {
  return !!value && Object.keys(value).every((key) => allowed.includes(key));
}

function exactRequest(request: LinearSrgbSdrFinalRouteRequest): boolean {
  return sameKeys(record(request), REQUEST_KEYS)
    && request.target === "final" && request.frameLane === "gpu" && request.delivery === "streamed"
    && request.finalLane === "ffmpeg" && request.preset === "mp4-h264";
}

function exactStrictColorPipeline(value: unknown): value is MotionColorPipelineDeclaration & { readonly intent: "linear-srgb-sdr@1" } {
  const declaration = record(value);
  return sameKeys(declaration, COLOR_PIPELINE_KEYS)
    && declaration.schema === COLOR_PIPELINE_SCHEMA && declaration.intent === "linear-srgb-sdr@1";
}

function exactProvenance(value: unknown): value is { readonly sourceApp: string; readonly createdBy: string } {
  const provenance = record(value);
  return sameKeys(provenance, PROVENANCE_KEYS)
    && nonEmptyString(provenance.sourceApp) && nonEmptyString(provenance.createdBy);
}

function positiveSafeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function positiveFinite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value > 0; }
function integer(value: unknown): value is number { return Number.isSafeInteger(value); }
function boundedOpacity(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null; }
function finiteInRange(value: unknown, minimum: number, maximum: number): value is number { return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum; }
function identifier(value: unknown): value is string { return typeof value === "string" && /^[a-z][a-z0-9_-]{0,127}$/u.test(value); }
function nonEmptyString(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function fail(message: string): { ok: false; message: string } { return { ok: false, message }; }
function refused(message: string): LinearSrgbSdrFinalRouteResolution { return Object.freeze({ ok: false, refusal: Object.freeze({ code: "linear_srgb_sdr_final_unsupported", message }) }); }
function freeze<T>(value: T, seen = new WeakSet<object>()): T { if (!value || typeof value !== "object" || seen.has(value)) return value; seen.add(value); for (const child of Object.values(value as Record<string, unknown>)) freeze(child, seen); return Object.freeze(value); }
