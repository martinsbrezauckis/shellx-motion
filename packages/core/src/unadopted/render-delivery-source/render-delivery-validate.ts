/** Strict descriptor-first admission for private provider deliveries. */

import { renderDeliveryFingerprint, renderDeliveryFrameSequenceSha256, renderDeliveryScheduleSha256 } from "./render-delivery-identity";
import {
  MAX_RENDER_DELIVERY_DIMENSION,
  MAX_RENDER_DELIVERY_FRAMES,
  MAX_RENDER_DELIVERY_PIXELS,
  MOTION_RENDER_DELIVERY_ANCHOR_CONVENTION,
  MOTION_RENDER_DELIVERY_ANCHOR_PAYLOAD_SCHEMA,
  MOTION_RENDER_DELIVERY_SCHEMA,
  type MotionRenderDelivery,
  type RenderDeliveryDescription,
  type RenderDeliveryIssue,
  type RenderDeliveryRational,
} from "./render-delivery-types";

const SHA256 = /^[a-f0-9]{64}$/;
const PROVIDER_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){0,7}$/;
const JOB_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Describe, validate, canonicalize, and freeze an untrusted provider delivery without accessing IO. */
export function describeMotionRenderDelivery(value: unknown): RenderDeliveryDescription {
  const issues: RenderDeliveryIssue[] = [];
  const root = record(value, "$", ["schema", "provider", "terminal", "identity", "conventions", "rate", "schedule", "passes"], ["anchors"], issues);
  if (!root) return failure(issues);
  literal(root.schema, MOTION_RENDER_DELIVERY_SCHEMA, "$.schema", issues);
  const provider = record(root.provider, "$.provider", ["id", "version", "capabilitySnapshotSha256"], [], issues);
  if (provider) {
    text(provider.id, "$.provider.id", PROVIDER_ID, 96, issues);
    text(provider.version, "$.provider.version", /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/, 96, issues);
    sha(provider.capabilitySnapshotSha256, "$.provider.capabilitySnapshotSha256", issues);
  }
  const terminal = record(root.terminal, "$.terminal", ["jobId", "outcome", "revalidation", "cleanup"], [], issues);
  if (terminal) {
    text(terminal.jobId, "$.terminal.jobId", JOB_ID, 64, issues);
    literal(terminal.outcome, "passed", "$.terminal.outcome", issues);
    literal(terminal.revalidation, "passed", "$.terminal.revalidation", issues);
    const cleanup = record(terminal.cleanup, "$.terminal.cleanup", ["state", "succeeded"], [], issues);
    if (cleanup) { oneOf(cleanup.state, ["closed", "held-warm"], "$.terminal.cleanup.state", issues); literal(cleanup.succeeded, true, "$.terminal.cleanup.succeeded", issues); }
  }
  const identity = record(root.identity, "$.identity", ["sceneSha256", "shotSha256", "assetManifestSha256", "scheduleSha256", "providerReceiptSha256"], [], issues);
  if (identity) for (const key of ["sceneSha256", "shotSha256", "assetManifestSha256", "scheduleSha256", "providerReceiptSha256"] as const) sha(identity[key], `$.identity.${key}`, issues);
  const conventions = record(root.conventions, "$.conventions", ["timing", "coordinates", "alpha", "depth"], [], issues);
  if (conventions) {
    literal(conventions.timing, "frame-index-rational-seconds", "$.conventions.timing", issues);
    literal(conventions.coordinates, "screen-pixel-top-left", "$.conventions.coordinates", issues);
    literal(conventions.alpha, "straight", "$.conventions.alpha", issues);
    literal(conventions.depth, "not-provided", "$.conventions.depth", issues, "unsupported-depth");
  }
  const rate = rational(root.rate, "$.rate", issues, 1, 240_000);
  const schedule = array(root.schedule, "$.schedule", MAX_RENDER_DELIVERY_FRAMES, issues);
  if (schedule && rate) validateSchedule(schedule, rate, issues);
  if (identity && schedule && rate && isSha(identity.scheduleSha256) && issues.every((issue) => !issue.path.startsWith("$.schedule") && issue.path !== "$.rate")) {
    equalHash(identity.scheduleSha256, renderDeliveryScheduleSha256(rate, schedule as never), "$.identity.scheduleSha256", "schedule", issues);
  }
  const passes = array(root.passes, "$.passes", 3, issues);
  if (passes && schedule) validatePasses(passes, schedule.length, issues);
  if (root.anchors !== undefined) validateAnchors(root.anchors, schedule?.length, issues);
  if (issues.length > 0) return failure(issues);
  const delivery = freeze(structuredClone(value) as MotionRenderDelivery);
  return { ok: true, delivery, fingerprint: renderDeliveryFingerprint(delivery) };
}

