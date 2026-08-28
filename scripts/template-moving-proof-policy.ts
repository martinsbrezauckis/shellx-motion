/**
 * Checked source-owned policy for the promoted product-pack moving-proof gate.
 *
 * This table deliberately lives outside individual template manifests. It is CI/release-gate
 * policy, not a new package capability, and it must remain exact over the public catalog. Its
 * calibration values describe an observed completed proof; current evidence is always the fresh
 * render receipt and FFprobe readback collected by template-product-pack-proof.ts.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_PRODUCT_TEMPLATE_DIRS } from "./template-product-pack-catalog";

export const TEMPLATE_MOVING_PROOF_POLICY_SCHEMA = "shellx-motion/template-moving-proof-policy@2" as const;

export interface MovingProofColorPolicy {
  profile: "sdr-bt709";
  primaries: "bt709";
  transfer: "bt709";
  matrix: "bt709";
  range: "tv";
}

export interface MovingProofFamilyCalibration {
  frameCount: number;
  uniqueFrameHashes: number;
  artifactBytes: number;
  scratchBytes: number;
  encodePeakRssBytes: number;
}

/**
 * The exact frame sequence the motion policy was calibrated against.  The full
 * frame-level report remains fresh-proof evidence; these compact values make
 * the checked threshold auditable without pretending an old render is current.
 */
export interface MovingProofMotionDensityCalibration {
  frozenRatio: number;
  longestFrozenMs: number;
  longestFrozenSpanMs: number;
  meanFrameDifference: number;
  meanChangedPixelRatio: number;
}

/** Which source-frame sequence represents composition rather than grain noise. */
export type MovingProofMotionDensityAnalysis = "rendered" | "film-grain-stripped";

/** A per-family release acceptance policy backed by a completed calibration render. */
export interface MovingProofMotionDensityAcceptance {
  state: "calibrated";
  analysis: MovingProofMotionDensityAnalysis;
  calibration: MovingProofMotionDensityCalibration;
  maxFrozenRatio: number;
  maxLongestFrozenMs: number;
}

/**
 * An honest, intentionally blocking state.  It is not an advisory: release
 * proof stops before rendering unless the caller explicitly asks to collect
 * calibration measurements.
 */
export interface MovingProofMotionDensityCalibrationRequired {
  state: "calibration-required";
  analysis: MovingProofMotionDensityAnalysis;
  reason: string;
}

export type MovingProofMotionDensityPolicy =
  | MovingProofMotionDensityAcceptance
  | MovingProofMotionDensityCalibrationRequired;

export interface MotionDensityAcceptanceEvidence {
  frozenRatio: number;
  longestFrozenMs: number;
}

export interface MotionDensityAcceptanceResult {
  ok: boolean;
  code?: "motion_density_policy_uncalibrated" | "motion_density_below_policy";
  message?: string;
}

export interface MovingProofFamilyPolicy {
  calibration: MovingProofFamilyCalibration;
  motionDensity: MovingProofMotionDensityPolicy;
  minUniqueFrameHashes: number;
  maxArtifactBytes: number;
  maxScratchBytes: number;
  maxEncodePeakRssBytes: number;
}

/**
 * Calibration has to preserve even a fully static sequence so the detector can
 * measure it. This is diagnostic-only and never replaces a family's release
 * threshold.
 */
export const MOTION_DENSITY_CALIBRATION_MIN_UNIQUE_FRAME_HASHES = 1;

export interface MovingProofUniqueFrameHashGate {
  renderMinUniqueFrameHashes: number;
  evidence: {
    uniqueFrameHashGate: "calibration-diagnostic" | "release-policy";
    minUniqueFrameHashes: number;
    releaseMinUniqueFrameHashes: number;
  };
}

/**
 * Keep the diagnostic render admission distinct from the release policy. The
 * returned evidence makes that distinction durable in every proof result.
 */
export function selectMovingProofUniqueFrameHashGate(input: {
  calibrateMotionDensity: boolean;
  releaseMinUniqueFrameHashes: number;
}): MovingProofUniqueFrameHashGate {
  assert(Number.isSafeInteger(input.releaseMinUniqueFrameHashes) && input.releaseMinUniqueFrameHashes > 0,
    "moving proof release minimum unique-frame threshold must be a positive safe integer");
  const renderMinUniqueFrameHashes = input.calibrateMotionDensity
    ? MOTION_DENSITY_CALIBRATION_MIN_UNIQUE_FRAME_HASHES
    : input.releaseMinUniqueFrameHashes;
  return {
    renderMinUniqueFrameHashes,
    evidence: {
      uniqueFrameHashGate: input.calibrateMotionDensity ? "calibration-diagnostic" : "release-policy",
      minUniqueFrameHashes: renderMinUniqueFrameHashes,
      releaseMinUniqueFrameHashes: input.releaseMinUniqueFrameHashes
    }
  };
}

