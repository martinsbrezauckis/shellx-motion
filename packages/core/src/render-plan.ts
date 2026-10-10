/**
 * Closed, path-free identity for one preflighted final-video render.
 *
 * This is deliberately not an execution request: it names only immutable package/document
 * identities and the already-selected route.  A coordinator can bind it before events without
 * serializing a filesystem authority, producer output, or an unbounded request map.
 */
import { canonicalJson, canonicalJsonSha256 } from "./canonical-json";
import {
  boundedInteger,
  closedRecord,
  closedRecordWithOptional,
  opaqueText,
  sha256
} from "./lifecycle-envelope-validation";
import { validatePackageRenderLineage, type PackageRenderLineage } from "./package-render-lineage";
import {
  MOTION_RENDER_PLAN_V2_SCHEMA,
  parseMotionRenderPlanV2,
  type MotionRenderCapabilitySnapshot,
  type MotionRenderPlanV2
} from "./render-plan-v2-read-only";

export { MOTION_RENDER_PLAN_V2_SCHEMA } from "./render-plan-v2-read-only";
export type { MotionRenderCapabilitySnapshot, MotionRenderPlanV2 } from "./render-plan-v2-read-only";

export const MOTION_RENDER_PLAN_SCHEMA = "shellx-motion/render-plan@1" as const;
export const MOTION_RENDER_PLAN_MAX_BYTES = 32 * 1024;

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PRESET_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const ENGINE_ID = /^[A-Za-z0-9][A-Za-z0-9._+@-]{0,127}$/u;

export type MotionRenderFrameLane = "browser" | "native" | "gpu";
export type MotionRenderDelivery = "streamed" | "segmented";

export interface MotionRenderPlanSegmentedIntent {
  readonly segmentFrames: number;
  readonly resume: boolean;
}

export interface MotionRenderPlanV1 {
  readonly schema: typeof MOTION_RENDER_PLAN_SCHEMA;
  readonly operation: "render.final";
  readonly package: Readonly<{ id: string; manifestSha256: string }>;
  readonly motion: Readonly<{ id: string; documentSha256: string }>;
  readonly lineage: Readonly<PackageRenderLineage>;
  /** `intentSha256` binds an admitted destination without retaining its path or root. */
  readonly output: Readonly<{ preset: string; mediaRole: "final-video"; intentSha256: string }>;
  /** V1 coordinated submit admits no quality-manifest or materialized quality route. */
  readonly quality: Readonly<{ mode: "none" }>;
  readonly requested: Readonly<{
    lane: "ffmpeg";
    frameLane: MotionRenderFrameLane;
    delivery: MotionRenderDelivery;
    segmented: MotionRenderPlanSegmentedIntent | null;
    fallback: "none";
  }>;
  /** Identity discovered and selected during preflight, never post-render producer claims. */
  readonly runtime: Readonly<{
    engine: string;
    routeFingerprint: string;
    presetFingerprint: string;
    capabilityFingerprint: string;
  }>;
  readonly compatibility: Readonly<{ version: 1; state: "current" }>;
  /** SHA-256 of all preceding fields through canonical JSON, excluding this field itself. */
  readonly fingerprint: string;
}

export type MotionRenderPlan = MotionRenderPlanV1 | MotionRenderPlanV2;

export interface MotionRenderPlanInput {
  readonly package: { readonly id: string; readonly manifestSha256: string };
  readonly motion: { readonly id: string; readonly documentSha256: string };
  readonly lineage: PackageRenderLineage;
  readonly output: { readonly preset: string; readonly mediaRole: "final-video"; readonly intentSha256: string };
  readonly quality: { readonly mode: "none" };
  readonly requested: {
    readonly lane: "ffmpeg";
    readonly frameLane: MotionRenderFrameLane;
    readonly delivery: MotionRenderDelivery;
    readonly segmented: MotionRenderPlanSegmentedIntent | null;
    readonly fallback: "none";
  };
  readonly runtime: {
    readonly engine: string;
    readonly routeFingerprint: string;
    readonly presetFingerprint: string;
    readonly capabilityFingerprint: string;
  };
  readonly compatibility: { readonly version: 1; readonly state: "current" };
}

type MotionRenderPlanContent = Omit<MotionRenderPlanV1, "fingerprint">;

/** Build one frozen, self-verifying plan from a closed preflight result. */
export function createMotionRenderPlan(input: MotionRenderPlanInput): MotionRenderPlanV1 {
  const content = parsePlanInput(input);
  return freezePlan({ ...content, fingerprint: canonicalJsonSha256(content) });
}

/** Strictly parse a plan from disk or an untrusted boundary. */
export function parseMotionRenderPlan(value: unknown): MotionRenderPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Render plan must be an object.");
  const schema = (value as { schema?: unknown }).schema;
  if (schema === MOTION_RENDER_PLAN_SCHEMA) return parseMotionRenderPlanV1(value);
  if (schema === MOTION_RENDER_PLAN_V2_SCHEMA) return parseMotionRenderPlanV2(value);
  throw new Error("Unsupported render plan schema.");
}

