/** Private C6B6a admission and pure GPU-targeted triangle geometry-morph plan. */

import { canonicalJsonSha256 } from "../../canonical-json";
import { evaluateMotionShapeGeometryKeyframes, MOTION_SHAPE_GEOMETRY_KEYFRAMES_SCHEMA } from "../../motion-shape-geometry-keyframes";
import { readPackageManifest, readMotionDocument } from "../../package";
import type { MotionDocument, MotionShapeGeometry, PackageManifest } from "../../types";
import { loadSchemaSync, validateDocumentSync } from "../../validate";
import { compileCheckpointStoryboardPlan, readCheckpointStoryboard } from "./checkpoint-storyboard-records";
import { exactArray, exactRecord, freeze, safeId, sha256, snapshotCheckpointStoryboardData } from "./checkpoint-storyboard-data";
import type { CheckpointStoryboard } from "./checkpoint-storyboard-types";
import {
  CHECKPOINT_STORYBOARD_GEOMETRY_MORPH_PROFILE_PLAN_SCHEMA,
  CHECKPOINT_STORYBOARD_GEOMETRY_MORPH_PROFILE_REQUEST_SCHEMA,
  CHECKPOINT_STORYBOARD_GEOMETRY_MORPH_PROFILE_SCHEMA,
  type CheckpointStoryboardGeometryMorphAreaProof,
  type CheckpointStoryboardGeometryMorphKeyframes,
  type CheckpointStoryboardGeometryMorphProfilePlan,
  type CheckpointStoryboardGeometryMorphProfileRequest,
  type CheckpointStoryboardGeometryMorphTriangle,
} from "./checkpoint-storyboard-geometry-morph-profile-types";

type GeometryStoryboard = CheckpointStoryboard & {
  readonly objectCatalog: readonly { readonly objectId: string; readonly rootShapeKind: "geometry"; readonly propertyMask: readonly [] }[];
  readonly checkpoints: readonly { readonly id: string; readonly atUs: number; readonly objects: readonly { readonly objectId: string; readonly state: "present"; readonly properties: readonly []; readonly geometry: unknown }[] }[];
  readonly edges: readonly { readonly id: string; readonly fromCheckpointId: string; readonly toCheckpointId: string; readonly lifecycle: readonly { readonly kind: "preserve"; readonly objectId: string }[]; readonly recipeIds: readonly string[] }[];
  readonly recipes: readonly { readonly id: string; readonly sha256: string; readonly revision: number; readonly recipeId: string; readonly exactBaseRequirements: readonly []; readonly intent: { readonly kind: "checkpoint-geometry-morph"; readonly targets: readonly { readonly objectId: string; readonly easing: "linear" }[] } }[];
};

const FORBIDDEN_MOTION_AUTHORITIES = ["tracks", "relationships", "behaviors", "relations", "relationActions", "layoutGapAnimation", "layoutApplications", "scene3dAnimation", "audio"] as const;
const FORBIDDEN_LAYER_AUTHORITIES = [
  "childLayerIds", "trackId", "keyframes", "transitions", "tracking", "stabilization", "stabilize", "transformAuthority", "timingAuthority",
  "timeRemap", "trimStartMs", "trimDurationMs", "loop", "playbackRate", "x-tracking-stabilization", "depth", "matte", "mask", "keying",
  "effects", "effectModule", "geometryKeyframes", "morph", "width", "height", "source", "src", "assetId", "assetRef", "includeAudio",
  "volume", "pan", "muted", "fadeInMs", "fadeOutMs", "fadeCurve", "normalizeLoudness", "ducking", "fit", "crop", "allowedOrigins",
  "gradient", "pathReveal", "emitter", "pointCloud", "shader", "scene3d", "environment",
] as const;
const PROFILE_PAYLOAD = freeze({ schema: CHECKPOINT_STORYBOARD_GEOMETRY_MORPH_PROFILE_SCHEMA, requiredCapability: "renderer.gpu" as const, rootShapeKind: "geometry" as const, geometryKind: "polygon" as const, pointCount: 3 as const, correspondence: "ordinal" as const, easing: "linear" as const, lifecycle: "preserve" as const, ownedWriteMask: ["geometry"] as const });
const BUDGET = freeze({ objects: 1 as const, checkpoints: 2 as const, edges: 1 as const, recipes: 1 as const, snapshots: 2 as const, interpolationScalars: 6 as const, changedPaths: 1 as const });
const MIN_ABSOLUTE_TWICE_AREA = 1e-6;

