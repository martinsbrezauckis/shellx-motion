/** Private C6B1b coalescing/revalidation over the accepted C6B1a scalar/spatial plan. */

import { canonicalJsonSha256 } from "../../canonical-json";
import { freeze, snapshotCheckpointStoryboardData } from "./checkpoint-storyboard-data";
import {
  admitCheckpointStoryboardScalarSpatialRecordProfile,
  compileCheckpointStoryboardScalarSpatialPlan,
  readCheckpointStoryboardScalarSpatialRequest,
} from "./checkpoint-storyboard-scalar-spatial";
import type { CheckpointStoryboard } from "./checkpoint-storyboard-types";
import { admitCheckpointStoryboardBehaviorRecordProfile } from "./checkpoint-storyboard-behavior-profile";
import { admitCheckpointStoryboardRelationRecordProfile } from "./checkpoint-storyboard-relation-profile";
import { admitCheckpointStoryboardRelationActionRecordProfile } from "./checkpoint-storyboard-relation-action-record-profile";
import { admitCheckpointStoryboardLifecycleRecordProfile } from "./checkpoint-storyboard-lifecycle-profile";
import { admitCheckpointStoryboardGeometryMorphRecordProfile } from "./checkpoint-storyboard-geometry-morph-profile";
import { admitCheckpointStoryboardRetainedTraceRecordProfile } from "./checkpoint-storyboard-retained-trace-profile";
export { compileCheckpointStoryboardScalarSpatialPlan, readCheckpointStoryboardScalarSpatialRequest } from "./checkpoint-storyboard-scalar-spatial";
export { admitCheckpointStoryboardScalarSpatialRecordProfile } from "./checkpoint-storyboard-scalar-spatial";
export { createCheckpointStoryboard, readCheckpointStoryboard, readCheckpointStoryboardDescriptor } from "./checkpoint-storyboard-records";
export { createTransitionRecipe, readTransitionRecipeDescriptor } from "./checkpoint-storyboard-recipes";
export { snapshotCheckpointStoryboardData } from "./checkpoint-storyboard-data";
export type { CheckpointStoryboard, CheckpointStoryboardDescriptor } from "./checkpoint-storyboard-types";
export { CHECKPOINT_STORYBOARD_SCALAR_SPATIAL_REQUEST_SCHEMA } from "./checkpoint-storyboard-scalar-spatial-types";
import {
  CHECKPOINT_STORYBOARD_SCALAR_SPATIAL_LOWERER_PROFILE_SCHEMA,
  type CheckpointStoryboardScalarSpatialPlan,
  type CheckpointStoryboardScalarSpatialRequest,
} from "./checkpoint-storyboard-scalar-spatial-types";

export const CHECKPOINT_STORYBOARD_SCALAR_SPATIAL_MATERIALIZER_PROFILE_SCHEMA =
  "shellx-motion/private-checkpoint-storyboard-scalar-spatial-materializer-profile@1" as const;
export const CHECKPOINT_STORYBOARD_SCALAR_SPATIAL_MATERIALIZATION_SCHEMA =
  "shellx-motion/private-checkpoint-storyboard-scalar-spatial-materialization@1" as const;

const MAX_CHANGED_PROPERTY_PATHS = 320;
const MAX_COALESCED_ORDINARY_KEYS = 5_120;
const approvalBrand: unique symbol = Symbol("checkpoint-storyboard-scalar-spatial-materialization-approval");
const approvals = new WeakMap<CheckpointStoryboardScalarSpatialMaterializationApproval, ApprovedFacts>();

