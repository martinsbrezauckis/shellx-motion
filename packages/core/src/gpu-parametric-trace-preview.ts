import { createHash } from "node:crypto";
import { canonicalJsonSha256 } from "./canonical-json";
import { compileMotionParametricTracePlan } from "./motion-parametric-trace-plan";
import { MAX_MOTION_PARAMETRIC_TRACE_COORDINATE, type MotionParametricTracePlan, type MotionParametricTraceSample } from "./motion-parametric-trace-types";
import type { MotionDocument } from "./types";

export const GPU_PARAMETRIC_TRACE_PREVIEW_STATIC_SCHEMA = "shellx-motion/gpu-parametric-trace-preview-static@1" as const;
export const GPU_PARAMETRIC_TRACE_PREVIEW_FRAME_SCHEMA = "shellx-motion/gpu-parametric-trace-preview-frame@1" as const;
/** Fixed packed attributes; Browser may upload/draw these bytes but never derives them. */
export const GPU_PARAMETRIC_TRACE_VERTEX_ABI = "shellx-motion/gpu-parametric-trace-vertices@2" as const;
export const GPU_PARAMETRIC_TRACE_SIGNAL_INTERPOLATION = "linear-clamped-q6@1" as const;
export const GPU_PARAMETRIC_TRACE_COLOUR_MAPPING = "normalized-grayscale-srgb@1" as const;
export const GPU_PARAMETRIC_TRACE_TESSELLATION = "center-ribbon-tube-ring8@1" as const;
export const GPU_PARAMETRIC_TRACE_WIDTH_ENCODING = "float32-le@1" as const;
/** Fixed non-indexed draw/fetch mapping for every admitted source mode. */
export const GPU_PARAMETRIC_TRACE_TOPOLOGY_ABI = "fixed-vertex-fetch-topology@1" as const;
export const GPU_PARAMETRIC_TRACE_VERTEX_STRIDE_BYTES = 20;

export type GpuParametricTracePreviewFailure = { code: "gpu_invalid_time" | "gpu_resource_refused" | "gpu_unsupported_feature"; message: string };
export interface GpuParametricTracePreviewStaticPlan {
  schema: typeof GPU_PARAMETRIC_TRACE_PREVIEW_STATIC_SCHEMA;
  documentFingerprint: string;
  traceSourceSha256: string;
  tracePlanFingerprint: string;
  scheduleSha256: string;
  vertexAbi: typeof GPU_PARAMETRIC_TRACE_VERTEX_ABI;
  signalInterpolation: typeof GPU_PARAMETRIC_TRACE_SIGNAL_INTERPOLATION;
  colourMapping: typeof GPU_PARAMETRIC_TRACE_COLOUR_MAPPING;
  tessellation: typeof GPU_PARAMETRIC_TRACE_TESSELLATION;
  widthEncoding: typeof GPU_PARAMETRIC_TRACE_WIDTH_ENCODING;
  topologyAbi: typeof GPU_PARAMETRIC_TRACE_TOPOLOGY_ABI;
  fingerprint: string;
}
export interface GpuParametricTracePreviewDrawerFrame {
  drawerId: string;
  mode: "line" | "ribbon" | "tube" | "points";
  window: { atUs: number; firstSampleIndex: number; sampleCount: number; vertexCount: number; workUnits: number; bytes: number; fingerprint: string };
  sampleSliceSha256: string;
  vertexBufferSha256: string;
  vertexByteLength: number;
  topology: {
    primitive: "point-list" | "line-strip" | "triangle-strip" | "triangle-list";
    bufferBinding: { slot: 0; strideBytes: typeof GPU_PARAMETRIC_TRACE_VERTEX_STRIDE_BYTES };
    fetch: "sequential-sample@1" | "sequential-ribbon-pairs@1" | "ring8-segment-vertex-fetch@1";
    ringVertices: 0 | 8;
    segmentVertexInvocations: 0 | 48;
    drawVertexInvocations: number;
    workUnits: number;
    fingerprint: string;
  };
}
export interface GpuParametricTracePreviewFramePlan {
  schema: typeof GPU_PARAMETRIC_TRACE_PREVIEW_FRAME_SCHEMA;
  staticFingerprint: string;
  atUs: number;
  vertexAbi: typeof GPU_PARAMETRIC_TRACE_VERTEX_ABI;
  topologyAbi: typeof GPU_PARAMETRIC_TRACE_TOPOLOGY_ABI;
  drawers: readonly GpuParametricTracePreviewDrawerFrame[];
  budget: { samples: number; vertices: number; windowWorkUnits: number; topologyWorkUnits: number; combinedWorkUnits: number; drawVertexInvocations: number; selectedWindowBytes: number; packedVertexBytes: number; storageBytes: number; combinedPeakBytes: number; fingerprint: string };
  fingerprint: string;
}
export type GpuParametricTracePreviewStaticResult = { ok: true; plan: GpuParametricTracePreviewStaticPlan } | { ok: false; failure: GpuParametricTracePreviewFailure };
export type GpuParametricTracePreviewFrameResult = { ok: true; plan: GpuParametricTracePreviewFramePlan } | { ok: false; failure: GpuParametricTracePreviewFailure };
export type GpuParametricTracePreviewFreshnessResult = { ok: true } | { ok: false; failure: GpuParametricTracePreviewFailure };
export interface GpuParametricTracePreviewUpload { frame: GpuParametricTracePreviewFramePlan; drawers: readonly { drawerId: string; vertexBytes: Uint8Array }[] }