function validateSchedule(schedule: unknown[], rate: RenderDeliveryRational, issues: RenderDeliveryIssue[]): void {
  if (schedule.length === 0) issue("$.schedule", "range", "must include at least one frame", issues);
  for (let index = 0; index < schedule.length; index += 1) {
    const frame = record(schedule[index], `$.schedule[${index}]`, ["index", "presentationTime"], [], issues);
    if (!frame) continue;
    integer(frame.index, `$.schedule[${index}].index`, 0, MAX_RENDER_DELIVERY_FRAMES - 1, issues);
    if (frame.index !== index) issue(`$.schedule[${index}].index`, "sequence", "must be contiguous and zero based", issues);
    const time = rational(frame.presentationTime, `$.schedule[${index}].presentationTime`, issues, 0, Number.MAX_SAFE_INTEGER);
    if (time) {
      const expected = reduce(index * rate.denominator, rate.numerator);
      if (time.numerator !== expected.numerator || time.denominator !== expected.denominator) issue(`$.schedule[${index}].presentationTime`, "timing", "must equal index divided by the exact rate", issues);
    }
  }
}

function validatePasses(passes: unknown[], scheduleLength: number, issues: RenderDeliveryIssue[]): void {
  if (passes.length !== 1) issue("$.passes", "pass-set", "v1 requires exactly one beauty pass; matte and depth are refused", issues);
  for (let index = 0; index < passes.length; index += 1) {
    const pass = record(passes[index], `$.passes[${index}]`, ["kind", "id", "format", "alphaMode", "width", "height", "frames", "frameSequenceSha256"], [], issues);
    if (!pass) continue;
    if (pass.kind === "matte" || pass.kind === "depth") { issue(`$.passes[${index}].kind`, `unsupported-${pass.kind}`, `${pass.kind} delivery is explicitly refused in v1`, issues); continue; }
    literal(pass.kind, "beauty", `$.passes[${index}].kind`, issues, "unsupported-pass");
    literal(pass.id, "beauty", `$.passes[${index}].id`, issues);
    literal(pass.format, "png", `$.passes[${index}].format`, issues);
    literal(pass.alphaMode, "straight", `$.passes[${index}].alphaMode`, issues);
    integer(pass.width, `$.passes[${index}].width`, 1, MAX_RENDER_DELIVERY_DIMENSION, issues);
    integer(pass.height, `$.passes[${index}].height`, 1, MAX_RENDER_DELIVERY_DIMENSION, issues);
    if (typeof pass.width === "number" && typeof pass.height === "number" && pass.width * pass.height > MAX_RENDER_DELIVERY_PIXELS) issue(`$.passes[${index}]`, "pixels", "exceeds the bounded pixel budget", issues);
    const frames = array(pass.frames, `$.passes[${index}].frames`, MAX_RENDER_DELIVERY_FRAMES, issues);
    if (!frames) continue;
    if (frames.length !== scheduleLength) issue(`$.passes[${index}].frames`, "frame-count", "must exactly match the schedule", issues);
    for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
      const frame = record(frames[frameIndex], `$.passes[${index}].frames[${frameIndex}]`, ["index", "sha256"], [], issues);
      if (!frame) continue;
      integer(frame.index, `$.passes[${index}].frames[${frameIndex}].index`, 0, MAX_RENDER_DELIVERY_FRAMES - 1, issues);
      if (frame.index !== frameIndex) issue(`$.passes[${index}].frames[${frameIndex}].index`, "sequence", "must be contiguous and zero based", issues);
      sha(frame.sha256, `$.passes[${index}].frames[${frameIndex}].sha256`, issues);
    }
    sha(pass.frameSequenceSha256, `$.passes[${index}].frameSequenceSha256`, issues);
    if (isSha(pass.frameSequenceSha256) && frames.every((frame) => validFrame(frame))) equalHash(pass.frameSequenceSha256, renderDeliveryFrameSequenceSha256(frames as never), `$.passes[${index}].frameSequenceSha256`, "frame sequence", issues);
  }
}

function validateAnchors(value: unknown, scheduleLength: number | undefined, issues: RenderDeliveryIssue[]): void {
  const anchors = record(value, "$.anchors", ["schema", "sha256", "frameCount", "convention"], [], issues);
  if (!anchors) return;
  literal(anchors.schema, MOTION_RENDER_DELIVERY_ANCHOR_PAYLOAD_SCHEMA, "$.anchors.schema", issues);
  sha(anchors.sha256, "$.anchors.sha256", issues);
  integer(anchors.frameCount, "$.anchors.frameCount", 0, MAX_RENDER_DELIVERY_FRAMES, issues);
  if (scheduleLength !== undefined && typeof anchors.frameCount === "number" && anchors.frameCount !== scheduleLength) issue("$.anchors.frameCount", "frame-count", "must exactly match the schedule", issues);
  literal(anchors.convention, MOTION_RENDER_DELIVERY_ANCHOR_CONVENTION, "$.anchors.convention", issues);
}

