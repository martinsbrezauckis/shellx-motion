import { canonicalJsonSha256 } from "./canonical-json";
import type { MotionKeyframe, OperationReceipt } from "./types";

export const TRACKING_ANALYSIS_SCHEMA = "shellx-motion/tracking-analysis@1" as const;
export const TRACKING_LIFECYCLE_SCHEMA = "shellx-motion/tracking-lifecycle@1" as const;
export const STABILIZATION_PLAN_SCHEMA = "shellx-motion/stabilization-plan@1" as const;
export const MAX_TRACKING_SAMPLES = 30_000;
export const MAX_TRACKING_SPANS = 4_096;
export const MAX_TRACKING_REFERENCE_POINTS = 64;
export const MAX_TRACKING_MATRIX_ABS_VALUE = 1_000_000;
export const MAX_TRACKING_PERSPECTIVE_TERM = 0.1;

export type TrackingMatrix3 = [number, number, number, number, number, number, number, number, number];
export type TrackingAnalysisMode = "point" | "planar";
export type TrackingTransformModel = "translation" | "similarity" | "homography";
export type TrackingSampleState = "tracked" | "low-confidence" | "lost" | "recovered";
export type TrackingSpanState = "low-confidence" | "lost" | "recovered";

export interface TrackingSourceIdentity {
  assetId: string;
  sha256: string;
  byteLength: number;
  width: number;
  height: number;
  durationMs: number;
}

export interface TrackingAnalysisSettings {
  startMs: number;
  endMs: number;
  stepMs: number;
  direction: "forward" | "backward" | "both";
  searchRadiusPx: number;
  /**
   * Coarse-to-fine search depth. 1 = a single exhaustive search at full resolution. Higher values
   * search a 2x-downsampled pyramid from the top down, which covers the same `searchRadiusPx` for a
   * fraction of the work — the control that decides whether a large radius fits the solver's
   * operation budget at all. Honoured by `solveFixedTrackingAnalysis`.
   */
  pyramidLevels: number;
  /**
   * Maximum re-centred search steps per pyramid level. 1 = one window, exactly where the previous
   * level put it. Higher values let the match walk down the SAD gradient beyond one window, so a
   * displacement larger than `searchRadiusPx` can still be found on textured footage. Honoured by
   * `solveFixedTrackingAnalysis`.
   */
  maxIterations: number;
  confidenceFloor: number;
  /**
   * Reserved. `solveFixedTrackingAnalysis` consumes NO entropy — its search is exhaustive and
   * fully ordered — so this value cannot change its result, and the solver says so rather than
   * pretending otherwise: see {@link unsupportedTrackingSettings}, which drives an explicit warning
   * on every receipt built by {@link createTrackingOperationReceipt}. It is still part of
   * `settingsSha256` because that hash identifies the REQUEST, not the result.
   */
  deterministicSeed: number;
}

/** One accepted-but-inert setting, named with the reason it cannot change the result. */
export interface UnsupportedTrackingSetting {
  setting: keyof TrackingAnalysisSettings;
  value: number | string;
  reason: string;
}

/**
 * Report which settings the bundled fixed-patch solver accepts, validates, and hashes but cannot
 * act on.
 *
 * Why this exists: a control that is validated and documented but ignored teaches the caller
 * something false — they tune it, nothing moves, and no error ever says why. Reporting it is the
 * honest floor; a typed refusal is impossible here because `deterministicSeed` is REQUIRED by
 * `shellx-motion/tracking-analysis@1`, so no caller can omit it.
 *
 * @param settings the requested settings.
 * @returns one entry per inert setting; empty when every setting reaches the solver.
 */
export function unsupportedTrackingSettings(settings: TrackingAnalysisSettings): UnsupportedTrackingSetting[] {
  const unsupported: UnsupportedTrackingSetting[] = [];
  if (settings.deterministicSeed !== 0) {
    unsupported.push({
      setting: "deterministicSeed",
      value: settings.deterministicSeed,
      reason: "The bundled fixed-patch solver is exhaustive and consumes no randomness, so no seed can change its result. Results are already reproducible byte for byte without it.",
    });
  }
  return unsupported;
}

/** Receipt-ready sentences for {@link unsupportedTrackingSettings}. */
export function unsupportedTrackingSettingWarnings(settings: TrackingAnalysisSettings): string[] {
  return unsupportedTrackingSettings(settings).map(
    (entry) => `Tracking setting ${String(entry.setting)}=${String(entry.value)} was accepted and hashed into settingsSha256 but did not affect the result. ${entry.reason}`
  );
}