function parseMotionRenderPlanV1(value: unknown): MotionRenderPlanV1 {
  const record = closedRecord(value, [
    "schema", "operation", "package", "motion", "lineage", "output", "quality", "requested", "runtime", "compatibility", "fingerprint"
  ], "Render plan");
  const content = parsePlanContent(record);
  const fingerprint = sha256(record.fingerprint, "Render plan fingerprint");
  if (fingerprint !== canonicalJsonSha256(content)) {
    throw new Error("Render plan fingerprint does not match its canonical content.");
  }
  return freezePlan({ ...content, fingerprint });
}

/** Canonical SHA-256 of a plan excluding its self-hash. */
export function motionRenderPlanFingerprint(value: Omit<MotionRenderPlan, "fingerprint"> | MotionRenderPlan): string {
  const { fingerprint: _fingerprint, ...content } = value as MotionRenderPlan;
  return canonicalJsonSha256(content);
}

/** Canonical persisted bytes, bounded before a private store can write them. */
export function serializeMotionRenderPlan(value: MotionRenderPlan): string {
  const plan = parseMotionRenderPlan(value);
  const serialized = canonicalJson(plan);
  if (Buffer.byteLength(serialized, "utf8") > MOTION_RENDER_PLAN_MAX_BYTES) {
    throw new Error(`Render plan exceeds its ${MOTION_RENDER_PLAN_MAX_BYTES}-byte limit.`);
  }
  return serialized;
}

function parsePlanInput(value: MotionRenderPlanInput): MotionRenderPlanContent {
  const record = closedRecord(value, ["package", "motion", "lineage", "output", "quality", "requested", "runtime", "compatibility"], "Render plan input");
  return parsePlanContent({
    schema: MOTION_RENDER_PLAN_SCHEMA,
    operation: "render.final",
    package: record.package,
    motion: record.motion,
    lineage: record.lineage,
    output: record.output,
    quality: record.quality,
    requested: record.requested,
    runtime: record.runtime,
    compatibility: record.compatibility
  });
}

function parsePlanContent(record: Record<string, unknown>): MotionRenderPlanContent {
  if (record.schema !== MOTION_RENDER_PLAN_SCHEMA) throw new Error("Unsupported render plan schema.");
  if (record.operation !== "render.final") throw new Error("Render plan operation must be render.final.");
  const packageIdentity = parsePackage(record.package);
  const motionIdentity = parseMotion(record.motion);
  const lineage = parseLineage(record.lineage);
  if (packageIdentity.manifestSha256 !== lineage.manifestSha256) {
    throw new Error("Render plan package manifestSha256 must match its lineage.");
  }
  if (motionIdentity.documentSha256 !== lineage.motionSha256) {
    throw new Error("Render plan documentSha256 must match its lineage motionSha256.");
  }
  return {
    schema: MOTION_RENDER_PLAN_SCHEMA,
    operation: "render.final",
    package: packageIdentity,
    motion: motionIdentity,
    lineage,
    output: parseOutput(record.output),
    quality: parseQuality(record.quality),
    requested: parseRequested(record.requested),
    runtime: parseRuntime(record.runtime),
    compatibility: parseCompatibility(record.compatibility)
  };
}

function parseQuality(value: unknown): { mode: "none" } {
  const record = closedRecord(value, ["mode"], "Render plan quality");
  if (record.mode !== "none") throw new Error("Render plan quality mode must be none for V1 coordinated final-video jobs.");
  return Object.freeze({ mode: "none" });
}

function parsePackage(value: unknown): { id: string; manifestSha256: string } {
  const record = closedRecord(value, ["id", "manifestSha256"], "Render plan package");
  return {
    id: opaqueText(record.id, "Render plan package id", 1, 128, OPAQUE_ID),
    manifestSha256: sha256(record.manifestSha256, "Render plan package manifestSha256")
  };
}

function parseMotion(value: unknown): { id: string; documentSha256: string } {
  const record = closedRecord(value, ["id", "documentSha256"], "Render plan motion");
  return {
    id: opaqueText(record.id, "Render plan motion id", 1, 128, OPAQUE_ID),
    documentSha256: sha256(record.documentSha256, "Render plan documentSha256")
  };
}