/** Closed C6C static-record union. Exact package/base checks remain in the selected resolver. */
export type CheckpointStoryboardC6CRecordProfile = "c6b1-scalar-spatial@1" | "c6b2-behavior@1" | "c6b3-relation@1" | "c6b4-relation-action@1" | "c6b5-lifecycle@1" | "c6b6-geometry-morph@1" | "c6b7-retained-trace@1";
/** Closed durable Debug record-store union; resolvers retain all exact package/base validation. */
export type CheckpointStoryboardC6CStoredRecordProfile = CheckpointStoryboardC6CRecordProfile;
export function admitCheckpointStoryboardC6CRecordProfile(value: unknown): { readonly storyboard: CheckpointStoryboard; readonly profile: CheckpointStoryboardC6CRecordProfile } {
  try {
    return Object.freeze({ storyboard: admitCheckpointStoryboardScalarSpatialRecordProfile(value), profile: "c6b1-scalar-spatial@1" as const });
  } catch (scalarError) {
    try {
      return Object.freeze({ storyboard: admitCheckpointStoryboardBehaviorRecordProfile(value), profile: "c6b2-behavior@1" as const });
    } catch {
      try {
        return Object.freeze({ storyboard: admitCheckpointStoryboardRelationRecordProfile(value), profile: "c6b3-relation@1" as const });
      } catch {
        try {
          return Object.freeze({ storyboard: admitCheckpointStoryboardRelationActionRecordProfile(value), profile: "c6b4-relation-action@1" as const });
        } catch {
          try {
            return Object.freeze({ storyboard: admitCheckpointStoryboardLifecycleRecordProfile(value), profile: "c6b5-lifecycle@1" as const });
          } catch {
            try {
              return Object.freeze({ storyboard: admitCheckpointStoryboardGeometryMorphRecordProfile(value), profile: "c6b6-geometry-morph@1" as const });
            } catch {
              try {
                return Object.freeze({ storyboard: admitCheckpointStoryboardRetainedTraceRecordProfile(value), profile: "c6b7-retained-trace@1" as const });
              } catch {
                throw scalarError;
              }
            }
          }
        }
      }
    }
  }
}

const profilePayload = freeze({
  schema: CHECKPOINT_STORYBOARD_SCALAR_SPATIAL_MATERIALIZER_PROFILE_SCHEMA,
  c6b1aLowererProfileSchema: CHECKPOINT_STORYBOARD_SCALAR_SPATIAL_LOWERER_PROFILE_SCHEMA,
  scalarEndpointRule: "adjacent-equal-next-edge-easing" as const,
  spatialEndpointRule: "adjacent-equal-same-tangent-mode" as const,
  naturalCaps: freeze({ maxChangedPropertyPaths: MAX_CHANGED_PROPERTY_PATHS, maxCoalescedOrdinaryKeys: MAX_COALESCED_ORDINARY_KEYS }),
});
export const CHECKPOINT_STORYBOARD_SCALAR_SPATIAL_MATERIALIZER_PROFILE = freeze({
  ...profilePayload,
  fingerprint: canonicalJsonSha256(profilePayload),
});

export interface CheckpointStoryboardScalarSpatialMaterializationApproval {
  readonly [approvalBrand]: "c6b1b-approved";
}

export interface CheckpointStoryboardScalarSpatialMaterializationProjection {
  readonly schema: typeof CHECKPOINT_STORYBOARD_SCALAR_SPATIAL_MATERIALIZATION_SCHEMA;
  readonly c6b1a: { readonly planFingerprint: string; readonly lowererProfileFingerprint: string };
  readonly materializerProfile: typeof CHECKPOINT_STORYBOARD_SCALAR_SPATIAL_MATERIALIZER_PROFILE;
  readonly scalar: readonly CheckpointStoryboardScalarSpatialScalarMaterialization[];
  readonly spatial: readonly CheckpointStoryboardScalarSpatialSpatialMaterialization[];
  readonly counts: { readonly changedPropertyPaths: number; readonly coalescedOrdinaryKeys: number };
  readonly fingerprint: string;
}

export interface CheckpointStoryboardScalarSpatialScalarMaterialization {
  readonly objectId: string;
  readonly layerId: string;
  readonly layerIndex: number;
  readonly property: "transform.rotation" | "transform.scale" | "opacity";
  readonly keyframes: readonly { readonly atMs: number; readonly value: number; readonly easing?: "linear" | "ease-in" | "ease-out" | "ease-in-out" }[];
}