type StaticState = { documentFingerprint: string; trace: MotionParametricTracePlan };
type FrameState = { issuingStaticPlan: object; bytes: readonly { drawerId: string; vertexBytes: Buffer }[] };
const staticStates = new WeakMap<object, StaticState>();
const frameStates = new WeakMap<object, FrameState>();

/** Direct-import-only source authority. It compiles C4C once and never writes a MotionDocument root. */
export function compileGpuParametricTracePreviewStaticPlan(motion: MotionDocument, descriptor: unknown): GpuParametricTracePreviewStaticResult {
  try {
    const compiled = compileMotionParametricTracePlan(descriptor, { motion });
    if (!compiled.ok) return fail("gpu_unsupported_feature", compiled.message);
    return compileGpuParametricTracePreviewStaticPlanFromCompiledTrace(motion, compiled.plan);
  } catch (error) {
    return fail("gpu_unsupported_feature", error instanceof Error ? error.message : "GPU parametric trace preview static admission refused.");
  }
}

/**
 * Internal bridge for a higher-level closed profile that has already validated a compiled C4C
 * plan. It remains package-internal: callers do not receive a descriptor route from this helper.
 */
export function compileGpuParametricTracePreviewStaticPlanFromCompiledTrace(motion: MotionDocument, trace: MotionParametricTracePlan): GpuParametricTracePreviewStaticResult {
  try {
    if (motion.assets.length > 0) return fail("gpu_resource_refused", "GPU parametric trace preview refuses Motion document resources before renderer allocation.");
    const durationUs = motion.durationMs * 1_000;
    if (!Number.isSafeInteger(durationUs) || trace.schedule.at(-1)! > durationUs) return fail("gpu_unsupported_feature", "GPU parametric trace preview requires the admitted trace clip to fit its Motion authority duration.");
    const documentFingerprint = canonicalJsonSha256(motion);
    const payload = {
      schema: GPU_PARAMETRIC_TRACE_PREVIEW_STATIC_SCHEMA,
      documentFingerprint,
      traceSourceSha256: trace.sourceSha256,
      tracePlanFingerprint: trace.fingerprint,
      scheduleSha256: trace.evidence.scheduleSha256,
      vertexAbi: GPU_PARAMETRIC_TRACE_VERTEX_ABI,
      signalInterpolation: GPU_PARAMETRIC_TRACE_SIGNAL_INTERPOLATION,
      colourMapping: GPU_PARAMETRIC_TRACE_COLOUR_MAPPING,
      tessellation: GPU_PARAMETRIC_TRACE_TESSELLATION,
      widthEncoding: GPU_PARAMETRIC_TRACE_WIDTH_ENCODING,
      topologyAbi: GPU_PARAMETRIC_TRACE_TOPOLOGY_ABI,
    };
    const plan = freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
    staticStates.set(plan, { documentFingerprint, trace });
    return { ok: true, plan };
  } catch (error) {
    return fail("gpu_unsupported_feature", error instanceof Error ? error.message : "GPU parametric trace preview static admission refused.");
  }
}