/** Base-independent C6B6a admission: geometry records remain inert until a later resolver selects a package. */
export function admitCheckpointStoryboardGeometryMorphRecordProfile(value: unknown): CheckpointStoryboard {
  const storyboard = readCheckpointStoryboard(value) as GeometryStoryboard;
  assertStaticProfile(storyboard);
  return storyboard;
}

/** Strict detached-input reader. The shared C6 snapshot rejects accessors before semantics inspect them. */
export function readCheckpointStoryboardGeometryMorphProfileRequest(value: unknown): CheckpointStoryboardGeometryMorphProfileRequest {
  const root = exactRecord(snapshotCheckpointStoryboardData(value), ["schema", "storyboard", "base", "objectLayerBindings"], [], "CheckpointStoryboard geometry-morph profile request");
  if (root.schema !== CHECKPOINT_STORYBOARD_GEOMETRY_MORPH_PROFILE_REQUEST_SCHEMA) throw new Error(`CheckpointStoryboard geometry-morph profile request.schema must equal ${CHECKPOINT_STORYBOARD_GEOMETRY_MORPH_PROFILE_REQUEST_SCHEMA}.`);
  const storyboard = readCheckpointStoryboard(root.storyboard) as GeometryStoryboard;
  const base = readBase(root.base);
  const entries = exactArray(root.objectLayerBindings, "CheckpointStoryboard geometry-morph profile objectLayerBindings", 1, 1);
  const entry = exactRecord(entries[0], ["objectId", "layerId"], [], "CheckpointStoryboard geometry-morph profile objectLayerBindings[0]");
  const objectId = safeId(entry.objectId, "CheckpointStoryboard geometry-morph profile objectLayerBindings[0].objectId");
  const layerId = safeId(entry.layerId, "CheckpointStoryboard geometry-morph profile objectLayerBindings[0].layerId");
  if (objectId !== storyboard.objectCatalog[0]?.objectId || objectId !== layerId) throw new Error("CheckpointStoryboard geometry-morph profile requires one exact same-ID object/layer binding.");
  return freeze({ schema: CHECKPOINT_STORYBOARD_GEOMETRY_MORPH_PROFILE_REQUEST_SCHEMA, storyboard, base, objectLayerBindings: freeze([freeze({ objectId, layerId })]) as CheckpointStoryboardGeometryMorphProfileRequest["objectLayerBindings"] });
}