export interface CheckpointStoryboardScalarSpatialSpatialMaterialization {
  readonly objectId: string;
  readonly layerId: string;
  readonly layerIndex: number;
  readonly keyframes: readonly {
    readonly atMs: number; readonly x: number; readonly y: number;
    readonly easing?: "linear" | "ease-in" | "ease-out" | "ease-in-out";
    readonly spatial: { readonly mode: "linear" | "auto"; readonly in: { readonly x: 0; readonly y: 0 }; readonly out: { readonly x: 0; readonly y: 0 } };
  }[];
}

interface ApprovedFacts {
  readonly request: CheckpointStoryboardScalarSpatialRequest;
  readonly plan: CheckpointStoryboardScalarSpatialPlan;
  readonly projection: CheckpointStoryboardScalarSpatialMaterializationProjection;
}

/** Mint only from a frozen C6B1a request/plan pair that recompiles exactly. */
export function approveCheckpointStoryboardScalarSpatialMaterialization(value: unknown): CheckpointStoryboardScalarSpatialMaterializationApproval {
  const raw = exactObject(value, "CheckpointStoryboard C6B1b approval");
  if (!Object.isFrozen(raw)) throw new Error("CheckpointStoryboard C6B1b approval must be frozen.");
  const requestValue = data(raw, "request", "CheckpointStoryboard C6B1b approval");
  const planValue = data(raw, "plan", "CheckpointStoryboard C6B1b approval");
  exactKeys(raw, ["request", "plan"], "CheckpointStoryboard C6B1b approval");
  if (!isFrozenObject(requestValue) || !isFrozenObject(planValue)) throw new Error("CheckpointStoryboard C6B1b approval requires frozen accepted request and plan.");
  const request = readCheckpointStoryboardScalarSpatialRequest(requestValue);
  const plan = compileCheckpointStoryboardScalarSpatialPlan(request);
  if (canonicalJsonSha256(snapshotCheckpointStoryboardData(planValue)) !== canonicalJsonSha256(plan)) {
    throw new Error("CheckpointStoryboard C6B1b approval plan is not the accepted C6B1a plan.");
  }
  const projection = projectCheckpointStoryboardScalarSpatialMaterialization(request, plan);
  const approval = Object.freeze({ [approvalBrand]: "c6b1b-approved" as const });
  approvals.set(approval, freeze({ request, plan, projection }));
  return approval;
}

/** Internal host handoff. A copied or structurally similar object has no authority. */
export function readApprovedCheckpointStoryboardScalarSpatialMaterialization(
  approval: unknown,
): Readonly<ApprovedFacts> {
  if (!approval || typeof approval !== "object") throw new Error("CheckpointStoryboard C6B1b approval is invalid.");
  const facts = approvals.get(approval as CheckpointStoryboardScalarSpatialMaterializationApproval);
  if (!facts || (approval as CheckpointStoryboardScalarSpatialMaterializationApproval)[approvalBrand] !== "c6b1b-approved") {
    throw new Error("CheckpointStoryboard C6B1b approval is not host-minted.");
  }
  const rebuilt = compileCheckpointStoryboardScalarSpatialPlan(facts.request);
  if (!same(rebuilt, facts.plan)) throw new Error("CheckpointStoryboard C6B1b approval no longer revalidates its C6B1a plan.");
  const projected = projectCheckpointStoryboardScalarSpatialMaterialization(facts.request, rebuilt);
  if (!same(projected, facts.projection)) throw new Error("CheckpointStoryboard C6B1b approval no longer revalidates its materialization projection.");
  return facts;
}