export interface TrackingAnalysisSample {
  atMs: number;
  state: TrackingSampleState;
  confidence: number;
  residualErrorPx?: number;
  /** Row-major transform mapping reference-frame pixels into this sample. Absent when state is lost. */
  matrix?: TrackingMatrix3;
}

export interface TrackingAnalysisSpan {
  startMs: number;
  endMs: number;
  state: TrackingSpanState;
  minConfidence: number;
  maxResidualErrorPx?: number;
}

export interface TrackingAnalysis {
  schema: typeof TRACKING_ANALYSIS_SCHEMA;
  id: string;
  source: TrackingSourceIdentity;
  mode: TrackingAnalysisMode;
  model: TrackingTransformModel;
  status: "succeeded" | "partial";
  reference: {
    atMs: number;
    bounds: { x: number; y: number; width: number; height: number };
    points: Array<{ x: number; y: number }>;
  };
  settings: TrackingAnalysisSettings;
  settingsSha256: string;
  solver: {
    id: string;
    version: string;
    implementationSha256: string;
  };
  samples: TrackingAnalysisSample[];
  spans: TrackingAnalysisSpan[];
  createdAt: string;
}

export type TrackingLifecycleState = "queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled" | "stale";

export interface TrackingAnalysisLifecycle {
  schema: typeof TRACKING_LIFECYCLE_SCHEMA;
  id: string;
  state: TrackingLifecycleState;
  attempt: number;
  requestedSource: TrackingSourceIdentity;
  lastGood?: TrackingAnalysis;
  failure?: { code: string; message: string };
  updatedAt: string;
}

export interface TrackingAnalysisRequest {
  id: string;
  source: TrackingSourceIdentity;
  mode: TrackingAnalysisMode;
  model: TrackingTransformModel;
  reference: TrackingAnalysis["reference"];
  settings: TrackingAnalysisSettings;
}

export interface StabilizationSegment {
  startMs: number;
  endMs: number;
  keyframes: {
    "transform.x": MotionKeyframe[];
    "transform.y": MotionKeyframe[];
    "transform.scale": MotionKeyframe[];
    "transform.rotation": MotionKeyframe[];
  };
}

export interface TrackingStabilizationPlan {
  schema: typeof STABILIZATION_PLAN_SCHEMA;
  analysisId: string;
  sourceSha256: string;
  targetLayerId: string;
  referenceAtMs: number;
  status: "ready" | "partial";
  fidelity: "exact-similarity" | "approximated-homography";
  segments: StabilizationSegment[];
  excludedSpans: TrackingAnalysisSpan[];
  warnings: string[];
}

/**
 * Identity hash of a settings object.
 *
 * Canonical JSON, not `JSON.stringify`: two settings objects carrying identical values in different
 * key insertion order MUST hash the same, and the hash must not depend on the ambient locale used
 * to order those keys. The previous `JSON.stringify` form failed both — a settings object rebuilt
 * field-by-field in a different order produced a different "deterministic" hash.
 *
 * @param settings requested tracking settings.
 * @returns lowercase hex SHA-256 identifying the REQUEST (not the result: see
 *          {@link unsupportedTrackingSettings} for settings that are hashed but inert).
 */
export function trackingSettingsSha256(settings: TrackingAnalysisSettings): string {
  return canonicalJsonSha256(settings);
}