function parseLineage(value: unknown): PackageRenderLineage {
  const record = closedRecordWithOptional(
    value,
    ["schema", "manifestSha256", "motionSha256"],
    ["adapterId", "sourceSha256", "normalizedSourceSha256", "loweringReceiptSha256"],
    "Render plan lineage"
  );
  validatePackageRenderLineage(record);
  const adapterId = record.adapterId;
  if (adapterId === undefined) {
    if (record.sourceSha256 !== undefined || record.normalizedSourceSha256 !== undefined || record.loweringReceiptSha256 !== undefined) {
      throw new Error("Render plan lineage source hashes require adapter.gltf.");
    }
    return Object.freeze({
      schema: "shellx-motion/package-render-lineage@1",
      manifestSha256: sha256(record.manifestSha256, "Render plan lineage manifestSha256"),
      motionSha256: sha256(record.motionSha256, "Render plan lineage motionSha256")
    });
  }
  if (adapterId !== "adapter.gltf") throw new Error("Render plan lineage adapterId is unsupported.");
  return Object.freeze({
    schema: "shellx-motion/package-render-lineage@1",
    manifestSha256: sha256(record.manifestSha256, "Render plan lineage manifestSha256"),
    motionSha256: sha256(record.motionSha256, "Render plan lineage motionSha256"),
    adapterId,
    sourceSha256: sha256(record.sourceSha256, "Render plan lineage sourceSha256"),
    normalizedSourceSha256: sha256(record.normalizedSourceSha256, "Render plan lineage normalizedSourceSha256"),
    loweringReceiptSha256: sha256(record.loweringReceiptSha256, "Render plan lineage loweringReceiptSha256")
  });
}

function parseOutput(value: unknown): { preset: string; mediaRole: "final-video"; intentSha256: string } {
  const record = closedRecord(value, ["preset", "mediaRole", "intentSha256"], "Render plan output");
  if (record.mediaRole !== "final-video") throw new Error("Render plan mediaRole must be final-video.");
  return {
    preset: opaqueText(record.preset, "Render plan preset", 1, 64, PRESET_ID),
    mediaRole: "final-video",
    intentSha256: sha256(record.intentSha256, "Render plan output intentSha256")
  };
}

function parseRequested(value: unknown): MotionRenderPlan["requested"] {
  const record = closedRecord(value, ["lane", "frameLane", "delivery", "segmented", "fallback"], "Render plan requested route");
  if (record.lane !== "ffmpeg") throw new Error("Render plan lane must be ffmpeg.");
  if (record.frameLane !== "browser" && record.frameLane !== "native" && record.frameLane !== "gpu") {
    throw new Error("Render plan frameLane is unsupported.");
  }
  if (record.delivery !== "streamed" && record.delivery !== "segmented") throw new Error("Render plan delivery is unsupported.");
  if (record.fallback !== "none") throw new Error("Render plan fallback must be none.");
  const segmented = parseSegmented(record.segmented);
  if ((record.delivery === "streamed" && segmented !== null) || (record.delivery === "segmented" && segmented === null)) {
    throw new Error("Render plan segmented intent must match its delivery.");
  }
  return Object.freeze({
    lane: "ffmpeg",
    frameLane: record.frameLane,
    delivery: record.delivery,
    segmented,
    fallback: "none"
  });
}

function parseSegmented(value: unknown): MotionRenderPlanSegmentedIntent | null {
  if (value === null) return null;
  const record = closedRecord(value, ["segmentFrames", "resume"], "Render plan segmented intent");
  if (typeof record.resume !== "boolean") throw new Error("Render plan segmented resume must be boolean.");
  return Object.freeze({
    segmentFrames: boundedInteger(record.segmentFrames, "Render plan segmentFrames", 1, 1_000_000),
    resume: record.resume
  });
}

function parseRuntime(value: unknown): MotionRenderPlanV1["runtime"] {
  const record = closedRecord(value, ["engine", "routeFingerprint", "presetFingerprint", "capabilityFingerprint"], "Render plan runtime");
  return Object.freeze({
    engine: opaqueText(record.engine, "Render plan engine", 1, 128, ENGINE_ID),
    routeFingerprint: sha256(record.routeFingerprint, "Render plan routeFingerprint"),
    presetFingerprint: sha256(record.presetFingerprint, "Render plan presetFingerprint"),
    capabilityFingerprint: sha256(record.capabilityFingerprint, "Render plan capabilityFingerprint")
  });
}

function parseCompatibility(value: unknown): MotionRenderPlanV1["compatibility"] {
  const record = closedRecord(value, ["version", "state"], "Render plan compatibility");
  if (record.version !== 1 || record.state !== "current") throw new Error("Render plan compatibility must be version 1 in current state.");
  return Object.freeze({ version: 1, state: "current" });
}

function freezePlan(value: MotionRenderPlanV1): MotionRenderPlanV1 {
  const requested = Object.freeze({
    ...value.requested,
    segmented: value.requested.segmented === null ? null : Object.freeze({ ...value.requested.segmented })
  });
  return Object.freeze({
    ...value,
    package: Object.freeze({ ...value.package }),
    motion: Object.freeze({ ...value.motion }),
    lineage: Object.freeze({ ...value.lineage }),
    output: Object.freeze({ ...value.output }),
    quality: Object.freeze({ ...value.quality }),
    requested,
    runtime: Object.freeze({ ...value.runtime }),
    compatibility: Object.freeze({ ...value.compatibility })
  });
}