/** Pure C6B1b projection/revalidation. It performs neither package I/O nor mutation. */
export function projectCheckpointStoryboardScalarSpatialMaterialization(
  requestValue: unknown,
  planValue: unknown,
): CheckpointStoryboardScalarSpatialMaterializationProjection {
  const request = readCheckpointStoryboardScalarSpatialRequest(requestValue);
  const rebuilt = compileCheckpointStoryboardScalarSpatialPlan(request);
  if (!same(rebuilt, planValue)) throw new Error("CheckpointStoryboard C6B1b requires the exact canonical C6B1a plan.");
  const scalars = new Map<string, ScalarCandidate[]>();
  const spatials = new Map<string, SpatialCandidate[]>();
  const edgeIndex = new Map(request.storyboard.edges.map((edge, index) => [edge.id, index]));
  for (const lowering of rebuilt.lowerings) {
    const index = edgeIndex.get(lowering.edge.id);
    if (index === undefined || !sameEdge(lowering.edge, request.storyboard.edges[index]!)) throw new Error("CheckpointStoryboard C6B1b lowering edge is not canonical.");
    if (lowering.kind === "checkpoint-keyframe") for (const property of lowering.properties) {
      assertScalarPair(property.keyframes, lowering.edge.id);
      const key = `${lowering.object.layerIndex}\u0000${lowering.object.layerId}\u0000${property.property}`;
      const entries = scalars.get(key) ?? []; entries.push({ index, edge: lowering.edge, object: lowering.object, property: property.property, frames: property.keyframes }); scalars.set(key, entries);
    } else {
      assertSpatialPair(lowering.keyframes.x, lowering.keyframes.y, lowering.tangentMode, lowering.edge.id);
      const key = `${lowering.object.layerIndex}\u0000${lowering.object.layerId}`;
      const entries = spatials.get(key) ?? []; entries.push({ index, edge: lowering.edge, object: lowering.object, tangentMode: lowering.tangentMode, x: lowering.keyframes.x, y: lowering.keyframes.y }); spatials.set(key, entries);
    }
  }
  const scalar = freeze([...scalars.values()].map(coalesceScalar));
  const spatial = freeze([...spatials.values()].map(coalesceSpatial));
  const counts = freeze({
    changedPropertyPaths: scalar.length + spatial.length * 2,
    coalescedOrdinaryKeys: scalar.reduce((total, entry) => total + entry.keyframes.length, 0) + spatial.reduce((total, entry) => total + entry.keyframes.length * 2, 0),
  });
  if (counts.changedPropertyPaths > MAX_CHANGED_PROPERTY_PATHS || counts.coalescedOrdinaryKeys > MAX_COALESCED_ORDINARY_KEYS) {
    throw new Error("CheckpointStoryboard C6B1b materialization exceeds its natural keyframe or property-path cap.");
  }
  const payload = {
    schema: CHECKPOINT_STORYBOARD_SCALAR_SPATIAL_MATERIALIZATION_SCHEMA,
    c6b1a: freeze({ planFingerprint: rebuilt.fingerprint, lowererProfileFingerprint: rebuilt.lowererProfile.fingerprint }),
    materializerProfile: CHECKPOINT_STORYBOARD_SCALAR_SPATIAL_MATERIALIZER_PROFILE,
    scalar, spatial, counts,
  };
  return freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}

/** Reopen a detached base request and prove it recompiles to the exact approved C6B1a/C6B1b pair. */
export function revalidateCheckpointStoryboardScalarSpatialMaterialization(
  requestValue: unknown,
  approvedPlan: unknown,
  approvedProjection: unknown,
): Readonly<{ plan: CheckpointStoryboardScalarSpatialPlan; projection: CheckpointStoryboardScalarSpatialMaterializationProjection }> {
  const request = readCheckpointStoryboardScalarSpatialRequest(requestValue);
  const plan = compileCheckpointStoryboardScalarSpatialPlan(request);
  if (!same(plan, approvedPlan)) throw new Error("CheckpointStoryboard C6B1b reopened C6B1a plan differs from approval.");
  const projection = projectCheckpointStoryboardScalarSpatialMaterialization(request, plan);
  if (!same(projection, approvedProjection)) throw new Error("CheckpointStoryboard C6B1b reopened projection differs from approval.");
  return freeze({ plan, projection });
}