export function validateTrackingAnalysis(value: unknown): string[] {
  const errors: string[] = [];
  const analysis = record(value);
  if (!analysis) return ["tracking analysis must be an object"];
  if (analysis.schema !== TRACKING_ANALYSIS_SCHEMA) errors.push(`schema must equal ${TRACKING_ANALYSIS_SCHEMA}`);
  safeId(analysis.id, "id", errors);
  const source = record(analysis.source);
  if (!source) errors.push("source must be an object");
  else validateSource(source, errors);
  if (!isOneOf(analysis.mode, ["point", "planar"])) errors.push("mode must be point or planar");
  if (!isOneOf(analysis.model, ["translation", "similarity", "homography"])) errors.push("model is unsupported");
  if (analysis.mode === "point" && analysis.model !== "translation") errors.push("point mode requires the translation model");
  if (analysis.mode === "planar" && analysis.model === "translation") errors.push("planar mode requires similarity or homography");
  if (!isOneOf(analysis.status, ["succeeded", "partial"])) errors.push("status must be succeeded or partial");

  const reference = record(analysis.reference);
  if (!reference) errors.push("reference must be an object");
  else validateReference(reference, source, errors);
  const settings = record(analysis.settings);
  if (!settings) errors.push("settings must be an object");
  else validateSettings(settings, source, errors);
  if (typeof analysis.settingsSha256 !== "string" || !SHA256.test(analysis.settingsSha256)) {
    errors.push("settingsSha256 must be a lowercase SHA-256");
  } else if (settings && analysis.settingsSha256 !== trackingSettingsSha256(settings as unknown as TrackingAnalysisSettings)) {
    errors.push("settingsSha256 does not match settings");
  }
  const solver = record(analysis.solver);
  if (!solver) errors.push("solver must be an object");
  else {
    safeId(solver.id, "solver.id", errors);
    boundedString(solver.version, "solver.version", errors, 1, 64);
    if (typeof solver.implementationSha256 !== "string" || !SHA256.test(solver.implementationSha256)) {
      errors.push("solver.implementationSha256 must be a lowercase SHA-256");
    }
  }

  if (!Array.isArray(analysis.samples) || analysis.samples.length < 1 || analysis.samples.length > MAX_TRACKING_SAMPLES) {
    errors.push(`samples must contain 1..${MAX_TRACKING_SAMPLES} entries`);
  } else {
    validateSamples(analysis.samples, settings, analysis.status, errors);
  }
  if (!Array.isArray(analysis.spans) || analysis.spans.length > MAX_TRACKING_SPANS) {
    errors.push(`spans must be an array with at most ${MAX_TRACKING_SPANS} entries`);
  } else {
    validateSpans(analysis.spans, source, errors);
  }
  boundedString(analysis.createdAt, "createdAt", errors, 1, 128);
  return errors;
}

export function assertTrackingAnalysis(value: unknown): asserts value is TrackingAnalysis {
  const errors = validateTrackingAnalysis(value);
  if (errors.length > 0) throw new Error(`Invalid tracking analysis: ${errors.join("; ")}`);
}

/** Validate a tracking request before any bounded media decode or solver work begins. */
export function assertTrackingAnalysisRequest(input: TrackingAnalysisRequest): void {
  const provisional: TrackingAnalysis = {
    schema: TRACKING_ANALYSIS_SCHEMA,
    id: input.id,
    source: structuredClone(input.source),
    mode: input.mode,
    model: input.model,
    status: "succeeded",
    reference: structuredClone(input.reference),
    settings: structuredClone(input.settings),
    settingsSha256: trackingSettingsSha256(input.settings),
    solver: {
      id: "request-preflight",
      version: "1",
      implementationSha256: "0".repeat(64),
    },
    samples: [{
      atMs: input.settings.startMs,
      state: "tracked",
      confidence: 1,
      residualErrorPx: 0,
      matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    }],
    spans: [],
    createdAt: "request-preflight",
  };
  const errors = validateTrackingAnalysis(provisional);
  if (errors.length > 0) throw new Error(`Invalid tracking request: ${errors.join("; ")}`);
}

export function validateTrackingAnalysisLifecycle(value: unknown): string[] {
  const errors: string[] = [];
  const lifecycle = record(value);
  if (!lifecycle) return ["tracking lifecycle must be an object"];
  if (lifecycle.schema !== TRACKING_LIFECYCLE_SCHEMA) errors.push(`schema must equal ${TRACKING_LIFECYCLE_SCHEMA}`);
  safeId(lifecycle.id, "id", errors);
  if (!isOneOf(lifecycle.state, ["queued", "running", "succeeded", "partial", "failed", "cancelled", "stale"])) {
    errors.push("state is unsupported");
  }
  integerRange(lifecycle.attempt, "attempt", errors, 1, 1_000_000);
  const requestedSource = record(lifecycle.requestedSource);
  if (!requestedSource) errors.push("requestedSource must be an object");
  else validateSource(requestedSource, errors);
  const lastGood = lifecycle.lastGood;
  if (lastGood !== undefined) {
    const analysisErrors = validateTrackingAnalysis(lastGood);
    errors.push(...analysisErrors.map((error) => `lastGood.${error}`));
    const analysis = record(lastGood);
    if (analysis && analysis.id !== lifecycle.id) errors.push("lastGood.id must match lifecycle.id");
  }
  const failure = lifecycle.failure;
  if (failure !== undefined) {
    const item = record(failure);
    if (!item) errors.push("failure must be an object");
    else {
      boundedString(item.code, "failure.code", errors, 1, 128);
      boundedString(item.message, "failure.message", errors, 1, 500);
    }
  }
  if (["failed", "cancelled", "stale"].includes(String(lifecycle.state)) && failure === undefined) {
    errors.push(`${String(lifecycle.state)} lifecycle requires failure`);
  }
  if (["queued", "running", "succeeded", "partial"].includes(String(lifecycle.state)) && failure !== undefined) {
    errors.push(`${String(lifecycle.state)} lifecycle must not contain failure`);
  }
  if (["succeeded", "partial"].includes(String(lifecycle.state)) && lastGood === undefined) {
    errors.push(`${String(lifecycle.state)} lifecycle requires lastGood`);
  }
  boundedString(lifecycle.updatedAt, "updatedAt", errors, 1, 128);
  return errors;
}

