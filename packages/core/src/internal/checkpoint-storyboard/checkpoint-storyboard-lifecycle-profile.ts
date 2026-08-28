/** Private C6B5a lifecycle admission and pure ordinary-shape append plan. */

import { canonicalJsonSha256 } from "../../canonical-json";
import { readMotionDocument, readPackageManifest } from "../../package";
import type { MotionDocument, PackageManifest } from "../../types";
import { loadSchemaSync, validateDocumentSync } from "../../validate";
import { compileCheckpointStoryboardPlan, readCheckpointStoryboard } from "./checkpoint-storyboard-records";
import { exactRecord, freeze, safeId, sha256, snapshotCheckpointStoryboardData } from "./checkpoint-storyboard-data";
import type { CheckpointObjectState, CheckpointProperty, CheckpointStoryboard } from "./checkpoint-storyboard-types";
import {
  CHECKPOINT_STORYBOARD_LIFECYCLE_PROFILE_PLAN_SCHEMA,
  CHECKPOINT_STORYBOARD_LIFECYCLE_PROFILE_REQUEST_SCHEMA,
  CHECKPOINT_STORYBOARD_LIFECYCLE_PROFILE_SCHEMA,
  type CheckpointStoryboardLifecycleCapability,
  type CheckpointStoryboardLifecycleLayer,
  type CheckpointStoryboardLifecycleProfilePlan,
  type CheckpointStoryboardLifecycleProfileRequest,
} from "./checkpoint-storyboard-lifecycle-profile-types";

const PROPERTIES = ["transform.x", "transform.y", "transform.rotation", "transform.scale", "opacity"] as const;
const CAPABILITIES: readonly CheckpointStoryboardLifecycleCapability[] = ["renderer.browser", "renderer.native"];
const CAPABILITY_SET = new Set<string>(CAPABILITIES);
const FORBIDDEN_MOTION_AUTHORITIES = [
  "tracks", "relationships", "behaviors", "relations", "relationActions", "layoutGapAnimation", "layoutApplications", "scene3dAnimation",
] as const;
const FORBIDDEN_SOURCE_LAYER_AUTHORITIES = [
  "childLayerIds", "trackId", "keyframes", "transitions", "tracking", "stabilization", "stabilize", "transformAuthority", "timingAuthority",
  "timeRemap", "trimStartMs", "trimDurationMs", "loop", "playbackRate", "x-tracking-stabilization", "depth", "geometry", "geometryKeyframes", "morph",
] as const;
const PROFILE_PAYLOAD = freeze({
  schema: CHECKPOINT_STORYBOARD_LIFECYCLE_PROFILE_SCHEMA,
  supportedCapabilities: CAPABILITIES,
  rootShapeKinds: ["rect", "ellipse"] as const,
  propertyMask: PROPERTIES,
  lifecycle: "absent-create-present-optional-remove" as const,
});

/** Base-independent C6B5a admission. The exact final document endpoint remains compiler-only. */
export function admitCheckpointStoryboardLifecycleRecordProfile(value: unknown): CheckpointStoryboard {
  const storyboard = readCheckpointStoryboard(value);
  assertStaticProfile(storyboard);
  return storyboard;
}

/** Strict detached-input reader. It snapshots before validating so getters cannot steer semantics. */
export function readCheckpointStoryboardLifecycleProfileRequest(value: unknown): CheckpointStoryboardLifecycleProfileRequest {
  const root = exactRecord(snapshotCheckpointStoryboardData(value), ["schema", "storyboard", "base"], [], "CheckpointStoryboard lifecycle profile request");
  if (root.schema !== CHECKPOINT_STORYBOARD_LIFECYCLE_PROFILE_REQUEST_SCHEMA) throw new Error(`CheckpointStoryboard lifecycle profile request.schema must equal ${CHECKPOINT_STORYBOARD_LIFECYCLE_PROFILE_REQUEST_SCHEMA}.`);
  return freeze({ schema: CHECKPOINT_STORYBOARD_LIFECYCLE_PROFILE_REQUEST_SCHEMA, storyboard: readCheckpointStoryboard(root.storyboard), base: readBase(root.base) });
}