export interface TemplateMovingProofPolicy {
  schema: typeof TEMPLATE_MOVING_PROOF_POLICY_SCHEMA;
  calibration: {
    capturedAt: string;
    command: string;
    profile: string;
    note: string;
    historicalEvidence: {
      identity: string;
      commit: string;
      sha256: string;
      scope: string;
      reproducibility: string;
    };
    resourceEvidence: {
      capturedAt: string;
      identity: string;
      commit: string;
      sha256: string;
      scope: string;
      reproducibility: string;
      samplingIntervalMs: number;
      capRationale: string;
    };
  };
  delivery: {
    preset: "mp4-h264";
    fps: number;
    maxDurationDriftFrames: number;
    color: MovingProofColorPolicy;
  };
  families: Record<string, MovingProofFamilyPolicy>;
}

export function defaultTemplateMovingProofPolicyPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "template-moving-proof-policy.json");
}

export async function loadTemplateMovingProofPolicy(path = defaultTemplateMovingProofPolicyPath()): Promise<TemplateMovingProofPolicy> {
  return parseTemplateMovingProofPolicy(JSON.parse(await readFile(resolve(path), "utf8")));
}

/** Validates the source table without treating calibration measurements as current proof. */
export function parseTemplateMovingProofPolicy(value: unknown): TemplateMovingProofPolicy {
  const policy = record(value, "moving proof policy");
  assert.equal(policy.schema, TEMPLATE_MOVING_PROOF_POLICY_SCHEMA, "moving proof policy schema must be current");
  const calibration = record(policy.calibration, "moving proof policy calibration");
  for (const key of ["capturedAt", "command", "profile", "note"] as const) {
    assert(nonEmptyString(calibration[key]), `moving proof policy calibration.${key} must be a non-empty string`);
  }
  const historicalEvidence = record(calibration.historicalEvidence, "moving proof policy calibration.historicalEvidence");
  for (const key of ["identity", "commit", "sha256", "scope", "reproducibility"] as const) {
    assert(nonEmptyString(historicalEvidence[key]), `moving proof policy calibration.historicalEvidence.${key} must be a non-empty string`);
  }
  assert(/^[a-f0-9]{40}$/i.test(historicalEvidence.commit as string), "moving proof policy historical evidence commit must be a full Git SHA-1");
  assert(/^[a-f0-9]{64}$/.test(historicalEvidence.sha256 as string), "moving proof policy historical evidence SHA-256 must be lowercase hex");
  const resourceEvidence = record(calibration.resourceEvidence, "moving proof policy calibration.resourceEvidence");
  for (const key of ["capturedAt", "identity", "scope", "reproducibility", "capRationale"] as const) {
    assert(nonEmptyString(resourceEvidence[key]), `moving proof policy calibration.resourceEvidence.${key} must be a non-empty string`);
  }
  assert(/^[a-f0-9]{40}$/i.test(resourceEvidence.commit as string), "moving proof policy resource evidence commit must be a full Git SHA-1");
  assert(/^[a-f0-9]{64}$/.test(resourceEvidence.sha256 as string), "moving proof policy resource evidence SHA-256 must be lowercase hex");
  const samplingIntervalMs = positiveInteger(resourceEvidence.samplingIntervalMs,
    "moving proof policy calibration.resourceEvidence.samplingIntervalMs");

  const delivery = record(policy.delivery, "moving proof policy delivery");
  assert.equal(delivery.preset, "mp4-h264", "moving proof policy delivery preset must be mp4-h264");
  const fps = positiveInteger(delivery.fps, "moving proof policy delivery.fps");
  const maxDurationDriftFrames = nonNegativeInteger(delivery.maxDurationDriftFrames, "moving proof policy delivery.maxDurationDriftFrames");
  const colorRecord = record(delivery.color, "moving proof policy delivery.color");
  const color: MovingProofColorPolicy = {
    profile: literal(colorRecord.profile, "sdr-bt709", "moving proof policy delivery.color.profile"),
    primaries: literal(colorRecord.primaries, "bt709", "moving proof policy delivery.color.primaries"),
    transfer: literal(colorRecord.transfer, "bt709", "moving proof policy delivery.color.transfer"),
    matrix: literal(colorRecord.matrix, "bt709", "moving proof policy delivery.color.matrix"),
    range: literal(colorRecord.range, "tv", "moving proof policy delivery.color.range")
  };

  const familiesRecord = record(policy.families, "moving proof policy families");
  const actualFamilyIds = Object.keys(familiesRecord).sort();
  const expectedFamilyIds = [...PUBLIC_PRODUCT_TEMPLATE_DIRS];
  assert.deepEqual(actualFamilyIds, expectedFamilyIds, "moving proof policy families must exactly match the promoted public catalog");
  const families: Record<string, MovingProofFamilyPolicy> = {};
  for (const familyId of expectedFamilyIds) {
    const entry = record(familiesRecord[familyId], `moving proof policy family ${familyId}`);
    const calibrationEntry = record(entry.calibration, `moving proof policy family ${familyId}.calibration`);
    const measured: MovingProofFamilyCalibration = {
      frameCount: positiveInteger(calibrationEntry.frameCount, `moving proof policy family ${familyId}.calibration.frameCount`),
      uniqueFrameHashes: positiveInteger(calibrationEntry.uniqueFrameHashes, `moving proof policy family ${familyId}.calibration.uniqueFrameHashes`),
      artifactBytes: positiveInteger(calibrationEntry.artifactBytes, `moving proof policy family ${familyId}.calibration.artifactBytes`),
      scratchBytes: positiveInteger(calibrationEntry.scratchBytes, `moving proof policy family ${familyId}.calibration.scratchBytes`),
      encodePeakRssBytes: positiveInteger(calibrationEntry.encodePeakRssBytes, `moving proof policy family ${familyId}.calibration.encodePeakRssBytes`)
    };
    assert(measured.uniqueFrameHashes <= measured.frameCount, `${familyId} calibration unique frame hashes exceed frame count`);
    const family: MovingProofFamilyPolicy = {
      calibration: measured,
      motionDensity: parseMotionDensityPolicy(entry.motionDensity, familyId),
      minUniqueFrameHashes: positiveInteger(entry.minUniqueFrameHashes, `moving proof policy family ${familyId}.minUniqueFrameHashes`),
      maxArtifactBytes: positiveInteger(entry.maxArtifactBytes, `moving proof policy family ${familyId}.maxArtifactBytes`),
      maxScratchBytes: positiveInteger(entry.maxScratchBytes, `moving proof policy family ${familyId}.maxScratchBytes`),
      maxEncodePeakRssBytes: positiveInteger(entry.maxEncodePeakRssBytes, `moving proof policy family ${familyId}.maxEncodePeakRssBytes`)
    };
    assert(family.minUniqueFrameHashes <= measured.uniqueFrameHashes, `${familyId} minimum unique-frame policy exceeds its measured calibration`);
    assert(family.maxArtifactBytes >= measured.artifactBytes, `${familyId} artifact cap is below its measured calibration`);
    assert(family.maxScratchBytes >= measured.scratchBytes, `${familyId} scratch cap is below its measured calibration`);
    assert(family.maxEncodePeakRssBytes >= measured.encodePeakRssBytes, `${familyId} encode RSS cap is below its measured calibration`);
    families[familyId] = family;
  }

  return {
    schema: TEMPLATE_MOVING_PROOF_POLICY_SCHEMA,
    calibration: {
      capturedAt: calibration.capturedAt as string,
      command: calibration.command as string,
      profile: calibration.profile as string,
      note: calibration.note as string,
      historicalEvidence: {
        identity: historicalEvidence.identity as string,
        commit: historicalEvidence.commit as string,
        sha256: historicalEvidence.sha256 as string,
        scope: historicalEvidence.scope as string,
        reproducibility: historicalEvidence.reproducibility as string
      },
      resourceEvidence: {
        capturedAt: resourceEvidence.capturedAt as string,
        identity: resourceEvidence.identity as string,
        commit: resourceEvidence.commit as string,
        sha256: resourceEvidence.sha256 as string,
        scope: resourceEvidence.scope as string,
        reproducibility: resourceEvidence.reproducibility as string,
        samplingIntervalMs,
        capRationale: resourceEvidence.capRationale as string
      }
    },
    delivery: { preset: "mp4-h264", fps, maxDurationDriftFrames, color },
    families
  };
}