export function assertTrackingAnalysisLifecycle(value: unknown): asserts value is TrackingAnalysisLifecycle {
  const errors = validateTrackingAnalysisLifecycle(value);
  if (errors.length > 0) throw new Error(`Invalid tracking lifecycle: ${errors.join("; ")}`);
}

export function createTrackingAnalysisLifecycle(input: {
  id: string;
  source: TrackingSourceIdentity;
  now?: string;
}): TrackingAnalysisLifecycle {
  assertSourceIdentity(input.source);
  const errors: string[] = [];
  safeId(input.id, "id", errors);
  if (errors.length > 0) throw new Error(errors.join("; "));
  return {
    schema: TRACKING_LIFECYCLE_SCHEMA,
    id: input.id,
    state: "queued",
    attempt: 1,
    requestedSource: cloneSource(input.source),
    updatedAt: input.now ?? new Date().toISOString(),
  };
}

export function startTrackingAnalysis(lifecycle: TrackingAnalysisLifecycle, now?: string): TrackingAnalysisLifecycle {
  if (!["queued", "failed", "cancelled", "stale"].includes(lifecycle.state)) {
    throw new Error(`Tracking analysis cannot start from ${lifecycle.state}.`);
  }
  return { ...cloneLifecycle(lifecycle), state: "running", failure: undefined, updatedAt: now ?? new Date().toISOString() };
}

export function completeTrackingAnalysis(
  lifecycle: TrackingAnalysisLifecycle,
  analysis: TrackingAnalysis,
  now?: string
): TrackingAnalysisLifecycle {
  if (lifecycle.state !== "running") throw new Error("Tracking analysis can complete only while running.");
  assertTrackingAnalysis(analysis);
  if (lifecycle.id !== analysis.id) throw new Error("Tracking analysis result id does not match the lifecycle id.");
  if (!sameTrackingSource(lifecycle.requestedSource, analysis.source)) {
    throw new Error("Tracking analysis result source does not match the requested source identity.");
  }
  return {
    ...cloneLifecycle(lifecycle),
    state: analysis.status,
    lastGood: structuredClone(analysis),
    failure: undefined,
    updatedAt: now ?? new Date().toISOString(),
  };
}

export function stopTrackingAnalysis(
  lifecycle: TrackingAnalysisLifecycle,
  input: { state: "failed" | "cancelled"; code: string; message: string; now?: string }
): TrackingAnalysisLifecycle {
  if (lifecycle.state !== "running") throw new Error("Tracking analysis can stop only while running.");
  boundedFailure(input.code, input.message);
  return {
    ...cloneLifecycle(lifecycle),
    state: input.state,
    failure: { code: input.code, message: input.message },
    updatedAt: input.now ?? new Date().toISOString(),
  };
}

export function invalidateTrackingAnalysis(
  lifecycle: TrackingAnalysisLifecycle,
  source: TrackingSourceIdentity,
  now?: string
): TrackingAnalysisLifecycle {
  assertSourceIdentity(source);
  if (sameTrackingSource(lifecycle.requestedSource, source)) return cloneLifecycle(lifecycle);
  return {
    ...cloneLifecycle(lifecycle),
    state: "stale",
    requestedSource: cloneSource(source),
    failure: { code: "source_changed", message: "Source media identity changed after the last analysis." },
    updatedAt: now ?? new Date().toISOString(),
  };
}

export function retryTrackingAnalysis(
  lifecycle: TrackingAnalysisLifecycle,
  input: { source?: TrackingSourceIdentity; now?: string } = {}
): TrackingAnalysisLifecycle {
  assertTrackingAnalysisLifecycle(lifecycle);
  if (!["succeeded", "partial", "failed", "cancelled", "stale"].includes(lifecycle.state)) {
    throw new Error(`Tracking analysis cannot retry from ${lifecycle.state}.`);
  }
  const source = input.source ?? lifecycle.requestedSource;
  assertSourceIdentity(source);
  return {
    ...cloneLifecycle(lifecycle),
    state: "queued",
    attempt: lifecycle.attempt + 1,
    requestedSource: cloneSource(source),
    failure: undefined,
    updatedAt: input.now ?? new Date().toISOString(),
  };
}