/** Produces one frozen append-only layer intent per sealed catalog entry. It opens or writes nothing. */
export function compileCheckpointStoryboardLifecycleProfilePlan(value: unknown): CheckpointStoryboardLifecycleProfilePlan {
  const request = readCheckpointStoryboardLifecycleProfileRequest(value);
  assertStaticProfile(request.storyboard);
  const durationUs = request.base.motion.durationMs * 1_000;
  if (!Number.isSafeInteger(durationUs) || request.storyboard.checkpoints.at(-1)!.atUs !== durationUs) throw new Error("CheckpointStoryboard lifecycle profile requires its final checkpoint at the exact detached base motion duration.");
  assertBaseAuthority(request.base.motion, request.storyboard);
  const operations = request.storyboard.objectCatalog.map((catalog, index) => operationFor(request.storyboard, index, request.base.motion.durationMs));
  const layers = freeze(operations.map((operation, index) => layerFor(request.storyboard, index, operation)));
  const c6a = compileCheckpointStoryboardPlan(request.storyboard);
  const lowererProfile = freeze({ ...PROFILE_PAYLOAD, fingerprint: canonicalJsonSha256(PROFILE_PAYLOAD) });
  const payload = {
    schema: CHECKPOINT_STORYBOARD_LIFECYCLE_PROFILE_PLAN_SCHEMA,
    storyboard: freeze({ id: request.storyboard.id, sha256: request.storyboard.sha256, revision: request.storyboard.revision, fingerprint: c6a.fingerprint }),
    base: freeze({
      package: freeze({ id: request.base.packageId, motionPath: request.base.manifest.motion }),
      manifest: freeze({ id: request.base.manifest.id, sha256: canonicalJsonSha256(request.base.manifest) }),
      canonicalMotion: freeze({ id: request.base.motion.id, sha256: canonicalJsonSha256(request.base.motion) }),
      persistedMotion: freeze({ id: request.base.motion.id, sha256: request.base.persistedMotionSha256 }),
    }),
    lowererProfile, operations: freeze(operations), layers,
    intendedChanges: freeze({ paths: freeze(["/layers"] as ["/layers"]), layers: freeze({ operation: "append" as const, sourceLayerCount: request.base.motion.layers.length, appendLayerIds: freeze(request.storyboard.objectCatalog.map((entry) => entry.objectId)) }) }),
    evidence: freeze({ noPackageIO: true as const, noPackageWrites: true as const, noCOW: true as const, noReceipt: true as const, noPublicSurface: true as const, noRenderer: true as const }),
  };
  return freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}

function readBase(value: unknown): CheckpointStoryboardLifecycleProfileRequest["base"] {
  const record = exactRecord(value, ["packageId", "manifest", "motion", "persistedMotionSha256"], [], "CheckpointStoryboard lifecycle profile base");
  const packageId = safeId(record.packageId, "CheckpointStoryboard lifecycle profile base.packageId");
  const manifestData = exactRecord(record.manifest, ["schema", "id", "name", "motion", "assets", "sourceApp", "compatibility"], ["template", "quality", "workflow", "data", "selectedFrameId"], "CheckpointStoryboard lifecycle profile base.manifest");
  assertDocument("manifest", "packageManifest", manifestData);
  const manifest = readPackageManifest(manifestData);
  if (safeId(manifest.id, "CheckpointStoryboard lifecycle profile base.manifest.id") !== packageId) throw new Error("CheckpointStoryboard lifecycle profile base.packageId must exactly match manifest.id.");
  readMotionPath(manifest.motion);
  const motionData = exactRecord(record.motion, ["schema", "id", "name", "durationMs", "fps", "width", "height", "layers", "assets", "provenance"], ["background", "audio", "scenes", "tracks", "markers", "safeAreas", "compositing", "relationships", "behaviors", "relations", "layoutGapAnimation", "scene3dAnimation", "relationActions", "layoutApplications"], "CheckpointStoryboard lifecycle profile base.motion");
  assertDocument("Motion document", "motion", motionData);
  const motion = readMotionDocument(motionData);
  safeId(motion.id, "CheckpointStoryboard lifecycle profile base.motion.id");
  if (!Number.isSafeInteger(motion.durationMs) || motion.durationMs < 1 || motion.durationMs > 3_600_000) throw new Error("CheckpointStoryboard lifecycle profile base.motion.durationMs must be a bounded positive safe integer.");
  return freeze({ packageId, manifest: freeze(manifest) as PackageManifest, motion: freeze(motion), persistedMotionSha256: sha256(record.persistedMotionSha256, "CheckpointStoryboard lifecycle profile base.persistedMotionSha256") });
}