/** Selects exactly one retained C4C window and attributes it once before Browser resources exist. */
export function compileGpuParametricTracePreviewFramePlan(motion: MotionDocument, staticPlan: GpuParametricTracePreviewStaticPlan, atUs: number): GpuParametricTracePreviewFrameResult {
  if (!validRootAtUs(motion, atUs)) return fail("gpu_invalid_time", "GPU parametric trace preview requires a safe integer root atUs within the Motion authority duration.");
  try {
    const state = staticStates.get(staticPlan as unknown as object);
    if (!state) return fail("gpu_resource_refused", "GPU parametric trace preview requires an exact Core-issued static execution wrapper.");
    if (state.documentFingerprint !== canonicalJsonSha256(motion)) return fail("gpu_resource_refused", "GPU parametric trace preview static execution wrapper is stale for this Motion authority.");
    const scheduleIndex = state.trace.schedule.indexOf(atUs);
    if (scheduleIndex < 0) return fail("gpu_invalid_time", "GPU parametric trace preview atUs must be one admitted exact schedule point.");
    const selected = state.trace.drawers.map((drawer) => preflightDrawer(drawer, scheduleIndex, state.trace.budget.limits.perDrawer));
    const totals = selected.reduce((total, item) => ({ samples: total.samples + item.window.sampleCount, vertices: total.vertices + item.window.vertexCount, windowWorkUnits: total.windowWorkUnits + item.window.workUnits, topologyWorkUnits: total.topologyWorkUnits + item.topology.workUnits, invocations: total.invocations + item.topology.drawVertexInvocations, bytes: total.bytes + item.window.bytes, packed: total.packed + item.packedVertexBytes }), { samples: 0, vertices: 0, windowWorkUnits: 0, topologyWorkUnits: 0, invocations: 0, bytes: 0, packed: 0 });
    const limits = state.trace.budget.limits.aggregate;
    const combinedWorkUnits = totals.windowWorkUnits + totals.topologyWorkUnits;
    if (totals.samples > limits.maxSamples || totals.vertices > limits.maxVertices || combinedWorkUnits > limits.maxWorkUnits || state.trace.budget.storageBytes + totals.bytes > limits.maxBytes) return fail("gpu_resource_refused", "GPU parametric trace preview selected window plus fixed topology exceeds its admitted aggregate C4C cap.");
    if (totals.bytes > state.trace.budget.maxFrameBytes || state.trace.budget.storageBytes + totals.bytes > state.trace.budget.peakBytes || totals.packed > totals.bytes) return fail("gpu_resource_refused", "GPU parametric trace preview selected window does not match its admitted frame or combined-peak budget.");
    const packed = selected.map((item) => {
      const samples = item.drawer.samples.slice(item.window.firstSampleIndex, item.window.firstSampleIndex + item.window.sampleCount);
      const vertexBytes = packVertices(item.drawer, samples);
      if (vertexBytes.length !== item.packedVertexBytes) throw new Error(`Parametric trace drawer ${item.drawer.id} vertex ABI packing did not match its admitted retained window.`);
      return { ...item, samples, vertexBytes };
    });
    const drawers = packed.map((item) => freeze({
      drawerId: item.drawer.id,
      mode: item.drawer.output.mode,
      window: { ...item.window, fingerprint: canonicalJsonSha256(item.window) },
      sampleSliceSha256: canonicalJsonSha256(item.samples),
      vertexBufferSha256: sha256(item.vertexBytes),
      vertexByteLength: item.vertexBytes.length,
      topology: { ...item.topology, fingerprint: canonicalJsonSha256(item.topology) },
    }));
    const budgetPayload = { samples: totals.samples, vertices: totals.vertices, windowWorkUnits: totals.windowWorkUnits, topologyWorkUnits: totals.topologyWorkUnits, combinedWorkUnits, drawVertexInvocations: totals.invocations, selectedWindowBytes: totals.bytes, packedVertexBytes: totals.packed, storageBytes: state.trace.budget.storageBytes, combinedPeakBytes: state.trace.budget.storageBytes + totals.bytes };
    const budget = freeze({ ...budgetPayload, fingerprint: canonicalJsonSha256(budgetPayload) });
    const payload = { schema: GPU_PARAMETRIC_TRACE_PREVIEW_FRAME_SCHEMA, staticFingerprint: staticPlan.fingerprint, atUs, vertexAbi: GPU_PARAMETRIC_TRACE_VERTEX_ABI, topologyAbi: GPU_PARAMETRIC_TRACE_TOPOLOGY_ABI, drawers, budget };
    const plan = freeze({ ...payload, drawers: Object.freeze(drawers), fingerprint: canonicalJsonSha256(payload) });
    frameStates.set(plan, { issuingStaticPlan: staticPlan as unknown as object, bytes: packed.map((item) => ({ drawerId: item.drawer.id, vertexBytes: Buffer.from(item.vertexBytes) })) });
    return { ok: true, plan };
  } catch (error) {
    return fail("gpu_unsupported_feature", error instanceof Error ? error.message : "GPU parametric trace preview frame admission refused.");
  }
}

