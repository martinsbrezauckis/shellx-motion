import { isSupportedHexColorString } from "./color";

export const CHROMA_KEY_SCHEMA = "shellx-motion/chroma-key@1" as const;
export const ROTO_MASK_SCHEMA = "shellx-motion/roto-mask@1" as const;
export const ROTO_TRACKING_ATTACHMENT_SCHEMA = "shellx-motion/roto-tracking-attachment@1" as const;
export const MAX_ROTO_FRAMES = 1_000;
export const MAX_ROTO_VERTICES = 256;

export interface MotionMatteCleanup {
  denoiseRadiusPx?: number;
  growShrinkPx?: number;
  chokePx?: number;
  featherPx?: number;
  blackClip?: number;
  whiteClip?: number;
}

export interface MotionChromaKey {
  schema: typeof CHROMA_KEY_SCHEMA;
  keyColor: string;
  similarity?: number;
  smoothness?: number;
  shadow?: number;
  spillSuppression?: number;
  spillBalance?: number;
  edgeColorCorrection?: number;
  matte?: MotionMatteCleanup;
}

export interface MotionRotoTangent {
  x: number;
  y: number;
}

export interface MotionRotoVertex {
  id: string;
  x: number;
  y: number;
  inTangent?: MotionRotoTangent;
  outTangent?: MotionRotoTangent;
}

export interface MotionRotoFrame {
  atMs: number;
  vertices: MotionRotoVertex[];
}

export interface MotionRotoTrackingAttachment {
  schema: typeof ROTO_TRACKING_ATTACHMENT_SCHEMA;
  analysisId: string;
  sourceSha256: string;
  segmentIndex: number;
  model: "translation" | "similarity" | "homography";
}

export interface MotionMask {
  type: "rect" | "rounded-rect" | "path" | "roto" | string;
  inset?: Partial<Record<"top" | "right" | "bottom" | "left", number>>;
  radius?: number;
  /** Local SVG path geometry for a browser-rendered path mask. */
  path?: string;
  /** x y width height coordinates used to normalize path geometry. */
  viewBox?: string;
  fillRule?: "nonzero" | "evenodd";
  schema?: typeof ROTO_MASK_SCHEMA;
  closed?: boolean;
  inverted?: boolean;
  opacity?: number;
  featherPx?: number;
  expansionPx?: number;
  frames?: MotionRotoFrame[];
  tracking?: MotionRotoTrackingAttachment;
}

export interface ResolvedMotionChromaKey {
  keyColor: string;
  similarity: number;
  smoothness: number;
  shadow: number;
  spillSuppression: number;
  spillBalance: number;
  edgeColorCorrection: number;
  matte: Required<MotionMatteCleanup>;
}

export interface KeyingContractIssue {
  path: string;
  message: string;
}

export function resolvedMotionChromaKey(value: MotionChromaKey): ResolvedMotionChromaKey {
  return {
    keyColor: value.keyColor.toLowerCase(),
    similarity: value.similarity ?? 0.18,
    smoothness: value.smoothness ?? 0.12,
    shadow: value.shadow ?? 0.15,
    spillSuppression: value.spillSuppression ?? 0.55,
    spillBalance: value.spillBalance ?? 0,
    edgeColorCorrection: value.edgeColorCorrection ?? 0.25,
    matte: {
      denoiseRadiusPx: value.matte?.denoiseRadiusPx ?? 0,
      growShrinkPx: value.matte?.growShrinkPx ?? 0,
      chokePx: value.matte?.chokePx ?? 0,
      featherPx: value.matte?.featherPx ?? 0,
      blackClip: value.matte?.blackClip ?? 0,
      whiteClip: value.matte?.whiteClip ?? 1,
    },
  };
}

export function validateLayerKeyingAndRoto(layer: unknown, path: string): KeyingContractIssue[] {
  const issues: KeyingContractIssue[] = [];
  const record = objectValue(layer);
  if (!record) return issues;
  if ("keying" in record) validateChromaKey(record.keying, String(record.type ?? ""), `${path}/keying`, issues);
  const mask = objectValue(record.mask);
  if (mask?.type === "roto") validateRotoMask(mask, record, `${path}/mask`, issues);
  return issues;
}