export function compileTrackingStabilization(input: {
  analysis: TrackingAnalysis;
  targetLayerId: string;
  baseTransform?: { x?: number; y?: number; scale?: number; rotation?: number };
  includeLowConfidence?: boolean;
}): TrackingStabilizationPlan {
  assertTrackingAnalysis(input.analysis);
  const targetErrors: string[] = [];
  safeId(input.targetLayerId, "targetLayerId", targetErrors);
  if (targetErrors.length > 0) throw new Error(targetErrors.join("; "));
  const base = {
    x: finiteOr(input.baseTransform?.x, 0),
    y: finiteOr(input.baseTransform?.y, 0),
    scale: finiteOr(input.baseTransform?.scale, 1),
    rotation: finiteOr(input.baseTransform?.rotation, 0),
  };
  const anchor = {
    x: input.analysis.reference.bounds.x + input.analysis.reference.bounds.width / 2,
    y: input.analysis.reference.bounds.y + input.analysis.reference.bounds.height / 2,
  };
  const accepted = (sample: TrackingAnalysisSample) => sample.matrix !== undefined
    && sample.state !== "lost"
    && (input.includeLowConfidence === true || sample.state !== "low-confidence");
  const groups: TrackingAnalysisSample[][] = [];
  let group: TrackingAnalysisSample[] = [];
  for (const sample of input.analysis.samples) {
    if (!accepted(sample)) {
      if (group.length > 0) groups.push(group);
      group = [];
      continue;
    }
    if (sample.state === "recovered" && group.length > 0) {
      groups.push(group);
      group = [];
    }
    group.push(sample);
  }
  if (group.length > 0) groups.push(group);

  const segments = groups.map((samples) => stabilizationSegment(samples, anchor, base));
  if (segments.length === 0) throw new Error("Tracking analysis has no confidence-qualified samples to stabilize.");
  const excludedSpans = input.analysis.spans.filter((span) => span.state === "lost" || (
    span.state === "low-confidence" && input.includeLowConfidence !== true
  )).map((span) => ({ ...span }));
  const approximated = input.analysis.model === "homography";
  return {
    schema: STABILIZATION_PLAN_SCHEMA,
    analysisId: input.analysis.id,
    sourceSha256: input.analysis.source.sha256,
    targetLayerId: input.targetLayerId,
    referenceAtMs: input.analysis.reference.atMs,
    status: input.analysis.status === "partial" || excludedSpans.length > 0 ? "partial" : "ready",
    fidelity: approximated ? "approximated-homography" : "exact-similarity",
    segments,
    excludedSpans,
    warnings: [
      ...(approximated ? ["Homography stabilization is locally approximated as position, uniform scale, and rotation at the reference bounds center."] : []),
      ...(excludedSpans.length > 0 ? ["Lost or low-confidence spans remain explicit segment gaps and are not interpolated."] : []),
    ],
  };
}

export function createTrackingOperationReceipt(input: {
  operation: "analysis.tracking.request" | "analysis.tracking.inspect" | "analysis.tracking.apply" | "analysis.tracking.detach" | "analysis.tracking.verify";
  packageId: string;
  lifecycle: TrackingAnalysisLifecycle;
  output?: unknown;
  status?: OperationReceipt["status"];
  warnings?: string[];
  now?: string;
}): OperationReceipt {
  // Canonical JSON: the receipt id and inputHashes.lifecycle are content addresses. Under
  // JSON.stringify they moved with the key insertion order of whatever built the lifecycle object.
  const hash = canonicalJsonSha256({ operation: input.operation, lifecycle: input.lifecycle, output: input.output ?? null });
  const failed = input.lifecycle.state === "failed" || input.lifecycle.state === "cancelled";
  const warning = input.lifecycle.state === "partial" || input.lifecycle.state === "stale";
  // Tell the caller, on the evidence artifact itself, about any setting that was accepted,
  // validated, and hashed but could not reach the solver. Without this the caller tunes a control
  // that does nothing and is never told.
  const inertSettings = input.lifecycle.lastGood
    ? unsupportedTrackingSettingWarnings(input.lifecycle.lastGood.settings)
    : [];
  return {
    schema: "shellx-motion/receipt@1",
    id: `tracking-${hash.slice(0, 16)}`,
    operation: input.operation,
    status: input.status ?? (failed ? "failed" : warning ? "warning" : "passed"),
    packageId: input.packageId,
    inputHashes: {
      source: input.lifecycle.requestedSource.sha256,
      lifecycle: hash,
    },
    createdAt: input.now ?? new Date().toISOString(),
    lane: "analysis",
    output: input.output ?? input.lifecycle,
    warnings: [
      ...(input.lifecycle.state === "stale" ? ["Tracking analysis is stale for the current source identity."] : []),
      ...(input.lifecycle.state === "partial" ? ["Tracking analysis contains explicit low-confidence or lost spans."] : []),
      ...inertSettings,
      ...(input.warnings ?? []),
    ],
  };
}

