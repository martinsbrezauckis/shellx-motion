/**
 * Closed, renderer-neutral dash contract for canonical Core path contours.
 *
 * The only accepted authored spelling is a numeric `style.strokeDasharray`
 * array plus optional numeric `style.strokeDashoffset`. CSS strings, percent
 * units, and renderer-native dash parsers are deliberately outside this ABI.
 * An odd authored array follows SVG's repeat rule: it is concatenated with
 * itself before use, so every normalized pattern has alternating on/off runs.
 * A positive SVG dash offset moves the pattern backwards along path distance;
 * consequently distance zero starts at `-offset mod patternLength`.
 */

export const GPU_SCENE_STROKE_DASH_SCHEMA = "shellx-motion/gpu-scene-stroke-dash@1" as const;
export const GPU_SCENE_STROKE_DASH_DECIMALS = 6;
export const GPU_SCENE_STROKE_DASH_MAX_AUTHORED_ITEMS = 32;
export const GPU_SCENE_STROKE_DASH_MAX_ITEM_LENGTH = 4_096;
export const GPU_SCENE_STROKE_DASH_MAX_TOTAL_LENGTH = 16_384;
export const GPU_SCENE_STROKE_DASH_MAX_OFFSET = 1_000_000;
export const GPU_SCENE_STROKE_DASH_MAX_INPUT_POINTS = 128;
export const GPU_SCENE_STROKE_DASH_MAX_OUTPUT_SEGMENTS = 256;
export const GPU_SCENE_STROKE_DASH_MAX_OUTPUT_VERTICES = 1_024;

const EPSILON = 1e-9;

export interface GpuSceneStrokeDashPoint {
  x: number;
  y: number;
}

/** Immutable canonical dash data. `null` from the reader means a solid stroke. */
export interface GpuSceneStrokeDash {
  schema: typeof GPU_SCENE_STROKE_DASH_SCHEMA;
  /** Always even after the documented odd-array SVG repetition rule. */
  pattern: readonly number[];
  /** Canonical offset in [0, pattern total), with the SVG-positive sign retained. */
  offset: number;
}

export type GpuSceneStrokeDashReadResult =
  | { ok: true; dash: GpuSceneStrokeDash | null }
  | GpuSceneStrokeDashFailure;

export interface GpuSceneStrokeDashSegment {
  /** Dashed runs are open; a complete unbroken closed contour remains closed. */
  closed: boolean;
  vertices: readonly GpuSceneStrokeDashPoint[];
}

export interface GpuSceneStrokeDashSegmentation {
  schema: typeof GPU_SCENE_STROKE_DASH_SCHEMA;
  sourceClosed: boolean;
  dashed: boolean;
  segments: readonly GpuSceneStrokeDashSegment[];
}

export type GpuSceneStrokeDashSegmentationResult =
  | { ok: true; segmentation: GpuSceneStrokeDashSegmentation }
  | GpuSceneStrokeDashFailure;

interface GpuSceneStrokeDashFailure { ok: false; message: string }

/**
 * Reads exactly the dash fields consumed by this ABI. Absent `strokeDasharray`
 * means solid. An offset without an array is refused rather than ignored.
 */