export function resolveRotoFrame(mask: MotionMask, atMs: number): MotionRotoFrame {
  if (mask.type !== "roto" || !Array.isArray(mask.frames) || mask.frames.length < 1) {
    throw new Error("Roto mask has no frames.");
  }
  const frames = mask.frames;
  if (atMs <= frames[0].atMs) return structuredClone(frames[0]);
  if (atMs >= frames.at(-1)!.atMs) return structuredClone(frames.at(-1)!);
  const rightIndex = frames.findIndex((frame) => frame.atMs >= atMs);
  const left = frames[rightIndex - 1];
  const right = frames[rightIndex];
  if (right.atMs === atMs) return structuredClone(right);
  const progress = (atMs - left.atMs) / (right.atMs - left.atMs);
  return {
    atMs,
    vertices: left.vertices.map((vertex, index) => interpolateVertex(vertex, right.vertices[index], progress)),
  };
}

export function rotoFrameSvgPath(frame: MotionRotoFrame, width: number, height: number, closed = true): string {
  if (frame.vertices.length < 2 || width <= 0 || height <= 0) throw new Error("Roto path dimensions are invalid.");
  const point = (vertex: MotionRotoVertex) => ({ x: vertex.x * width, y: vertex.y * height });
  const first = frame.vertices[0];
  let path = `M ${decimal(point(first).x)} ${decimal(point(first).y)}`;
  for (let index = 1; index < frame.vertices.length; index += 1) {
    path += cubicSegment(frame.vertices[index - 1], frame.vertices[index], width, height);
  }
  if (closed) path += `${cubicSegment(frame.vertices.at(-1)!, first, width, height)} Z`;
  return path;
}

function validateChromaKey(value: unknown, layerType: string, path: string, issues: KeyingContractIssue[]): void {
  const keying = objectValue(value);
  if (!keying) return issue(issues, path, "must be an object");
  unknownKeys(keying, ["schema", "keyColor", "similarity", "smoothness", "shadow", "spillSuppression", "spillBalance", "edgeColorCorrection", "matte"], path, issues);
  if (keying.schema !== CHROMA_KEY_SCHEMA) issue(issues, `${path}/schema`, `must equal ${CHROMA_KEY_SCHEMA}`);
  if (layerType !== "image" && layerType !== "video") issue(issues, path, "is supported only on image or video layers");
  if (typeof keying.keyColor !== "string" || !isSupportedHexColorString(keying.keyColor) || !/^#[0-9a-f]{6}$/i.test(keying.keyColor)) {
    issue(issues, `${path}/keyColor`, "must be a six-digit hex color");
  }
  for (const field of ["similarity", "smoothness", "shadow", "spillSuppression", "edgeColorCorrection"] as const) {
    if (field in keying && !unitNumber(keying[field])) issue(issues, `${path}/${field}`, "must be a finite number between 0 and 1");
  }
  if ("spillBalance" in keying && !boundedNumber(keying.spillBalance, -1, 1)) issue(issues, `${path}/spillBalance`, "must be a finite number between -1 and 1");
  if ("matte" in keying) validateMatteCleanup(keying.matte, `${path}/matte`, issues);
}

function validateMatteCleanup(value: unknown, path: string, issues: KeyingContractIssue[]): void {
  const matte = objectValue(value);
  if (!matte) return issue(issues, path, "must be an object");
  unknownKeys(matte, ["denoiseRadiusPx", "growShrinkPx", "chokePx", "featherPx", "blackClip", "whiteClip"], path, issues);
  if ("denoiseRadiusPx" in matte && (!Number.isInteger(matte.denoiseRadiusPx) || !boundedNumber(matte.denoiseRadiusPx, 0, 4))) issue(issues, `${path}/denoiseRadiusPx`, "must be an integer between 0 and 4");
  if ("growShrinkPx" in matte && (!Number.isInteger(matte.growShrinkPx) || !boundedNumber(matte.growShrinkPx, -16, 16))) issue(issues, `${path}/growShrinkPx`, "must be an integer between -16 and 16");
  if ("chokePx" in matte && (!Number.isInteger(matte.chokePx) || !boundedNumber(matte.chokePx, 0, 16))) issue(issues, `${path}/chokePx`, "must be an integer between 0 and 16");
  if ("featherPx" in matte && (!Number.isInteger(matte.featherPx) || !boundedNumber(matte.featherPx, 0, 32))) issue(issues, `${path}/featherPx`, "must be an integer between 0 and 32");
  for (const field of ["blackClip", "whiteClip"] as const) if (field in matte && !unitNumber(matte[field])) issue(issues, `${path}/${field}`, "must be a finite number between 0 and 1");
  if (unitNumber(matte.blackClip) && unitNumber(matte.whiteClip) && matte.blackClip >= matte.whiteClip) issue(issues, path, "blackClip must be less than whiteClip");
}