/** Rechecks the non-serializable Core authority after an async boundary; serialized hashes are insufficient. */
export function checkGpuParametricTracePreviewStaticFreshness(motion: MotionDocument, staticPlan: GpuParametricTracePreviewStaticPlan): GpuParametricTracePreviewFreshnessResult {
  const state = staticStates.get(staticPlan as unknown as object);
  if (!state) return fail("gpu_resource_refused", "GPU parametric trace preview requires an exact Core-issued static execution wrapper.");
  if (state.documentFingerprint !== canonicalJsonSha256(motion)) return fail("gpu_resource_refused", "GPU parametric trace preview static execution wrapper is stale for this Motion authority.");
  return { ok: true };
}

/** Returns copy-only, fixed-stride upload bytes for an exact Core-issued frame wrapper. */
export function readGpuParametricTracePreviewUpload(staticPlan: GpuParametricTracePreviewStaticPlan, framePlan: GpuParametricTracePreviewFramePlan): GpuParametricTracePreviewUpload {
  const staticState = staticStates.get(staticPlan as unknown as object), state = frameStates.get(framePlan as unknown as object);
  if (!staticState || !state || state.issuingStaticPlan !== staticPlan || framePlan.staticFingerprint !== staticPlan.fingerprint) throw new Error("GPU parametric trace preview requires matching exact Core-issued static and frame execution wrappers.");
  return Object.freeze({ frame: framePlan, drawers: Object.freeze(state.bytes.map((item) => Object.freeze({ drawerId: item.drawerId, vertexBytes: Uint8Array.from(item.vertexBytes) }))) });
}

function preflightDrawer(drawer: MotionParametricTracePlan["drawers"][number], scheduleIndex: number, limits: MotionParametricTracePlan["budget"]["limits"]["perDrawer"]) {
  const window = drawer.windows[scheduleIndex];
  if (!window || window.atUs !== drawer.samples[scheduleIndex]?.atUs) throw new Error(`Parametric trace drawer ${drawer.id} has no retained window at the admitted schedule point.`);
  const lastSampleIndex = window.firstSampleIndex + window.sampleCount - 1;
  if (!Number.isSafeInteger(window.firstSampleIndex) || !Number.isSafeInteger(window.sampleCount) || window.firstSampleIndex < 0 || window.sampleCount < 1 || lastSampleIndex >= drawer.samples.length || drawer.samples[lastSampleIndex]?.atUs !== window.atUs || vertexCount(drawer.output.mode, window.sampleCount) !== window.vertexCount) throw new Error(`Parametric trace drawer ${drawer.id} retained slice does not match its admitted window.`);
  if (window.sampleCount > drawer.budget.samples || window.vertexCount > drawer.budget.maxVertices || window.workUnits > drawer.budget.maxWorkUnits || window.bytes > drawer.budget.maxFrameBytes || drawer.budget.dataBytes + window.bytes > drawer.budget.peakBytes) throw new Error(`Parametric trace drawer ${drawer.id} selected window exceeds its admitted C4C budget.`);
  const topology = topologyFor(drawer.output.mode, window.sampleCount), packedVertexBytes = window.vertexCount * GPU_PARAMETRIC_TRACE_VERTEX_STRIDE_BYTES;
  if (!Number.isSafeInteger(packedVertexBytes) || packedVertexBytes > window.bytes) throw new Error(`Parametric trace drawer ${drawer.id} vertex ABI bytes exceed its admitted retained window.`);
  if (window.workUnits + topology.workUnits > limits.maxWorkUnits) throw new Error(`Parametric trace drawer ${drawer.id} topology work exceeds its admitted C4C cap.`);
  return { drawer, window, topology, packedVertexBytes };
}