/**
 * Evaluate only a completed source-frame measurement.  Callers choose the
 * declared analysis sequence (rendered or film-grain-stripped) before they get
 * here, so no hash diversity or receipt warning can accidentally stand in for
 * composition motion.
 */
export function evaluateMotionDensityAcceptance(
  policy: MovingProofMotionDensityPolicy,
  evidence: MotionDensityAcceptanceEvidence
): MotionDensityAcceptanceResult {
  if (policy.state === "calibration-required") {
    return {
      ok: false,
      code: "motion_density_policy_uncalibrated",
      message: `motion density needs ${policy.analysis} calibration: ${policy.reason}`
    };
  }
  if (evidence.frozenRatio > policy.maxFrozenRatio) {
    return {
      ok: false,
      code: "motion_density_below_policy",
      message: `frozen ratio ${evidence.frozenRatio} exceeds source-owned maximum ${policy.maxFrozenRatio}`
    };
  }
  if (evidence.longestFrozenMs > policy.maxLongestFrozenMs) {
    return {
      ok: false,
      code: "motion_density_below_policy",
      message: `longest frozen run ${evidence.longestFrozenMs}ms exceeds source-owned maximum ${policy.maxLongestFrozenMs}ms`
    };
  }
  return { ok: true };
}

function parseMotionDensityPolicy(value: unknown, familyId: string): MovingProofMotionDensityPolicy {
  const entry = record(value, `moving proof policy family ${familyId}.motionDensity`);
  const state = entry.state;
  const analysis = literalAnalysis(entry.analysis, `moving proof policy family ${familyId}.motionDensity.analysis`);
  if (state === "calibration-required") {
    assert(nonEmptyString(entry.reason), `moving proof policy family ${familyId}.motionDensity.reason must be a non-empty string`);
    return { state, analysis, reason: entry.reason };
  }
  assert.equal(state, "calibrated", `moving proof policy family ${familyId}.motionDensity.state must be calibrated or calibration-required`);
  const calibrationEntry = record(entry.calibration, `moving proof policy family ${familyId}.motionDensity.calibration`);
  const calibration: MovingProofMotionDensityCalibration = {
    frozenRatio: unitRatio(calibrationEntry.frozenRatio, `moving proof policy family ${familyId}.motionDensity.calibration.frozenRatio`),
    longestFrozenMs: nonNegativeInteger(calibrationEntry.longestFrozenMs, `moving proof policy family ${familyId}.motionDensity.calibration.longestFrozenMs`),
    longestFrozenSpanMs: nonNegativeInteger(calibrationEntry.longestFrozenSpanMs, `moving proof policy family ${familyId}.motionDensity.calibration.longestFrozenSpanMs`),
    meanFrameDifference: unitRatio(calibrationEntry.meanFrameDifference, `moving proof policy family ${familyId}.motionDensity.calibration.meanFrameDifference`),
    meanChangedPixelRatio: unitRatio(calibrationEntry.meanChangedPixelRatio, `moving proof policy family ${familyId}.motionDensity.calibration.meanChangedPixelRatio`)
  };
  const maxFrozenRatio = unitRatio(entry.maxFrozenRatio, `moving proof policy family ${familyId}.maxFrozenRatio`);
  const maxLongestFrozenMs = nonNegativeInteger(entry.maxLongestFrozenMs, `moving proof policy family ${familyId}.maxLongestFrozenMs`);
  assert(maxFrozenRatio >= calibration.frozenRatio,
    `${familyId} maximum frozen-ratio policy is below its measured motion-density calibration`);
  assert(maxLongestFrozenMs >= calibration.longestFrozenMs,
    `${familyId} maximum frozen-run policy is below its measured motion-density calibration`);
  return { state: "calibrated", analysis, calibration, maxFrozenRatio, maxLongestFrozenMs };
}

function record(value: unknown, label: string): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function positiveInteger(value: unknown, label: string): number {
  assert(Number.isSafeInteger(value) && (value as number) > 0, `${label} must be a positive safe integer`);
  return value as number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  assert(Number.isSafeInteger(value) && (value as number) >= 0, `${label} must be a non-negative safe integer`);
  return value as number;
}

function unitRatio(value: unknown, label: string): number {
  assert(typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1,
    `${label} must be a finite ratio from 0 through 1`);
  return value;
}

function literalAnalysis(value: unknown, label: string): MovingProofMotionDensityAnalysis {
  assert(value === "rendered" || value === "film-grain-stripped", `${label} must be rendered or film-grain-stripped`);
  return value;
}

function literal<T extends string>(value: unknown, expected: T, label: string): T {
  assert.equal(value, expected, `${label} must be ${expected}`);
  return expected;
}