function validateRotoMask(mask: Record<string, unknown>, layer: Record<string, unknown>, path: string, issues: KeyingContractIssue[]): void {
  unknownKeys(mask, ["type", "schema", "closed", "inverted", "opacity", "featherPx", "expansionPx", "fillRule", "frames", "tracking"], path, issues);
  if (mask.schema !== ROTO_MASK_SCHEMA) issue(issues, `${path}/schema`, `must equal ${ROTO_MASK_SCHEMA}`);
  if ("closed" in mask && typeof mask.closed !== "boolean") issue(issues, `${path}/closed`, "must be a boolean");
  if (mask.closed === false) issue(issues, `${path}/closed`, "must be true for a filled roto mask");
  if ("inverted" in mask && typeof mask.inverted !== "boolean") issue(issues, `${path}/inverted`, "must be a boolean");
  if ("opacity" in mask && !unitNumber(mask.opacity)) issue(issues, `${path}/opacity`, "must be a finite number between 0 and 1");
  if ("featherPx" in mask && !boundedNumber(mask.featherPx, 0, 128)) issue(issues, `${path}/featherPx`, "must be between 0 and 128");
  if ("expansionPx" in mask && !boundedNumber(mask.expansionPx, -256, 256)) issue(issues, `${path}/expansionPx`, "must be between -256 and 256");
  if ("fillRule" in mask && mask.fillRule !== "nonzero" && mask.fillRule !== "evenodd") issue(issues, `${path}/fillRule`, "must be nonzero or evenodd");
  validateRotoFrames(mask.frames, Number(layer.startMs), Number(layer.durationMs), `${path}/frames`, issues);
  if ("tracking" in mask) validateRotoTracking(mask.tracking, `${path}/tracking`, issues);
}

function validateRotoFrames(value: unknown, startMs: number, durationMs: number, path: string, issues: KeyingContractIssue[]): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ROTO_FRAMES) return issue(issues, path, `must contain 1..${MAX_ROTO_FRAMES} frames`);
  let priorAtMs = -1;
  let ids: string[] | null = null;
  value.forEach((entry, frameIndex) => {
    const frame = objectValue(entry);
    const framePath = `${path}/${frameIndex}`;
    if (!frame) return issue(issues, framePath, "must be an object");
    unknownKeys(frame, ["atMs", "vertices"], framePath, issues);
    if (!Number.isFinite(frame.atMs) || Number(frame.atMs) <= priorAtMs || Number(frame.atMs) < startMs || Number(frame.atMs) > startMs + durationMs) issue(issues, `${framePath}/atMs`, "must be strictly increasing and inside the layer range");
    priorAtMs = Number(frame.atMs);
    if (!Array.isArray(frame.vertices) || frame.vertices.length < 3 || frame.vertices.length > MAX_ROTO_VERTICES) return issue(issues, `${framePath}/vertices`, `must contain 3..${MAX_ROTO_VERTICES} vertices`);
    const frameIds = frame.vertices.map((vertex, vertexIndex) => validateRotoVertex(vertex, `${framePath}/vertices/${vertexIndex}`, issues));
    if (new Set(frameIds).size !== frameIds.length) issue(issues, `${framePath}/vertices`, "vertex ids must be unique");
    if (ids && (ids.length !== frameIds.length || ids.some((id, index) => id !== frameIds[index]))) issue(issues, `${framePath}/vertices`, "every frame must preserve vertex id and order");
    ids ??= frameIds;
  });
}