type ScalarCandidate = { index: number; edge: { readonly id: string; readonly fromCheckpointId: string; readonly toCheckpointId: string }; object: { readonly objectId: string; readonly layerId: string; readonly layerIndex: number }; property: CheckpointStoryboardScalarSpatialScalarMaterialization["property"]; frames: readonly { readonly atMs: number; readonly value: number; readonly easing?: "linear" | "ease-in" | "ease-out" | "ease-in-out" }[] };
type SpatialCandidate = { index: number; edge: ScalarCandidate["edge"]; object: ScalarCandidate["object"]; tangentMode: "linear" | "auto"; x: readonly { readonly atMs: number; readonly value: number; readonly easing?: "linear" | "ease-in" | "ease-out" | "ease-in-out"; readonly spatial?: unknown }[]; y: readonly { readonly atMs: number; readonly value: number; readonly easing?: "linear" | "ease-in" | "ease-out" | "ease-in-out" }[] };

function coalesceScalar(input: readonly ScalarCandidate[]): CheckpointStoryboardScalarSpatialScalarMaterialization {
  const entries = [...input].sort((left, right) => left.index - right.index);
  const first = entries[0]!; const keyframes: Array<{ atMs: number; value: number; easing?: "linear" | "ease-in" | "ease-out" | "ease-in-out" }> = [];
  let prior: ScalarCandidate | undefined;
  for (const entry of entries) {
    const [start, end] = entry.frames;
    if (prior && start.atMs === keyframes.at(-1)!.atMs) {
      if (entry.index !== prior.index + 1 || prior.edge.toCheckpointId !== entry.edge.fromCheckpointId) throw new Error("CheckpointStoryboard C6B1b refuses nonadjacent scalar endpoint duplicates.");
      if (start.value !== keyframes.at(-1)!.value) throw new Error("CheckpointStoryboard C6B1b refuses conflicting scalar endpoint values.");
      keyframes[keyframes.length - 1] = { ...keyframes.at(-1)!, easing: start.easing };
    } else {
      if (keyframes.some((frame) => frame.atMs === start.atMs) || (keyframes.length && start.atMs < keyframes.at(-1)!.atMs)) throw new Error("CheckpointStoryboard C6B1b refuses noncanonical scalar endpoint duplicates.");
      keyframes.push({ atMs: start.atMs, value: start.value, easing: start.easing });
    }
    if (keyframes.some((frame) => frame.atMs === end.atMs)) throw new Error("CheckpointStoryboard C6B1b refuses noncanonical scalar endpoint duplicates.");
    keyframes.push({ atMs: end.atMs, value: end.value }); prior = entry;
  }
  return freeze({ objectId: first.object.objectId, layerId: first.object.layerId, layerIndex: first.object.layerIndex, property: first.property, keyframes: freeze(keyframes) });
}

function coalesceSpatial(input: readonly SpatialCandidate[]): CheckpointStoryboardScalarSpatialSpatialMaterialization {
  const entries = [...input].sort((left, right) => left.index - right.index);
  const first = entries[0]!; const keyframes: Array<{ atMs: number; x: number; y: number; easing?: "linear" | "ease-in" | "ease-out" | "ease-in-out"; spatial: CheckpointStoryboardScalarSpatialSpatialMaterialization["keyframes"][number]["spatial"] }> = [];
  let prior: SpatialCandidate | undefined;
  for (const entry of entries) {
    const [startX, endX] = entry.x, [startY, endY] = entry.y;
    const start = point(startX, startY, entry.tangentMode), end = point(endX, endY, entry.tangentMode);
    if (prior && start.atMs === keyframes.at(-1)!.atMs) {
      if (entry.index !== prior.index + 1 || prior.edge.toCheckpointId !== entry.edge.fromCheckpointId) throw new Error("CheckpointStoryboard C6B1b refuses nonadjacent spatial endpoint duplicates.");
      if (prior.tangentMode !== entry.tangentMode) throw new Error("CheckpointStoryboard C6B1b refuses a spatial tangent-mode discontinuity at a shared checkpoint.");
      if (start.x !== keyframes.at(-1)!.x || start.y !== keyframes.at(-1)!.y) throw new Error("CheckpointStoryboard C6B1b refuses conflicting spatial endpoint values.");
      keyframes[keyframes.length - 1] = { ...keyframes.at(-1)!, easing: start.easing, spatial: start.spatial };
    } else {
      if (keyframes.some((frame) => frame.atMs === start.atMs) || (keyframes.length && start.atMs < keyframes.at(-1)!.atMs)) throw new Error("CheckpointStoryboard C6B1b refuses noncanonical spatial endpoint duplicates.");
      keyframes.push(start);
    }
    if (keyframes.some((frame) => frame.atMs === end.atMs)) throw new Error("CheckpointStoryboard C6B1b refuses noncanonical spatial endpoint duplicates.");
    keyframes.push({ ...end, easing: undefined }); prior = entry;
  }
  return freeze({ objectId: first.object.objectId, layerId: first.object.layerId, layerIndex: first.object.layerIndex, keyframes: freeze(keyframes.map(({ easing, ...frame }) => freeze({ ...frame, ...(easing ? { easing } : {}) }))) });
}