function record(value: unknown, path: string, required: readonly string[], optional: readonly string[], issues: RenderDeliveryIssue[]): Record<string, unknown> | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value) || !plainObject(value)) { issue(path, "object", "must be a plain data object", issues); return undefined; }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length > 0 || Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !("value" in descriptor))) { issue(path, "reflection", "must contain enumerable data fields only", issues); return undefined; }
    const allowed = new Set([...required, ...optional]);
    for (const key of Object.keys(value)) if (!allowed.has(key)) { issue(`${path}.${key}`, "unknown", "is not admitted by motion.render-delivery/v1", issues); return undefined; }
    for (const key of required) if (!Object.prototype.hasOwnProperty.call(descriptors, key)) { issue(`${path}.${key}`, "required", "is required", issues); return undefined; }
    return value as Record<string, unknown>;
  } catch { issue(path, "reflection", "must permit safe descriptor inspection", issues); return undefined; }
}

function array(value: unknown, path: string, maximum: number, issues: RenderDeliveryIssue[]): unknown[] | undefined {
  try {
    if (!Array.isArray(value)) { issue(path, "array", "must be an array", issues); return undefined; }
    if (Object.getPrototypeOf(value) !== Array.prototype) { issue(path, "prototype", "must use the standard array prototype", issues); return undefined; }
    if (!Number.isSafeInteger(value.length) || value.length > maximum) { issue(path, "cap", `must contain at most ${maximum} entries`, issues); return undefined; }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).filter((key) => key !== "length");
    if (Object.getOwnPropertySymbols(value).length > 0 || keys.length !== value.length || keys.some((key, index) => key !== String(index)) || keys.some((key) => !descriptors[key]!.enumerable || !("value" in descriptors[key]!))) { issue(path, "reflection", "must be a dense data array without extra fields", issues); return undefined; }
    return value;
  } catch { issue(path, "reflection", "must permit safe descriptor inspection", issues); return undefined; }
}

function rational(value: unknown, path: string, issues: RenderDeliveryIssue[], minimumNumerator: number, maximum: number): RenderDeliveryRational | undefined {
  const result = record(value, path, ["numerator", "denominator"], [], issues);
  if (!result) return undefined;
  integer(result.numerator, `${path}.numerator`, minimumNumerator, maximum, issues);
  integer(result.denominator, `${path}.denominator`, 1, maximum, issues);
  if (typeof result.numerator !== "number" || typeof result.denominator !== "number") return undefined;
  if (gcd(result.numerator, result.denominator) !== 1) issue(path, "rational", "must be reduced to lowest terms", issues);
  return { numerator: result.numerator, denominator: result.denominator };
}

function text(value: unknown, path: string, pattern: RegExp, maximum: number, issues: RenderDeliveryIssue[]): void { if (typeof value !== "string" || value.length > maximum || !pattern.test(value)) issue(path, "string", "has an invalid bounded identifier", issues); }
function sha(value: unknown, path: string, issues: RenderDeliveryIssue[]): void { if (!isSha(value)) issue(path, "sha256", "must be a lowercase 64-character SHA-256", issues); }
function isSha(value: unknown): value is string { return typeof value === "string" && SHA256.test(value); }
function integer(value: unknown, path: string, minimum: number, maximum: number, issues: RenderDeliveryIssue[]): void { if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) issue(path, "integer", `must be an integer from ${minimum} through ${maximum}`, issues); }
function literal(value: unknown, expected: string | boolean, path: string, issues: RenderDeliveryIssue[], code = "literal"): void { if (value !== expected) issue(path, code, `must equal ${JSON.stringify(expected)}`, issues); }
function oneOf(value: unknown, expected: readonly string[], path: string, issues: RenderDeliveryIssue[]): void { if (typeof value !== "string" || !expected.includes(value)) issue(path, "enum", `must be one of ${expected.join(", ")}`, issues); }
function equalHash(actual: string, expected: string, path: string, label: string, issues: RenderDeliveryIssue[]): void { if (actual !== expected) issue(path, "hash-mismatch", `does not match the canonical ${label} hash`, issues); }
function validFrame(value: unknown): value is { readonly index: number; readonly sha256: string } { return typeof value === "object" && value !== null && Number.isSafeInteger((value as { index?: unknown }).index) && isSha((value as { sha256?: unknown }).sha256); }
function reduce(numerator: number, denominator: number): RenderDeliveryRational { const divisor = gcd(numerator, denominator); return { numerator: numerator / divisor, denominator: denominator / divisor }; }
function gcd(left: number, right: number): number { let a = Math.abs(left), b = Math.abs(right); while (b !== 0) [a, b] = [b, a % b]; return a || 1; }
function plainObject(value: object): boolean { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null; }
function issue(path: string, code: string, message: string, issues: RenderDeliveryIssue[]): void { issues.push({ path, code, message }); }
function failure(issues: RenderDeliveryIssue[]): RenderDeliveryDescription { return { ok: false, issues: Object.freeze([...issues]) }; }
function freeze<T>(value: T): T { if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) freeze(child); } return value; }