export function readGpuSceneStrokeDash(style: unknown, label = "GPU shape stroke"): GpuSceneStrokeDashReadResult {
  if (style === undefined || style === null) return { ok: true, dash: null };
  if (!isRecord(style)) return failure(`${label} style must be an object to read stroke dash data.`);
  const authored = style.strokeDasharray;
  const rawOffset = style.strokeDashoffset;
  if (authored === undefined) {
    if (rawOffset !== undefined) return failure(`${label} strokeDashoffset requires strokeDasharray; an offset is never ignored.`);
    return { ok: true, dash: null };
  }
  if (!Array.isArray(authored) || authored.length === 0 || authored.length > GPU_SCENE_STROKE_DASH_MAX_AUTHORED_ITEMS) {
    return failure(`${label} strokeDasharray must be a non-empty numeric array with at most ${GPU_SCENE_STROKE_DASH_MAX_AUTHORED_ITEMS} items.`);
  }
  const canonicalAuthored: number[] = [];
  for (let index = 0; index < authored.length; index += 1) {
    const raw = authored[index];
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0 || raw > GPU_SCENE_STROKE_DASH_MAX_ITEM_LENGTH) {
      return failure(`${label} strokeDasharray[${index}] must be finite and in (0, ${GPU_SCENE_STROKE_DASH_MAX_ITEM_LENGTH}].`);
    }
    const value = canonicalNumber(raw);
    if (value <= 0) return failure(`${label} strokeDasharray[${index}] collapses to zero at ${GPU_SCENE_STROKE_DASH_DECIMALS}-decimal canonical precision.`);
    canonicalAuthored.push(value);
  }
  const pattern = canonicalAuthored.length % 2 === 0 ? canonicalAuthored : [...canonicalAuthored, ...canonicalAuthored];
  const total = sum(pattern);
  if (!Number.isFinite(total) || total <= 0 || total > GPU_SCENE_STROKE_DASH_MAX_TOTAL_LENGTH) {
    return failure(`${label} normalized strokeDasharray total must be in (0, ${GPU_SCENE_STROKE_DASH_MAX_TOTAL_LENGTH}].`);
  }
  const offsetInput = rawOffset === undefined ? 0 : rawOffset;
  if (typeof offsetInput !== "number" || !Number.isFinite(offsetInput) || Math.abs(offsetInput) > GPU_SCENE_STROKE_DASH_MAX_OFFSET) {
    return failure(`${label} strokeDashoffset must be finite and within +/-${GPU_SCENE_STROKE_DASH_MAX_OFFSET}.`);
  }
  const offset = canonicalModulo(canonicalNumber(offsetInput), total);
  return {
    ok: true,
    dash: Object.freeze({
      schema: GPU_SCENE_STROKE_DASH_SCHEMA,
      pattern: Object.freeze([...pattern]),
      offset
    })
  };
}

/**
 * Segments one canonical polyline by distance without changing its geometry.
 * Any malformed, quantization-collapsed, or ceiling-exceeding result is an
 * explicit refusal; callers must never substitute a solid or approximate run.
 */
export function segmentGpuSceneStrokeDash(input: {
  vertices: readonly GpuSceneStrokeDashPoint[];
  closed: boolean;
  dash: GpuSceneStrokeDash | null;
  label?: string;
}): GpuSceneStrokeDashSegmentationResult {
  const label = input.label ?? "GPU shape stroke";
  const contour = canonicalContour(input.vertices, input.closed, label);
  if (!contour.ok) return contour;
  if (input.dash === null) {
    return success(input.closed, false, [{ closed: input.closed, vertices: contour.vertices }]);
  }
  const dash = validateCanonicalDash(input.dash, label);
  if (!dash.ok) return dash;
  const edges = contourEdges(contour.vertices, input.closed);
  const total = sum(edges.map((edge) => edge.length));
  if (!Number.isFinite(total) || total <= EPSILON) return failure(`${label} contour has no positive path distance.`);
  const spans = paintedSpans(total, dash.dash, label);
  if (!spans.ok) return spans;
  const segments: GpuSceneStrokeDashSegment[] = [];
  let vertexCount = 0;
  for (const span of spans.spans) {
    const vertices = sliceContour(edges, span.start, span.end, label);
    if (!vertices.ok) return vertices;
    vertexCount += vertices.vertices.length;
    if (vertexCount > GPU_SCENE_STROKE_DASH_MAX_OUTPUT_VERTICES) {
      return failure(`${label} dashed output exceeds the ${GPU_SCENE_STROKE_DASH_MAX_OUTPUT_VERTICES}-vertex ceiling.`);
    }
    segments.push({ closed: false, vertices: vertices.vertices });
  }
  const merged = input.closed ? mergeClosedWrap(segments, spans.spans, total) : segments;
  if (merged.length > GPU_SCENE_STROKE_DASH_MAX_OUTPUT_SEGMENTS) {
    return failure(`${label} dashed output exceeds the ${GPU_SCENE_STROKE_DASH_MAX_OUTPUT_SEGMENTS}-segment ceiling.`);
  }
  const hasCompleteRun = input.closed && merged.length === 1 && spanCoversWholeContour(spans.spans, total);
  const finalized = merged.map((segment) => ({
    closed: hasCompleteRun,
    vertices: segment.vertices
  }));
  return success(input.closed, true, finalized);
}