/** Produces a frozen two-snapshot geometryKeyframes intent without renderer or execution authority. */
export function compileCheckpointStoryboardGeometryMorphProfilePlan(value: unknown): CheckpointStoryboardGeometryMorphProfilePlan {
  const request = readCheckpointStoryboardGeometryMorphProfileRequest(value), storyboard = request.storyboard as GeometryStoryboard;
  const profile = assertStaticProfile(storyboard), motion = request.base.motion;
  const [from, to] = storyboard.checkpoints;
  if (to!.atUs !== motion.durationMs * 1_000) throw new Error("CheckpointStoryboard geometry-morph profile requires its final checkpoint at the exact document end.");
  const layer = assertBase(motion, request.objectLayerBindings[0]!.layerId);
  const start = geometryEvaluation(from!.objects[0]!.geometry, from!.atUs, "start"), end = geometryEvaluation(to!.objects[0]!.geometry, to!.atUs, "end");
  if (canonicalJsonSha256(layer.geometry) !== start.sha256) throw new Error("CheckpointStoryboard geometry-morph profile requires static base geometry to equal the first checkpoint snapshot.");
  const topology = assertTopology(start.geometry, end.geometry);
  const areaProof = proveTriangleArea(start.geometry, end.geometry);
  const geometryKeyframes = freeze({ schema: MOTION_SHAPE_GEOMETRY_KEYFRAMES_SCHEMA, keyframes: freeze([
    freeze({ atUs: from!.atUs, geometry: start.geometry, easing: "linear" as const }), freeze({ atUs: to!.atUs, geometry: end.geometry }),
  ]) }) as CheckpointStoryboardGeometryMorphKeyframes;
  const c6a = compileCheckpointStoryboardPlan(storyboard);
  const lowererProfile = freeze({ ...PROFILE_PAYLOAD, fingerprint: canonicalJsonSha256(PROFILE_PAYLOAD) });
  const payload = {
    schema: CHECKPOINT_STORYBOARD_GEOMETRY_MORPH_PROFILE_PLAN_SCHEMA,
    storyboard: freeze({ id: storyboard.id, sha256: storyboard.sha256, revision: storyboard.revision, fingerprint: c6a.fingerprint }),
    base: freeze({ package: freeze({ id: request.base.packageId, motionPath: request.base.manifest.motion }), manifest: freeze({ id: request.base.manifest.id, sha256: canonicalJsonSha256(request.base.manifest) }), canonicalMotion: freeze({ id: motion.id, sha256: canonicalJsonSha256(motion) }), persistedMotion: freeze({ id: motion.id, sha256: request.base.persistedMotionSha256 }) }),
    lowererProfile,
    objectLayerBinding: freeze({ objectId: profile.objectId, layerId: profile.objectId, layerIndex: 0 as const, rootShapeKind: "geometry" as const }),
    projection: freeze({ edge: freeze({ id: profile.edge.id, fromCheckpointId: profile.edge.fromCheckpointId, toCheckpointId: profile.edge.toCheckpointId }), recipe: freeze({ id: profile.recipe.id, sha256: profile.recipe.sha256, revision: profile.recipe.revision, recipeId: profile.recipe.recipeId }), path: "/layers/0/geometryKeyframes" as const, staticGeometry: freeze({ sha256: start.sha256, geometry: start.geometry }), endpoints: freeze([freeze({ atUs: from!.atUs, geometry: start.geometry, sha256: start.sha256, evaluationFingerprint: start.evaluationFingerprint }), freeze({ atUs: to!.atUs, geometry: end.geometry, sha256: end.sha256, evaluationFingerprint: end.evaluationFingerprint })] as const), geometryKeyframes, topology, areaProof }),
    intendedChanges: freeze({ paths: freeze(["/layers/0/geometryKeyframes"] as ["/layers/0/geometryKeyframes"]), geometryKeyframes: freeze({ operation: "replace-absent" as const, keyframeCount: 2 as const }) }), budget: BUDGET,
    evidence: freeze({ noPackageIO: true as const, noPackageWrites: true as const, noCOW: true as const, noReceipt: true as const, noPublicSurface: true as const, noRenderer: true as const }),
  };
  return freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}

function readBase(value: unknown): CheckpointStoryboardGeometryMorphProfileRequest["base"] {
  const record = exactRecord(value, ["packageId", "manifest", "motion", "persistedMotionSha256"], [], "CheckpointStoryboard geometry-morph profile base");
  const packageId = safeId(record.packageId, "CheckpointStoryboard geometry-morph profile base.packageId");
  assertDocument("manifest", "packageManifest", record.manifest); assertDocument("Motion document", "motion", record.motion);
  const manifest = readPackageManifest(record.manifest), motion = readMotionDocument(record.motion);
  if (manifest.id !== packageId || !cleanMotionPath(manifest.motion)) throw new Error("CheckpointStoryboard geometry-morph profile base must use an exact package-relative Motion manifest.");
  if (!Number.isSafeInteger(motion.durationMs) || motion.durationMs < 1 || motion.durationMs > 3_600_000) throw new Error("CheckpointStoryboard geometry-morph profile base.motion.durationMs must be bounded positive safe integer.");
  return freeze({ packageId, manifest: freeze(manifest) as PackageManifest, motion: freeze(motion), persistedMotionSha256: sha256(record.persistedMotionSha256, "CheckpointStoryboard geometry-morph profile base.persistedMotionSha256") });
}