export function sameTrackingSource(left: TrackingSourceIdentity, right: TrackingSourceIdentity): boolean {
  return left.assetId === right.assetId
    && left.sha256 === right.sha256
    && left.byteLength === right.byteLength
    && left.width === right.width
    && left.height === right.height
    && left.durationMs === right.durationMs;
}

function stabilizationSegment(
  samples: TrackingAnalysisSample[],
  anchor: { x: number; y: number },
  base: { x: number; y: number; scale: number; rotation: number }
): StabilizationSegment {
  const keyframes: StabilizationSegment["keyframes"] = {
    "transform.x": [],
    "transform.y": [],
    "transform.scale": [],
    "transform.rotation": [],
  };
  for (const sample of samples) {
    const inverse = invertMatrix3(sample.matrix!);
    const decomposition = decomposeMatrixAt(inverse, anchor);
    keyframes["transform.x"].push({ atMs: sample.atMs, value: round(base.x + decomposition.x), easing: "linear" });
    keyframes["transform.y"].push({ atMs: sample.atMs, value: round(base.y + decomposition.y), easing: "linear" });
    keyframes["transform.scale"].push({ atMs: sample.atMs, value: round(base.scale * decomposition.scale), easing: "linear" });
    keyframes["transform.rotation"].push({ atMs: sample.atMs, value: round(base.rotation + decomposition.rotationDeg), easing: "linear" });
  }
  return {
    startMs: samples[0].atMs,
    endMs: samples[samples.length - 1].atMs,
    keyframes,
  };
}

function invertMatrix3(matrix: TrackingMatrix3): TrackingMatrix3 {
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) throw new Error("Tracking matrix is singular.");
  const inverse: TrackingMatrix3 = [
    e * i - f * h, c * h - b * i, b * f - c * e,
    f * g - d * i, a * i - c * g, c * d - a * f,
    d * h - e * g, b * g - a * h, a * e - b * d,
  ];
  return inverse.map((value) => value / determinant) as TrackingMatrix3;
}

function decomposeMatrixAt(matrix: TrackingMatrix3, anchor: { x: number; y: number }) {
  const center = projectPoint(matrix, anchor.x, anchor.y);
  const dx = projectPoint(matrix, anchor.x + 1, anchor.y);
  const dy = projectPoint(matrix, anchor.x, anchor.y + 1);
  const xAxis = { x: dx.x - center.x, y: dx.y - center.y };
  const yAxis = { x: dy.x - center.x, y: dy.y - center.y };
  const scale = (Math.hypot(xAxis.x, xAxis.y) + Math.hypot(yAxis.x, yAxis.y)) / 2;
  return {
    x: center.x - anchor.x,
    y: center.y - anchor.y,
    scale,
    rotationDeg: Math.atan2(xAxis.y, xAxis.x) * 180 / Math.PI,
  };
}

function projectPoint(matrix: TrackingMatrix3, x: number, y: number) {
  const denominator = matrix[6] * x + matrix[7] * y + matrix[8];
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-12) throw new Error("Tracking matrix projects through infinity.");
  return {
    x: (matrix[0] * x + matrix[1] * y + matrix[2]) / denominator,
    y: (matrix[3] * x + matrix[4] * y + matrix[5]) / denominator,
  };
}

function validateSource(source: Record<string, unknown>, errors: string[]) {
  safeId(source.assetId, "source.assetId", errors);
  if (typeof source.sha256 !== "string" || !SHA256.test(source.sha256)) errors.push("source.sha256 must be a lowercase SHA-256");
  integerRange(source.byteLength, "source.byteLength", errors, 1, 2 ** 53 - 1);
  integerRange(source.width, "source.width", errors, 1, 7_680);
  integerRange(source.height, "source.height", errors, 1, 7_680);
  finiteRange(source.durationMs, "source.durationMs", errors, Number.EPSILON, 86_400_000);
}