function validateRotoVertex(value: unknown, path: string, issues: KeyingContractIssue[]): string {
  const vertex = objectValue(value);
  if (!vertex) { issue(issues, path, "must be an object"); return ""; }
  unknownKeys(vertex, ["id", "x", "y", "inTangent", "outTangent"], path, issues);
  const id = typeof vertex.id === "string" && safeId(vertex.id) ? vertex.id : "";
  if (!id) issue(issues, `${path}/id`, "must be a safe identifier");
  for (const field of ["x", "y"] as const) if (!unitNumber(vertex[field])) issue(issues, `${path}/${field}`, "must be a normalized finite number");
  for (const field of ["inTangent", "outTangent"] as const) if (field in vertex) validateTangent(vertex[field], `${path}/${field}`, issues);
  return id;
}

function validateTangent(value: unknown, path: string, issues: KeyingContractIssue[]): void {
  const tangent = objectValue(value);
  if (!tangent) return issue(issues, path, "must be an object");
  unknownKeys(tangent, ["x", "y"], path, issues);
  for (const field of ["x", "y"] as const) if (!boundedNumber(tangent[field], -2, 2)) issue(issues, `${path}/${field}`, "must be a finite normalized delta between -2 and 2");
}

function validateRotoTracking(value: unknown, path: string, issues: KeyingContractIssue[]): void {
  const tracking = objectValue(value);
  if (!tracking) return issue(issues, path, "must be an object");
  unknownKeys(tracking, ["schema", "analysisId", "sourceSha256", "segmentIndex", "model"], path, issues);
  if (tracking.schema !== ROTO_TRACKING_ATTACHMENT_SCHEMA) issue(issues, `${path}/schema`, `must equal ${ROTO_TRACKING_ATTACHMENT_SCHEMA}`);
  if (typeof tracking.analysisId !== "string" || !safeId(tracking.analysisId)) issue(issues, `${path}/analysisId`, "must be a safe identifier");
  if (typeof tracking.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(tracking.sourceSha256)) issue(issues, `${path}/sourceSha256`, "must be a lowercase SHA-256");
  if (!Number.isSafeInteger(tracking.segmentIndex) || Number(tracking.segmentIndex) < 0) issue(issues, `${path}/segmentIndex`, "must be a non-negative integer");
  if (!["translation", "similarity", "homography"].includes(String(tracking.model))) issue(issues, `${path}/model`, "must be translation, similarity, or homography");
}

function interpolateVertex(left: MotionRotoVertex, right: MotionRotoVertex, amount: number): MotionRotoVertex {
  return {
    id: left.id,
    x: interpolate(left.x, right.x, amount),
    y: interpolate(left.y, right.y, amount),
    ...(left.inTangent || right.inTangent ? { inTangent: interpolateTangent(left.inTangent, right.inTangent, amount) } : {}),
    ...(left.outTangent || right.outTangent ? { outTangent: interpolateTangent(left.outTangent, right.outTangent, amount) } : {}),
  };
}

function interpolateTangent(left: MotionRotoTangent | undefined, right: MotionRotoTangent | undefined, amount: number): MotionRotoTangent {
  return { x: interpolate(left?.x ?? 0, right?.x ?? 0, amount), y: interpolate(left?.y ?? 0, right?.y ?? 0, amount) };
}

function cubicSegment(left: MotionRotoVertex, right: MotionRotoVertex, width: number, height: number): string {
  const c1 = { x: (left.x + (left.outTangent?.x ?? 0)) * width, y: (left.y + (left.outTangent?.y ?? 0)) * height };
  const c2 = { x: (right.x + (right.inTangent?.x ?? 0)) * width, y: (right.y + (right.inTangent?.y ?? 0)) * height };
  return ` C ${decimal(c1.x)} ${decimal(c1.y)} ${decimal(c2.x)} ${decimal(c2.y)} ${decimal(right.x * width)} ${decimal(right.y * height)}`;
}

function objectValue(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function unitNumber(value: unknown): value is number { return boundedNumber(value, 0, 1); }
function boundedNumber(value: unknown, min: number, max: number): value is number { return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max; }
function safeId(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value); }
function interpolate(left: number, right: number, amount: number): number { return left + (right - left) * amount; }
function decimal(value: number): string { return String(Number(value.toFixed(4))); }
function issue(issues: KeyingContractIssue[], path: string, message: string): void { issues.push({ path, message }); }
function unknownKeys(value: Record<string, unknown>, allowed: string[], path: string, issues: KeyingContractIssue[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) issue(issues, `${path}/${key}`, "is not supported");
}