function assertDocument(label: string, schema: "packageManifest" | "motion", value: unknown): void {
  const result = validateDocumentSync(loadSchemaSync(schema), value);
  if (!result.ok) {
    const first = result.errors[0]!;
    throw new Error(`CheckpointStoryboard lifecycle profile ${label} is invalid at ${first.path || "/"}: ${first.message}`);
  }
}

function readMotionPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value !== value.normalize("NFC") || /[\u0000-\u001F\u007F-\u009F]/u.test(value) || value.split("/").some((segment) => segment === "." || segment === ".." || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))) throw new Error("CheckpointStoryboard lifecycle profile base.manifest.motion must be an NFC package-relative POSIX locator with clean ASCII segments only.");
  return value;
}

function assertStaticProfile(storyboard: CheckpointStoryboard): void {
  if (storyboard.capabilityRequirements.length !== 1 || !CAPABILITY_SET.has(storyboard.capabilityRequirements[0]!)) throw new Error("CheckpointStoryboard lifecycle profile requires exactly one renderer.browser or renderer.native capability requirement.");
  if (storyboard.objectCatalog.length < 1 || storyboard.objectCatalog.length > 64 || storyboard.recipes.length !== 0 || storyboard.edges.some((edge) => edge.recipeIds.length !== 0)) throw new Error("CheckpointStoryboard lifecycle profile requires 1..64 objects, no recipes, and empty edge recipeIds.");
  if (storyboard.checkpoints[0]!.atUs !== 0 || storyboard.checkpoints.some((checkpoint) => checkpoint.atUs % 1_000 !== 0)) throw new Error("CheckpointStoryboard lifecycle profile requires whole-millisecond checkpoints beginning at zero.");
  for (const [objectIndex, catalog] of storyboard.objectCatalog.entries()) {
    if ((catalog.rootShapeKind !== "rect" && catalog.rootShapeKind !== "ellipse") || !catalog.creation || !sameMask(catalog.propertyMask, PROPERTIES)) throw new Error("CheckpointStoryboard lifecycle profile requires rect/ellipse catalog roots with creation payloads and the exact canonical property mask.");
    const states = storyboard.checkpoints.map((checkpoint) => checkpoint.objects[objectIndex]!);
    if (states[0]!.state !== "absent") throw new Error("CheckpointStoryboard lifecycle profile requires all objects initially absent.");
    let createdAt = -1, removedAt = -1, values: CheckpointObjectState["properties"] | undefined;
    for (const [checkpointIndex, state] of states.entries()) {
      if (state.state === "present") {
        if (values && !sameProperties(values, state.properties)) throw new Error(`CheckpointStoryboard lifecycle profile object '${catalog.objectId}' must retain identical present property values.`);
        values ??= state.properties;
      }
      if (checkpointIndex === 0) continue;
      const previous = states[checkpointIndex - 1]!;
      if (previous.state === "absent" && state.state === "present") {
        if (createdAt !== -1 || checkpointIndex === states.length - 1) throw new Error(`CheckpointStoryboard lifecycle profile object '${catalog.objectId}' must create exactly once before document end.`);
        createdAt = checkpointIndex;
      }
      if (previous.state === "present" && state.state === "absent") {
        if (createdAt === -1 || removedAt !== -1) throw new Error(`CheckpointStoryboard lifecycle profile object '${catalog.objectId}' has an invalid remove lifecycle.`);
        removedAt = checkpointIndex;
      }
      if (removedAt !== -1 && state.state === "present") throw new Error(`CheckpointStoryboard lifecycle profile object '${catalog.objectId}' forbids recreate after removal.`);
    }
    if (createdAt === -1 || !values) throw new Error(`CheckpointStoryboard lifecycle profile object '${catalog.objectId}' must not remain permanently absent.`);
  }
}