function canonicalContour(vertices: readonly GpuSceneStrokeDashPoint[], closed: boolean, label: string): { ok: true; vertices: GpuSceneStrokeDashPoint[] } | GpuSceneStrokeDashFailure {
  if (!Array.isArray(vertices) || vertices.length < 2 || vertices.length > GPU_SCENE_STROKE_DASH_MAX_INPUT_POINTS) {
    return failure(`${label} contour must contain 2..${GPU_SCENE_STROKE_DASH_MAX_INPUT_POINTS} canonical points.`);
  }
  const output: GpuSceneStrokeDashPoint[] = [];
  for (let index = 0; index < vertices.length; index += 1) {
    const source = vertices[index];
    if (!source || !Number.isFinite(source.x) || !Number.isFinite(source.y)) return failure(`${label} contour point ${index} must be finite.`);
    const vertex = { x: canonicalNumber(source.x), y: canonicalNumber(source.y) };
    if (output.length && samePoint(output[output.length - 1], vertex)) return failure(`${label} contour contains a zero-length edge after canonical quantization.`);
    output.push(vertex);
  }
  if (closed && samePoint(output[0], output[output.length - 1])) return failure(`${label} closed contour must not repeat its first point as a zero-length closing edge.`);
  return { ok: true, vertices: output };
}

function validateCanonicalDash(value: GpuSceneStrokeDash, label: string): { ok: true; dash: GpuSceneStrokeDash } | GpuSceneStrokeDashFailure {
  if (!value || value.schema !== GPU_SCENE_STROKE_DASH_SCHEMA || !Array.isArray(value.pattern) || value.pattern.length < 2 || value.pattern.length % 2 !== 0 || value.pattern.length > GPU_SCENE_STROKE_DASH_MAX_AUTHORED_ITEMS * 2) {
    return failure(`${label} dash ABI must contain one even normalized pattern under ${GPU_SCENE_STROKE_DASH_SCHEMA}.`);
  }
  const read = readGpuSceneStrokeDash({ strokeDasharray: [...value.pattern], strokeDashoffset: value.offset }, label);
  if (!read.ok || read.dash === null) return read.ok ? failure(`${label} dash ABI unexpectedly resolved to solid.`) : read;
  if (!sameNumberArray(value.pattern, read.dash.pattern) || value.offset !== read.dash.offset) return failure(`${label} dash ABI is not canonical; re-read style data before segmentation.`);
  return { ok: true, dash: read.dash };
}

function paintedSpans(total: number, dash: GpuSceneStrokeDash, label: string): { ok: true; spans: Array<{ start: number; end: number }> } | GpuSceneStrokeDashFailure {
  const cycle = sum(dash.pattern);
  const phase = canonicalModulo(-dash.offset, cycle);
  let index = 0;
  let consumed = phase;
  while (consumed >= dash.pattern[index] - EPSILON) {
    consumed -= dash.pattern[index];
    index = (index + 1) % dash.pattern.length;
  }
  let remaining = dash.pattern[index] - consumed;
  let distance = 0;
  const spans: Array<{ start: number; end: number }> = [];
  while (distance < total - EPSILON) {
    const step = Math.min(remaining, total - distance);
    if (!Number.isFinite(step) || step <= EPSILON) return failure(`${label} dash phase produced a zero-length run.`);
    const end = canonicalNumber(distance + step);
    if (index % 2 === 0 && end > distance + EPSILON) {
      spans.push({ start: canonicalNumber(distance), end });
      if (spans.length > GPU_SCENE_STROKE_DASH_MAX_OUTPUT_SEGMENTS) {
        return failure(`${label} dashed output exceeds the ${GPU_SCENE_STROKE_DASH_MAX_OUTPUT_SEGMENTS}-segment ceiling.`);
      }
    }
    distance += step;
    remaining -= step;
    if (remaining <= EPSILON) {
      index = (index + 1) % dash.pattern.length;
      remaining = dash.pattern[index];
    }
  }
  return { ok: true, spans };
}

interface ContourEdge { start: GpuSceneStrokeDashPoint; end: GpuSceneStrokeDashPoint; from: number; to: number; length: number }

function contourEdges(vertices: readonly GpuSceneStrokeDashPoint[], closed: boolean): ContourEdge[] {
  const edges: ContourEdge[] = [];
  const count = closed ? vertices.length : vertices.length - 1;
  let from = 0;
  for (let index = 0; index < count; index += 1) {
    const start = vertices[index], end = vertices[(index + 1) % vertices.length];
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    edges.push({ start, end, from, to: from + length, length });
    from += length;
  }
  return edges;
}