function packVertices(drawer: MotionParametricTracePlan["drawers"][number], samples: readonly MotionParametricTraceSample[]): Buffer {
  const bytes = Buffer.alloc(vertexCount(drawer.output.mode, samples.length) * GPU_PARAMETRIC_TRACE_VERTEX_STRIDE_BYTES);
  let offset = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]!;
    const attribute = attributes(drawer, samples, index);
    const positions = vertices(drawer.output.mode, samples, index, attribute.width);
    for (const position of positions) {
      assertPosition(position);
      bytes.writeFloatLE(position.x, offset); bytes.writeFloatLE(position.y, offset + 4); bytes.writeFloatLE(position.z, offset + 8);
      bytes.writeFloatLE(attribute.width, offset + 12); bytes.writeUInt8(Math.round(attribute.colour * 255), offset + 16); bytes.writeUInt8(Math.round(attribute.opacity * 255), offset + 17); offset += GPU_PARAMETRIC_TRACE_VERTEX_STRIDE_BYTES;
    }
  }
  return bytes;
}

function attributes(drawer: MotionParametricTracePlan["drawers"][number], samples: readonly MotionParametricTraceSample[], index: number) {
  const age = samples.length <= 1 ? 0 : (samples.length - 1 - index) / (samples.length - 1);
  const source = { age, speed: samples[index]!.speed, drawer: drawer.signalDomain.drawer };
  return {
    width: signal(drawer.output.width, source, MAX_MOTION_PARAMETRIC_TRACE_COORDINATE),
    colour: signal(drawer.output.colour, source, 1),
    opacity: signal(drawer.output.opacity, source, 1),
  };
}

function signal(value: MotionParametricTracePlan["drawers"][number]["output"]["width"], source: { age: number; speed: number; drawer: number }, maximum: number): number {
  const unit = value.source === "constant" ? 0 : source[value.source];
  const result = q6(value.from + (value.to - value.from) * unit);
  return Math.min(maximum, Math.max(0, result));
}

function vertices(mode: MotionParametricTracePlan["drawers"][number]["output"]["mode"], samples: readonly MotionParametricTraceSample[], index: number, width: number) {
  const point = samples[index]!.position;
  if (mode === "line" || mode === "points") return [point];
  const tangent = tangentAt(samples, index), basis = basisFor(tangent), radius = width / 2;
  if (mode === "ribbon") return [offset(point, basis.side, radius), offset(point, basis.side, -radius)];
  return [0, 1, 2, 3, 4, 5, 6, 7].map((step) => offset(point, add(scale(basis.side, RING_COS[step]!), scale(basis.up, RING_SIN[step]!)), radius));
}