function assertBaseAuthority(motion: MotionDocument, storyboard: CheckpointStoryboard): void {
  for (const field of FORBIDDEN_MOTION_AUTHORITIES) if (Object.hasOwn(motion, field)) throw new Error(`CheckpointStoryboard lifecycle profile base refuses existing ${field} authority.`);
  if (Object.hasOwn(motion, "traces") || Object.hasOwn(motion, "parametricTrace") || Object.hasOwn(motion, "parametricTraces")) throw new Error("CheckpointStoryboard lifecycle profile base refuses trace authority.");
  const targetIds = new Set(storyboard.objectCatalog.map((entry) => entry.objectId));
  const sourceIds = new Set<string>();
  for (const layer of motion.layers) {
    const raw = layer as unknown as Record<string, unknown>, id = safeId(raw.id, "CheckpointStoryboard lifecycle profile base source layer.id");
    if (sourceIds.has(id) || targetIds.has(id)) throw new Error(`CheckpointStoryboard lifecycle profile base refuses target/source layer id collision '${id}'.`);
    sourceIds.add(id);
    if (raw.type === "group" || FORBIDDEN_SOURCE_LAYER_AUTHORITIES.some((field) => Object.hasOwn(raw, field))) throw new Error(`CheckpointStoryboard lifecycle profile base refuses structural or competing source-layer authority on '${id}'.`);
  }
}

function operationFor(storyboard: CheckpointStoryboard, objectIndex: number, durationMs: number) {
  const catalog = storyboard.objectCatalog[objectIndex]!;
  let createIndex = -1, removeIndex = -1;
  for (let index = 1; index < storyboard.checkpoints.length; index += 1) {
    const before = storyboard.checkpoints[index - 1]!.objects[objectIndex]!, after = storyboard.checkpoints[index]!.objects[objectIndex]!;
    if (before.state === "absent" && after.state === "present") createIndex = index;
    if (before.state === "present" && after.state === "absent") removeIndex = index;
  }
  const createCheckpoint = storyboard.checkpoints[createIndex]!, createEdge = storyboard.edges[createIndex - 1]!;
  const removeCheckpoint = removeIndex === -1 ? undefined : storyboard.checkpoints[removeIndex]!, removeEdge = removeIndex === -1 ? undefined : storyboard.edges[removeIndex - 1]!;
  const startMs = createCheckpoint.atUs / 1_000, endMs = removeCheckpoint ? removeCheckpoint.atUs / 1_000 : durationMs, duration = endMs - startMs;
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || duration < 1) throw new Error(`CheckpointStoryboard lifecycle profile object '${catalog.objectId}' has a zero or invalid ordinary-layer duration.`);
  return freeze({ objectId: catalog.objectId, targetLayerId: catalog.objectId, rootShapeKind: catalog.rootShapeKind as "rect" | "ellipse", create: freeze({ edge: edgeIdentity(createEdge), atMs: startMs }), ...(removeEdge ? { remove: freeze({ edge: edgeIdentity(removeEdge), atMs: endMs }) } : {}), interval: freeze({ startMs, endMs, durationMs: duration }) });
}

function layerFor(storyboard: CheckpointStoryboard, objectIndex: number, operation: ReturnType<typeof operationFor>): CheckpointStoryboardLifecycleLayer {
  const catalog = storyboard.objectCatalog[objectIndex]!, creation = catalog.creation!;
  const checkpoint = storyboard.checkpoints.find((entry) => entry.id === operation.create.edge.toCheckpointId)!;
  const state = checkpoint.objects[objectIndex]!;
  if (state.state !== "present") throw new Error("CheckpointStoryboard lifecycle profile internal creation state failure.");
  const value = (property: CheckpointProperty) => state.properties.find((entry) => entry.property === property)!.value;
  return freeze({ id: catalog.objectId, type: "shape", shape: catalog.rootShapeKind as "rect" | "ellipse", startMs: operation.interval.startMs, durationMs: operation.interval.durationMs, fill: creation.fill, opacity: value("opacity"), transform: freeze({ x: value("transform.x"), y: value("transform.y"), rotation: value("transform.rotation"), scale: value("transform.scale"), width: creation.width, height: creation.height, originX: creation.width / 2, originY: creation.height / 2 }) });
}

function edgeIdentity(edge: CheckpointStoryboard["edges"][number]) { return freeze({ id: edge.id, fromCheckpointId: edge.fromCheckpointId, toCheckpointId: edge.toCheckpointId }); }
function sameMask(left: readonly CheckpointProperty[], right: readonly CheckpointProperty[]): boolean { return left.length === right.length && left.every((property, index) => property === right[index]); }
function sameProperties(left: CheckpointObjectState["properties"], right: CheckpointObjectState["properties"]): boolean { return left.length === right.length && left.every((entry, index) => entry.property === right[index]!.property && entry.value === right[index]!.value); }