function validateReference(reference: Record<string, unknown>, source: Record<string, unknown> | null, errors: string[]) {
  finiteRange(reference.atMs, "reference.atMs", errors, 0, finiteOr(source?.durationMs, 86_400_000));
  const bounds = record(reference.bounds);
  if (!bounds) errors.push("reference.bounds must be an object");
  else {
    finiteRange(bounds.x, "reference.bounds.x", errors, 0, finiteOr(source?.width, 7_680));
    finiteRange(bounds.y, "reference.bounds.y", errors, 0, finiteOr(source?.height, 7_680));
    finiteRange(bounds.width, "reference.bounds.width", errors, Number.EPSILON, finiteOr(source?.width, 7_680));
    finiteRange(bounds.height, "reference.bounds.height", errors, Number.EPSILON, finiteOr(source?.height, 7_680));
    if (finite(bounds.x) && finite(bounds.width) && finite(source?.width) && Number(bounds.x) + Number(bounds.width) > Number(source?.width)) {
      errors.push("reference.bounds must fit inside source width");
    }
    if (finite(bounds.y) && finite(bounds.height) && finite(source?.height) && Number(bounds.y) + Number(bounds.height) > Number(source?.height)) {
      errors.push("reference.bounds must fit inside source height");
    }
  }
  if (!Array.isArray(reference.points) || reference.points.length < 1 || reference.points.length > MAX_TRACKING_REFERENCE_POINTS) {
    errors.push(`reference.points must contain 1..${MAX_TRACKING_REFERENCE_POINTS} entries`);
  } else reference.points.forEach((point, index) => {
    const item = record(point);
    if (!item) errors.push(`reference.points.${index} must be an object`);
    else {
      finiteRange(item.x, `reference.points.${index}.x`, errors, 0, finiteOr(source?.width, 7_680));
      finiteRange(item.y, `reference.points.${index}.y`, errors, 0, finiteOr(source?.height, 7_680));
    }
  });
}

function validateSettings(settings: Record<string, unknown>, source: Record<string, unknown> | null, errors: string[]) {
  finiteRange(settings.startMs, "settings.startMs", errors, 0, finiteOr(source?.durationMs, 86_400_000));
  finiteRange(settings.endMs, "settings.endMs", errors, 0, finiteOr(source?.durationMs, 86_400_000));
  if (finite(settings.startMs) && finite(settings.endMs) && Number(settings.endMs) < Number(settings.startMs)) errors.push("settings.endMs must be >= startMs");
  finiteRange(settings.stepMs, "settings.stepMs", errors, 1, 10_000);
  if (!isOneOf(settings.direction, ["forward", "backward", "both"])) errors.push("settings.direction is unsupported");
  integerRange(settings.searchRadiusPx, "settings.searchRadiusPx", errors, 1, 512);
  integerRange(settings.pyramidLevels, "settings.pyramidLevels", errors, 1, 8);
  integerRange(settings.maxIterations, "settings.maxIterations", errors, 1, 1_000);
  finiteRange(settings.confidenceFloor, "settings.confidenceFloor", errors, 0, 1);
  integerRange(settings.deterministicSeed, "settings.deterministicSeed", errors, 0, 2 ** 31 - 1);
}

function validateSamples(samples: unknown[], settings: Record<string, unknown> | null, status: unknown, errors: string[]) {
  let priorAtMs = -1;
  let hasDegraded = false;
  samples.forEach((sample, index) => {
    const item = record(sample);
    if (!item) {
      errors.push(`samples.${index} must be an object`);
      return;
    }
    finiteRange(item.atMs, `samples.${index}.atMs`, errors, finiteOr(settings?.startMs, 0), finiteOr(settings?.endMs, 86_400_000));
    if (finite(item.atMs) && Number(item.atMs) <= priorAtMs) errors.push(`samples.${index}.atMs must be strictly increasing`);
    if (finite(item.atMs)) priorAtMs = Number(item.atMs);
    if (!isOneOf(item.state, ["tracked", "low-confidence", "lost", "recovered"])) errors.push(`samples.${index}.state is unsupported`);
    finiteRange(item.confidence, `samples.${index}.confidence`, errors, 0, 1);
    if (item.residualErrorPx !== undefined) finiteRange(item.residualErrorPx, `samples.${index}.residualErrorPx`, errors, 0, 100_000);
    if (item.state === "lost") {
      hasDegraded = true;
      if (item.matrix !== undefined) errors.push(`samples.${index}.matrix must be absent while lost`);
    } else {
      if (item.state === "low-confidence") hasDegraded = true;
      validateMatrix(item.matrix, `samples.${index}.matrix`, errors);
      if (item.residualErrorPx === undefined) errors.push(`samples.${index}.residualErrorPx is required while tracked`);
    }
  });
  if (status === "succeeded" && hasDegraded) errors.push("status must be partial when samples are low-confidence or lost");
}