function assertScalarPair(frames: readonly { readonly atMs: number; readonly value: number; readonly easing?: unknown }[], edgeId: string): void {
  const [start, end] = frames;
  if (frames.length !== 2 || !start || !end || !Number.isFinite(start.value) || !Number.isFinite(end.value) || start.atMs >= end.atMs || !easing(start.easing) || end.easing !== undefined) throw new Error(`CheckpointStoryboard C6B1b scalar lowering '${edgeId}' is not canonical.`);
}
function assertSpatialPair(x: SpatialCandidate["x"], y: SpatialCandidate["y"], mode: "linear" | "auto", edgeId: string): void {
  const [startX, endX] = x, [startY, endY] = y;
  if (x.length !== 2 || y.length !== 2 || !startX || !endX || !startY || !endY || startX.atMs !== startY.atMs || endX.atMs !== endY.atMs || startX.atMs >= endX.atMs || startX.easing !== "linear" || startY.easing !== "linear" || endX.easing !== "linear" || endY.easing !== undefined || !spatial(startX.spatial, mode) || !spatial(endX.spatial, mode) || Object.hasOwn(startY, "spatial") || Object.hasOwn(endY, "spatial")) throw new Error(`CheckpointStoryboard C6B1b spatial lowering '${edgeId}' is not canonical.`);
}
function point(x: SpatialCandidate["x"][number], y: SpatialCandidate["y"][number], mode: "linear" | "auto") { return freeze({ atMs: x.atMs, x: x.value, y: y.value, ...(easing(x.easing) ? { easing: x.easing } : {}), spatial: freeze({ mode, in: freeze({ x: 0 as const, y: 0 as const }), out: freeze({ x: 0 as const, y: 0 as const }) }) }); }
function spatial(value: unknown, mode: "linear" | "auto"): boolean { return !!value && typeof value === "object" && same(value, { mode, in: { x: 0, y: 0 }, out: { x: 0, y: 0 } }); }
function sameEdge(left: { readonly id: string; readonly fromCheckpointId: string; readonly toCheckpointId: string }, right: { readonly id: string; readonly fromCheckpointId: string; readonly toCheckpointId: string }): boolean { return left.id === right.id && left.fromCheckpointId === right.fromCheckpointId && left.toCheckpointId === right.toCheckpointId; }
function easing(value: unknown): value is "linear" | "ease-in" | "ease-out" | "ease-in-out" { return value === "linear" || value === "ease-in" || value === "ease-out" || value === "ease-in-out"; }
function same(left: unknown, right: unknown): boolean { return canonicalJsonSha256(left) === canonicalJsonSha256(right); }
function isFrozenObject(value: unknown): value is object { return !!value && typeof value === "object" && Object.isFrozen(value); }
function exactObject(value: unknown, label: string): object { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object.`); return value; }
function data(value: object, key: string, label: string): unknown { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error(`${label}.${key} must be an enumerable data field.`); return descriptor.value; }
function exactKeys(value: object, expected: readonly string[], label: string): void { const keys = Reflect.ownKeys(value); if (keys.length !== expected.length || keys.some((key) => typeof key !== "string" || !expected.includes(key)) || expected.some((key) => !keys.includes(key))) throw new Error(`${label} has unsupported fields.`); }