function assertStaticProfile(storyboard: GeometryStoryboard) {
  if (storyboard.capabilityRequirements.length !== 1 || storyboard.capabilityRequirements[0] !== "renderer.gpu") throw new Error("CheckpointStoryboard geometry-morph profile requires exactly renderer.gpu.");
  if (storyboard.objectCatalog.length !== 1 || storyboard.checkpoints.length !== 2 || storyboard.edges.length !== 1 || storyboard.recipes.length !== 1) throw new Error("CheckpointStoryboard geometry-morph profile requires exactly one object, two checkpoints, one edge, and one recipe.");
  const catalog = storyboard.objectCatalog[0]!, [from, to] = storyboard.checkpoints, edge = storyboard.edges[0]!, recipe = storyboard.recipes[0]!;
  if (catalog.rootShapeKind !== "geometry" || catalog.propertyMask.length !== 0 || from!.atUs !== 0 || from!.atUs % 1_000 !== 0 || to!.atUs % 1_000 !== 0 || edge.fromCheckpointId !== from!.id || edge.toCheckpointId !== to!.id || edge.lifecycle.length !== 1 || edge.lifecycle[0]!.kind !== "preserve" || edge.lifecycle[0]!.objectId !== catalog.objectId || edge.recipeIds.length !== 1 || edge.recipeIds[0] !== recipe.recipeId || recipe.exactBaseRequirements.length !== 0) throw new Error("CheckpointStoryboard geometry-morph profile requires one geometry object preserved from zero through one closed edge.");
  if (from!.objects.length !== 1 || to!.objects.length !== 1 || from!.objects[0]!.objectId !== catalog.objectId || to!.objects[0]!.objectId !== catalog.objectId || from!.objects[0]!.properties.length !== 0 || to!.objects[0]!.properties.length !== 0 || recipe.intent.kind !== "checkpoint-geometry-morph" || recipe.intent.targets.length !== 1 || recipe.intent.targets[0]!.objectId !== catalog.objectId || recipe.intent.targets[0]!.easing !== "linear") throw new Error("CheckpointStoryboard geometry-morph profile requires one present empty-scalar geometry state and one linear same-object recipe.");
  return { objectId: catalog.objectId, edge, recipe };
}

function assertBase(motion: MotionDocument, layerId: string): MotionDocument["layers"][number] & { readonly geometry: MotionShapeGeometry } {
  if (motion.assets.length !== 0 || motion.layers.length !== 1) throw new Error("CheckpointStoryboard geometry-morph profile requires an asset-free one-layer base.");
  for (const field of FORBIDDEN_MOTION_AUTHORITIES) if (Object.hasOwn(motion, field)) throw new Error(`CheckpointStoryboard geometry-morph profile refuses existing ${field} authority.`);
  if (Object.hasOwn(motion, "traces") || Object.hasOwn(motion, "parametricTrace") || Object.hasOwn(motion, "parametricTraces")) throw new Error("CheckpointStoryboard geometry-morph profile refuses trace authority.");
  const layer = motion.layers[0]! as MotionDocument["layers"][number] & { readonly geometry?: MotionShapeGeometry };
  if (layer.id !== layerId || layer.type !== "shape" || layer.visible === false || layer.locked === true || Object.hasOwn(layer, "shape") || !layer.geometry || layer.startMs !== 0 || layer.durationMs !== motion.durationMs) throw new Error("CheckpointStoryboard geometry-morph profile requires one visible unlocked root-owned v1 geometry layer spanning the document.");
  if (FORBIDDEN_LAYER_AUTHORITIES.some((field) => Object.hasOwn(layer, field))) throw new Error("CheckpointStoryboard geometry-morph profile refuses existing geometry, transform, timing, or effect authority.");
  return layer as MotionDocument["layers"][number] & { readonly geometry: MotionShapeGeometry };
}

function geometryEvaluation(value: unknown, atUs: number, label: string): { readonly geometry: CheckpointStoryboardGeometryMorphTriangle; readonly sha256: string; readonly evaluationFingerprint: string } {
  const result = evaluateMotionShapeGeometryKeyframes({ schema: MOTION_SHAPE_GEOMETRY_KEYFRAMES_SCHEMA, atUs, keyframes: [{ atUs, geometry: value }] });
  if (!result.ok) throw new Error(`CheckpointStoryboard geometry-morph profile ${label} geometry is invalid: ${result.message}`);
  const geometry = result.evaluation.geometry;
  if (geometry.kind !== "polygon" || geometry.points.length !== 3) throw new Error("CheckpointStoryboard geometry-morph profile supports only v1 three-point polygon geometry.");
  const triangle = geometry as unknown as CheckpointStoryboardGeometryMorphTriangle;
  return freeze({ geometry: triangle, sha256: canonicalJsonSha256(triangle), evaluationFingerprint: result.evaluation.fingerprint });
}