function validateSpans(spans: unknown[], source: Record<string, unknown> | null, errors: string[]) {
  let priorEnd = -1;
  spans.forEach((span, index) => {
    const item = record(span);
    if (!item) {
      errors.push(`spans.${index} must be an object`);
      return;
    }
    finiteRange(item.startMs, `spans.${index}.startMs`, errors, 0, finiteOr(source?.durationMs, 86_400_000));
    finiteRange(item.endMs, `spans.${index}.endMs`, errors, 0, finiteOr(source?.durationMs, 86_400_000));
    if (finite(item.startMs) && Number(item.startMs) < priorEnd) errors.push(`spans.${index} overlaps a previous span`);
    if (finite(item.startMs) && finite(item.endMs) && Number(item.endMs) < Number(item.startMs)) errors.push(`spans.${index}.endMs must be >= startMs`);
    if (finite(item.endMs)) priorEnd = Number(item.endMs);
    if (!isOneOf(item.state, ["low-confidence", "lost", "recovered"])) errors.push(`spans.${index}.state is unsupported`);
    finiteRange(item.minConfidence, `spans.${index}.minConfidence`, errors, 0, 1);
    if (item.maxResidualErrorPx !== undefined) finiteRange(item.maxResidualErrorPx, `spans.${index}.maxResidualErrorPx`, errors, 0, 100_000);
  });
}

function validateMatrix(value: unknown, path: string, errors: string[]) {
  if (!Array.isArray(value) || value.length !== 9) {
    errors.push(`${path} must contain exactly 9 numbers`);
    return;
  }
  value.forEach((entry, index) => finiteRange(entry, `${path}.${index}`, errors, -MAX_TRACKING_MATRIX_ABS_VALUE, MAX_TRACKING_MATRIX_ABS_VALUE));
  if (!value.every(finite)) return;
  const matrix = value.map(Number) as TrackingMatrix3;
  if (Math.abs(matrix[6]) > MAX_TRACKING_PERSPECTIVE_TERM || Math.abs(matrix[7]) > MAX_TRACKING_PERSPECTIVE_TERM) {
    errors.push(`${path} perspective terms exceed the bounded homography limit`);
  }
  try {
    invertMatrix3(matrix);
  } catch {
    errors.push(`${path} must be invertible`);
  }
}

function assertSourceIdentity(source: TrackingSourceIdentity) {
  const errors: string[] = [];
  validateSource(source as unknown as Record<string, unknown>, errors);
  if (errors.length > 0) throw new Error(`Invalid tracking source: ${errors.join("; ")}`);
}

function cloneLifecycle(value: TrackingAnalysisLifecycle): TrackingAnalysisLifecycle {
  return {
    ...value,
    requestedSource: cloneSource(value.requestedSource),
    ...(value.lastGood ? { lastGood: structuredClone(value.lastGood) } : {}),
    ...(value.failure ? { failure: { ...value.failure } } : {}),
  };
}

function cloneSource(source: TrackingSourceIdentity): TrackingSourceIdentity {
  return { ...source };
}

function boundedFailure(code: string, message: string) {
  const errors: string[] = [];
  safeId(code, "failure.code", errors);
  boundedString(message, "failure.message", errors, 1, 500);
  if (errors.length > 0) throw new Error(errors.join("; "));
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function finite(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function finiteOr(value: unknown, fallback: number): number {
  return finite(value) ? Number(value) : fallback;
}

function finiteRange(value: unknown, path: string, errors: string[], min: number, max: number) {
  if (!finite(value) || Number(value) < min || Number(value) > max) errors.push(`${path} must be a finite number from ${min} to ${max}`);
}

function integerRange(value: unknown, path: string, errors: string[], min: number, max: number) {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) errors.push(`${path} must be an integer from ${min} to ${max}`);
}

function safeId(value: unknown, path: string, errors: string[]) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) errors.push(`${path} must be a safe identifier`);
}

function boundedString(value: unknown, path: string, errors: string[], min: number, max: number) {
  if (typeof value !== "string" || value.length < min || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    errors.push(`${path} must be a bounded printable string`);
  }
}

function isOneOf(value: unknown, options: readonly string[]): boolean {
  return typeof value === "string" && options.includes(value);
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

const SHA256 = /^[a-f0-9]{64}$/;