const RING_COS = [1, Math.SQRT1_2, 0, -Math.SQRT1_2, -1, -Math.SQRT1_2, 0, Math.SQRT1_2] as const;
const RING_SIN = [0, Math.SQRT1_2, 1, Math.SQRT1_2, 0, -Math.SQRT1_2, -1, -Math.SQRT1_2] as const;
function tangentAt(samples: readonly MotionParametricTraceSample[], index: number) { const left = samples[Math.max(0, index - 1)]!.position, right = samples[Math.min(samples.length - 1, index + 1)]!.position; return normalize({ x: right.x - left.x, y: right.y - left.y, z: right.z - left.z }) ?? { x: 1, y: 0, z: 0 }; }
function basisFor(tangent: { x: number; y: number; z: number }) { const reference = Math.abs(tangent.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 }; const side = normalize(cross(tangent, reference)); if (!side) throw new Error("Parametric trace tessellation could not select a fixed tangent basis."); return { side, up: cross(side, tangent) }; }
function cross(left: { x: number; y: number; z: number }, right: { x: number; y: number; z: number }) { return { x: left.y * right.z - left.z * right.y, y: left.z * right.x - left.x * right.z, z: left.x * right.y - left.y * right.x }; }
function normalize(value: { x: number; y: number; z: number }) { const length = Math.hypot(value.x, value.y, value.z); return length > 0 && Number.isFinite(length) ? scale(value, 1 / length) : undefined; }
function add(left: { x: number; y: number; z: number }, right: { x: number; y: number; z: number }) { return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z }; }
function scale(value: { x: number; y: number; z: number }, amount: number) { return { x: value.x * amount, y: value.y * amount, z: value.z * amount }; }
function offset(point: { x: number; y: number; z: number }, direction: { x: number; y: number; z: number }, amount: number) { return add(point, scale(direction, amount)); }
function assertPosition(value: { x: number; y: number; z: number }): void { if (![value.x, value.y, value.z].every((item) => Number.isFinite(item) && Math.abs(item) <= MAX_MOTION_PARAMETRIC_TRACE_COORDINATE)) throw new Error("Parametric trace tessellation exceeds the admitted coordinate cap."); }
function topologyFor(mode: MotionParametricTracePlan["drawers"][number]["output"]["mode"], samples: number) {
  const bufferBinding = { slot: 0, strideBytes: GPU_PARAMETRIC_TRACE_VERTEX_STRIDE_BYTES } as const;
  if (mode === "points") return { primitive: "point-list" as const, bufferBinding, fetch: "sequential-sample@1" as const, ringVertices: 0 as const, segmentVertexInvocations: 0 as const, drawVertexInvocations: samples, workUnits: samples };
  if (mode === "line") return { primitive: "line-strip" as const, bufferBinding, fetch: "sequential-sample@1" as const, ringVertices: 0 as const, segmentVertexInvocations: 0 as const, drawVertexInvocations: samples, workUnits: samples };
  if (mode === "ribbon") return { primitive: "triangle-strip" as const, bufferBinding, fetch: "sequential-ribbon-pairs@1" as const, ringVertices: 0 as const, segmentVertexInvocations: 0 as const, drawVertexInvocations: samples * 2, workUnits: samples * 2 };
  // For vertex index i: segment=floor(i/48), face=floor((i%48)/6), corner=i%6.
  // Corners fetch [ring0.face, ring1.face, ring1.next, ring0.face, ring1.next, ring0.next].
  const drawVertexInvocations = Math.max(0, samples - 1) * 48;
  return { primitive: "triangle-list" as const, bufferBinding, fetch: "ring8-segment-vertex-fetch@1" as const, ringVertices: 8 as const, segmentVertexInvocations: 48 as const, drawVertexInvocations, workUnits: drawVertexInvocations };
}
function vertexCount(mode: MotionParametricTracePlan["drawers"][number]["output"]["mode"], samples: number): number { return samples * (mode === "ribbon" ? 2 : mode === "tube" ? 8 : 1); }
function validRootAtUs(motion: MotionDocument, atUs: number): boolean { const durationUs = motion.durationMs * 1_000; return Number.isSafeInteger(atUs) && atUs >= 0 && Number.isSafeInteger(durationUs) && atUs <= durationUs; }
function q6(value: number): number { const result = Math.round(value * 1_000_000) / 1_000_000; return Object.is(result, -0) ? 0 : result; }
function sha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function fail(code: GpuParametricTracePreviewFailure["code"], message: string): { ok: false; failure: GpuParametricTracePreviewFailure } { return { ok: false, failure: { code, message } }; }
function freeze<T>(value: T, seen = new WeakSet<object>()): T { if (!value || typeof value !== "object" || seen.has(value)) return value; seen.add(value); for (const child of Object.values(value as Record<string, unknown>)) freeze(child, seen); return Object.freeze(value); }