function assertTopology(start: CheckpointStoryboardGeometryMorphTriangle, end: CheckpointStoryboardGeometryMorphTriangle) {
  if (start.kind !== "polygon" || end.kind !== "polygon" || start.points.length !== 3 || end.points.length !== 3 || canonicalJsonSha256(start.viewBox) !== canonicalJsonSha256(end.viewBox)) throw new Error("CheckpointStoryboard geometry-morph profile requires one identical polygon viewBox and three ordinal points.");
  return freeze({ kind: "polygon" as const, viewBoxSha256: canonicalJsonSha256(start.viewBox), pointCount: 3 as const, correspondence: "ordinal" as const });
}

function proveTriangleArea(start: CheckpointStoryboardGeometryMorphTriangle, end: CheckpointStoryboardGeometryMorphTriangle): CheckpointStoryboardGeometryMorphAreaProof {
  if (start.kind !== "polygon" || end.kind !== "polygon") throw new Error("CheckpointStoryboard geometry-morph profile internal topology failure.");
  const area = (points: readonly { readonly x: number; readonly y: number }[]) => cross(subtract(points[1]!, points[0]!), subtract(points[2]!, points[0]!));
  const a0 = start.points, a1 = end.points, d01 = subtract(subtract(a1[1]!, a1[0]!), subtract(a0[1]!, a0[0]!)), d02 = subtract(subtract(a1[2]!, a1[0]!), subtract(a0[2]!, a0[0]!));
  const constant = area(a0), linear = cross(d01, subtract(a0[2]!, a0[0]!)) + cross(subtract(a0[1]!, a0[0]!), d02), quadratic = cross(d01, d02);
  const witnessTimes = quadratic === 0 ? [0, 1] : (() => { const vertex = -linear / (2 * quadratic); return vertex > 0 && vertex < 1 ? [0, vertex, 1] : [0, 1]; })();
  const witnessTwiceAreas = witnessTimes.map((time) => constant + linear * time + quadratic * time * time);
  const orientation = witnessTwiceAreas[0]! > 0 ? "counterclockwise" as const : "clockwise" as const;
  if (witnessTwiceAreas.some((value) => !Number.isFinite(value) || Math.abs(value) < MIN_ABSOLUTE_TWICE_AREA || (value > 0 ? "counterclockwise" : "clockwise") !== orientation)) throw new Error("CheckpointStoryboard geometry-morph profile refuses a triangle whose signed area can reach zero or flip orientation.");
  return freeze({ polynomial: freeze({ constant, linear, quadratic }), orientation, minimumAbsoluteTwiceArea: Math.min(...witnessTwiceAreas.map(Math.abs)), witnessTimes: freeze(witnessTimes), witnessTwiceAreas: freeze(witnessTwiceAreas) });
}

function assertDocument(label: string, schema: "packageManifest" | "motion", value: unknown): void { const result = validateDocumentSync(loadSchemaSync(schema), value); if (!result.ok) throw new Error(`CheckpointStoryboard geometry-morph profile ${label} is invalid at ${result.errors[0]!.path || "/"}: ${result.errors[0]!.message}`); }
function cleanMotionPath(value: string): boolean { return value.length > 0 && value.length <= 256 && value === value.normalize("NFC") && !/[\u0000-\u001F\u007F-\u009F]/u.test(value) && !value.split("/").some((part) => part === "." || part === ".." || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)); }
function subtract(left: { readonly x: number; readonly y: number }, right: { readonly x: number; readonly y: number }) { return { x: left.x - right.x, y: left.y - right.y }; }
function cross(left: { readonly x: number; readonly y: number }, right: { readonly x: number; readonly y: number }): number { return left.x * right.y - left.y * right.x; }