function sliceContour(edges: readonly ContourEdge[], start: number, end: number, label: string): { ok: true; vertices: GpuSceneStrokeDashPoint[] } | GpuSceneStrokeDashFailure {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start + EPSILON) return failure(`${label} dash span must have positive finite length.`);
  const output: GpuSceneStrokeDashPoint[] = [pointAtDistance(edges, start)];
  for (const edge of edges) if (edge.to > start + EPSILON && edge.to < end - EPSILON) pushDistinct(output, edge.end);
  pushDistinct(output, pointAtDistance(edges, end));
  if (output.length < 2 || output.some((vertex, index) => index > 0 && samePoint(vertex, output[index - 1]))) {
    return failure(`${label} dash span collapsed to a zero-length segment at canonical precision.`);
  }
  return { ok: true, vertices: output };
}

function pointAtDistance(edges: readonly ContourEdge[], distance: number): GpuSceneStrokeDashPoint {
  const edge = edges.find((candidate) => distance <= candidate.to + EPSILON) ?? edges[edges.length - 1];
  const amount = edge.length <= EPSILON ? 0 : Math.max(0, Math.min(1, (distance - edge.from) / edge.length));
  return { x: canonicalNumber(edge.start.x + ((edge.end.x - edge.start.x) * amount)), y: canonicalNumber(edge.start.y + ((edge.end.y - edge.start.y) * amount)) };
}

function mergeClosedWrap(segments: readonly GpuSceneStrokeDashSegment[], spans: readonly { start: number; end: number }[], total: number): GpuSceneStrokeDashSegment[] {
  if (segments.length < 2 || spans.length !== segments.length) return [...segments];
  const firstSpan = spans[0], lastSpan = spans[spans.length - 1];
  if (firstSpan.start > EPSILON || Math.abs(lastSpan.end - total) > EPSILON) return [...segments];
  const first = segments[0], last = segments[segments.length - 1];
  // A painted run crosses the closed-contour seam. Preserve that run as one
  // open polyline (last -> seam -> first) so it does not grow two fake butt caps.
  const vertices = [...last.vertices.map((vertex) => ({ ...vertex })), ...first.vertices.slice(1).map((vertex) => ({ ...vertex }))];
  return [{ closed: false, vertices }, ...segments.slice(1, -1)];
}

function spanCoversWholeContour(spans: readonly { start: number; end: number }[], total: number): boolean {
  return spans.length === 1 && spans[0].start <= EPSILON && Math.abs(spans[0].end - total) <= EPSILON;
}

function success(sourceClosed: boolean, dashed: boolean, segments: readonly GpuSceneStrokeDashSegment[]): GpuSceneStrokeDashSegmentationResult {
  const immutableSegments = segments.map((segment) => Object.freeze({
    closed: segment.closed,
    vertices: Object.freeze(segment.vertices.map((vertex) => Object.freeze({ ...vertex })))
  }));
  return { ok: true, segmentation: Object.freeze({ schema: GPU_SCENE_STROKE_DASH_SCHEMA, sourceClosed, dashed, segments: Object.freeze(immutableSegments) }) };
}

function canonicalNumber(value: number): number { const output = Number(value.toFixed(GPU_SCENE_STROKE_DASH_DECIMALS)); return Object.is(output, -0) ? 0 : output; }
function canonicalModulo(value: number, modulo: number): number { const normalized = canonicalNumber(((value % modulo) + modulo) % modulo); return normalized >= modulo ? 0 : normalized; }
function sum(values: readonly number[]): number { return values.reduce((total, value) => total + value, 0); }
function samePoint(left: GpuSceneStrokeDashPoint, right: GpuSceneStrokeDashPoint): boolean { return left.x === right.x && left.y === right.y; }
function sameNumberArray(left: readonly number[], right: readonly number[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function pushDistinct(output: GpuSceneStrokeDashPoint[], value: GpuSceneStrokeDashPoint): void { if (!output.length || !samePoint(output[output.length - 1], value)) output.push(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function failure(message: string): GpuSceneStrokeDashFailure { return { ok: false, message }; }
