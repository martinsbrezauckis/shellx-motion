import { canonicalJsonSha256 } from "../../canonical-json";
import { readMotionBehaviorStore } from "../../motion-behavior-read";
import { type MotionBehaviorStore } from "../../motion-behavior-types";
import { baseTransform, validateMotionBehaviors } from "../../motion-behavior-validate";
import { evaluateMotionTransformBehavior, type MotionTransformBehaviorEvaluation } from "../../motion-transform-behavior";
import type { MotionDocument, MotionLayer, PackageManifest } from "../../types";
import { compileCheckpointStoryboardPlan, readCheckpointStoryboard } from "./checkpoint-storyboard-records";
import { exactArray, exactRecord, freeze, safeId, sha256, snapshotCheckpointStoryboardData } from "./checkpoint-storyboard-data";
import type { CheckpointBehaviorIntent, CheckpointObjectState, CheckpointProperty, CheckpointStoryboard, CheckpointTransformBehavior } from "./checkpoint-storyboard-types";
import {
  CHECKPOINT_STORYBOARD_BEHAVIOR_PROFILE_PLAN_SCHEMA,
  CHECKPOINT_STORYBOARD_BEHAVIOR_PROFILE_REQUEST_SCHEMA,
  CHECKPOINT_STORYBOARD_BEHAVIOR_PROFILE_SCHEMA,
  type CheckpointStoryboardBehaviorOwnedProperty,
  type CheckpointStoryboardBehaviorProfilePlan,
  type CheckpointStoryboardBehaviorProfileRequest,
} from "./checkpoint-storyboard-behavior-profile-types";

const PROFILE_PAYLOAD = freeze({
  schema: CHECKPOINT_STORYBOARD_BEHAVIOR_PROFILE_SCHEMA,
  requiredCapability: "renderer.gpu" as const,
  rootShapeKinds: ["rect", "ellipse"] as const,
  behaviorKinds: ["gravity", "bounce"] as const,
  endpointRule: "direct-exact-us-equality" as const,
});
const FORBIDDEN_MOTION_AUTHORITIES = [
  "behaviors", "relationships", "relations", "relationActions", "layoutGapAnimation", "layoutApplications", "scene3dAnimation", "tracks",
] as const;
const FORBIDDEN_LAYER_OVERLAYS = [
  "keyframes", "transitions", "tracking", "stabilization", "stabilize", "transformAuthority", "timingAuthority", "timeRemap", "trimStartMs", "trimDurationMs", "loop", "playbackRate", "x-tracking-stabilization",
] as const;

/** Compiles exactly one sealed C6A transform behavior into one behaviors@1 root binding. */
export function compileCheckpointStoryboardBehaviorProfilePlan(value: unknown): CheckpointStoryboardBehaviorProfilePlan {
  const request = readCheckpointStoryboardBehaviorProfileRequest(value);
  const storyboard = request.storyboard;
  const profile = assertProfile(storyboard, request.base.motion);
  const behaviorIntent = profile.recipe.intent as CheckpointBehaviorIntent;
  const layer = assertBaseLayer(request, profile.ownedPropertyMask);
  const binding = freeze({
    targetLayerId: profile.objectId,
    enabled: true,
    kind: "transform" as const,
    startUs: profile.from.atUs,
    durationUs: profile.to.atUs - profile.from.atUs,
    motion: behaviorIntent.behavior,
  });
  const store = freeze(readMotionBehaviorStore({ schema: "shellx-motion/behaviors@1", bindings: [binding] }));
  assertBehaviorSemantics(request.base.motion, store);
  const base = baseTransform(layer as unknown as MotionLayer);
  const start = evaluate(profile.from.atUs, binding.startUs, binding.durationUs, base, binding.motion);
  const end = evaluate(profile.to.atUs, binding.startUs, binding.durationUs, base, binding.motion);
  assertEndpoint(start, profile.from.objects[0]!, profile.ownedPropertyMask, "start");
  assertEndpoint(end, profile.to.objects[0]!, profile.ownedPropertyMask, "end");
  const c6aPlan = compileCheckpointStoryboardPlan(storyboard);
  const lowererProfile = freeze({ ...PROFILE_PAYLOAD, fingerprint: canonicalJsonSha256(PROFILE_PAYLOAD) });
  const payload = {
    schema: CHECKPOINT_STORYBOARD_BEHAVIOR_PROFILE_PLAN_SCHEMA,
    storyboard: freeze({ id: storyboard.id, sha256: storyboard.sha256, revision: storyboard.revision, fingerprint: c6aPlan.fingerprint }),
    base: freeze({
      package: freeze({ id: request.base.packageId, motionPath: request.base.manifest.motion }),
      manifest: freeze({ id: request.base.manifest.id, sha256: canonicalJsonSha256(request.base.manifest) }),
      canonicalMotion: freeze({ id: request.base.motion.id, sha256: canonicalJsonSha256(request.base.motion) }),
      persistedMotion: freeze({ id: request.base.motion.id, sha256: request.base.persistedMotionSha256 }),
    }),
    lowererProfile,
    objectLayerBinding: freeze({ objectId: profile.objectId, layerId: profile.objectId, layerIndex: 0 as const, rootShapeKind: profile.rootShapeKind }),
    projection: freeze({
      edge: freeze({ id: profile.edge.id, fromCheckpointId: profile.edge.fromCheckpointId, toCheckpointId: profile.edge.toCheckpointId }),
      recipe: freeze({ id: profile.recipe.id, sha256: profile.recipe.sha256, revision: profile.recipe.revision, recipeId: profile.recipe.recipeId }),
      interval: freeze({ startUs: binding.startUs, durationUs: binding.durationUs }),
      path: "/behaviors" as const,
      store,
      storeSha256: canonicalJsonSha256(store),
      ownedPropertyMask: profile.ownedPropertyMask,
    }),
    endpointEvaluations: freeze({ start, end }),
    evidence: freeze({ noPackageIO: true as const, noPackageWrites: true as const, noCOW: true as const, noReceipt: true as const, noPublicSurface: true as const, noRenderer: true as const }),
  };
  return freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}

/**
 * C6C may admit this closed B2 record before a host has selected a package.  The document-end
 * and endpoint-evaluation checks deliberately remain in the exact-base resolver below: a record
 * is an immutable intent, never evidence about an arbitrary package supplied later.
 */
export function admitCheckpointStoryboardBehaviorRecordProfile(value: unknown): CheckpointStoryboard {
  const storyboard = readCheckpointStoryboard(value);
  assertStaticProfile(storyboard);
  return storyboard;
}

export function readCheckpointStoryboardBehaviorProfileRequest(value: unknown): CheckpointStoryboardBehaviorProfileRequest {
  const root = exactRecord(snapshotCheckpointStoryboardData(value), ["schema", "storyboard", "base", "objectLayerBindings"], [], "CheckpointStoryboard behavior profile request");
  if (root.schema !== CHECKPOINT_STORYBOARD_BEHAVIOR_PROFILE_REQUEST_SCHEMA) throw new Error(`CheckpointStoryboard behavior profile request.schema must equal ${CHECKPOINT_STORYBOARD_BEHAVIOR_PROFILE_REQUEST_SCHEMA}.`);
  const storyboard = readCheckpointStoryboard(root.storyboard), base = readBase(root.base), objectLayerBindings = readBindings(root.objectLayerBindings, storyboard);
  return freeze({ schema: CHECKPOINT_STORYBOARD_BEHAVIOR_PROFILE_REQUEST_SCHEMA, storyboard, base, objectLayerBindings });
}

function readBase(value: unknown): CheckpointStoryboardBehaviorProfileRequest["base"] {
  const record = exactRecord(value, ["packageId", "manifest", "motion", "persistedMotionSha256"], [], "CheckpointStoryboard behavior profile base");
  const packageId = safeId(record.packageId, "CheckpointStoryboard behavior profile base.packageId");
  const manifest = exactRecord(record.manifest, ["schema", "id", "name", "motion", "assets", "sourceApp", "compatibility"], ["template", "quality", "workflow", "data", "selectedFrameId"], "CheckpointStoryboard behavior profile base.manifest");
  if (manifest.schema !== "shellx-motion/package-manifest@1" || safeId(manifest.id, "CheckpointStoryboard behavior profile base.manifest.id") !== packageId) throw new Error("CheckpointStoryboard behavior profile base must use its exact Motion package manifest.");
  readMotionPath(manifest.motion);
  const motion = exactRecord(record.motion, ["schema", "id", "name", "durationMs", "fps", "width", "height", "layers", "assets", "provenance"], ["background", "audio", "scenes", "tracks", "markers", "safeAreas", "compositing", "relationships", "behaviors", "relations", "layoutGapAnimation", "scene3dAnimation", "relationActions", "layoutApplications"], "CheckpointStoryboard behavior profile base.motion");
  if (motion.schema !== "shellx-motion/motion@1") throw new Error("CheckpointStoryboard behavior profile base.motion must be Motion@1.");
  safeId(motion.id, "CheckpointStoryboard behavior profile base.motion.id");
  if (!Number.isSafeInteger(motion.durationMs) || (motion.durationMs as number) < 1 || (motion.durationMs as number) > 3_600_000) throw new Error("CheckpointStoryboard behavior profile base.motion.durationMs must be a bounded positive safe integer.");
  if (!Array.isArray(motion.layers) || motion.layers.length !== 1) throw new Error("CheckpointStoryboard behavior profile requires exactly one existing base layer.");
  for (const field of FORBIDDEN_MOTION_AUTHORITIES) if (Object.hasOwn(motion, field)) throw new Error(`CheckpointStoryboard behavior profile refuses existing ${field} authority.`);
  if (Object.hasOwn(motion, "traces") || Object.hasOwn(motion, "parametricTrace") || Object.hasOwn(motion, "parametricTraces")) throw new Error("CheckpointStoryboard behavior profile refuses trace authority.");
  return freeze({ packageId, manifest: freeze(manifest) as unknown as PackageManifest, motion: freeze(motion) as unknown as MotionDocument, persistedMotionSha256: sha256(record.persistedMotionSha256, "CheckpointStoryboard behavior profile base.persistedMotionSha256") });
}

function readMotionPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value !== value.normalize("NFC") || /[\u0000-\u001F\u007F-\u009F]/u.test(value) || value.split("/").some((segment) => segment === "." || segment === ".." || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))) throw new Error("CheckpointStoryboard behavior profile base.manifest.motion must be an NFC package-relative POSIX locator with clean ASCII segments only.");
  return value;
}

function readBindings(value: unknown, storyboard: CheckpointStoryboard): readonly [CheckpointStoryboardBehaviorProfileRequest["objectLayerBindings"][number]] {
  const entries = exactArray(value, "CheckpointStoryboard behavior profile objectLayerBindings", 1, 1);
  const record = exactRecord(entries[0], ["objectId", "layerId"], [], "CheckpointStoryboard behavior profile objectLayerBindings[0]");
  const objectId = safeId(record.objectId, "CheckpointStoryboard behavior profile objectLayerBindings[0].objectId"), layerId = safeId(record.layerId, "CheckpointStoryboard behavior profile objectLayerBindings[0].layerId");
  if (storyboard.objectCatalog.length !== 1 || objectId !== storyboard.objectCatalog[0]!.objectId || objectId !== layerId) throw new Error("CheckpointStoryboard behavior profile requires one exact same-ID object/layer binding.");
  return freeze([freeze({ objectId, layerId })]) as CheckpointStoryboardBehaviorProfileRequest["objectLayerBindings"];
}

function assertProfile(storyboard: CheckpointStoryboard, motion: MotionDocument) {
  const profile = assertStaticProfile(storyboard);
  if (profile.to.atUs !== motion.durationMs * 1_000) {
    throw new Error("CheckpointStoryboard behavior profile requires its final checkpoint at the exact document end.");
  }
  return profile;
}

/** Base-independent C6B2 admission. Do not add package or endpoint authority here. */
function assertStaticProfile(storyboard: CheckpointStoryboard) {
  if (storyboard.objectCatalog.some((catalog) => catalog.creation)) throw new Error("CheckpointStoryboard behavior profile refuses catalog creation payloads.");
  if (storyboard.capabilityRequirements.length !== 1 || storyboard.capabilityRequirements[0] !== "renderer.gpu") throw new Error("CheckpointStoryboard behavior profile requires exactly the renderer.gpu capability requirement.");
  if (storyboard.objectCatalog.length !== 1 || storyboard.checkpoints.length !== 2 || storyboard.edges.length !== 1 || storyboard.recipes.length !== 1) throw new Error("CheckpointStoryboard behavior profile requires exactly one object, two checkpoints, one edge, and one recipe.");
  const catalog = storyboard.objectCatalog[0]!, [from, to] = storyboard.checkpoints, edge = storyboard.edges[0]!, recipe = storyboard.recipes[0]!;
  if ((catalog.rootShapeKind !== "rect" && catalog.rootShapeKind !== "ellipse") || from!.atUs !== 0 || edge.fromCheckpointId !== from!.id || edge.toCheckpointId !== to!.id || edge.lifecycle.length !== 1 || edge.lifecycle[0]!.kind !== "preserve" || edge.lifecycle[0]!.objectId !== catalog.objectId || edge.recipeIds.length !== 1 || edge.recipeIds[0] !== recipe.recipeId || recipe.exactBaseRequirements.length !== 0) throw new Error("CheckpointStoryboard behavior profile requires one root rect/ellipse object preserved from document zero through one closed behavior edge.");
  if (from!.objects.length !== 1 || to!.objects.length !== 1 || from!.objects[0]!.state !== "present" || to!.objects[0]!.state !== "present") throw new Error("CheckpointStoryboard behavior profile requires exactly one present object state at both checkpoints.");
  if (recipe.intent.kind !== "transform-behavior" || recipe.intent.targetObjectId !== catalog.objectId) throw new Error("CheckpointStoryboard behavior profile requires its one recipe to be a transform-behavior for the bound object.");
  const ownedPropertyMask = recipe.intent.behavior.kind === "gravity" ? ["transform.x", "transform.y"] as const : ["transform.y"] as const;
  if (!sameMask(catalog.propertyMask, ownedPropertyMask)) throw new Error(`CheckpointStoryboard behavior profile ${recipe.intent.behavior.kind} requires exactly its owned ${ownedPropertyMask.join(", ")} property mask.`);
  return { objectId: catalog.objectId, rootShapeKind: catalog.rootShapeKind, from: from!, to: to!, edge, recipe, ownedPropertyMask };
}

function assertBaseLayer(request: CheckpointStoryboardBehaviorProfileRequest, owned: readonly CheckpointStoryboardBehaviorOwnedProperty[]): Record<string, unknown> {
  const layer = request.base.motion.layers[0] as unknown as Record<string, unknown>, binding = request.objectLayerBindings[0]!;
  if (layer.id !== binding.layerId || layer.type !== "shape" || (layer.shape !== "rect" && layer.shape !== "ellipse")) throw new Error("CheckpointStoryboard behavior profile requires its exact existing rect or ellipse shape layer.");
  if (layer.shape !== request.storyboard.objectCatalog[0]!.rootShapeKind || Object.hasOwn(layer, "childLayerIds") || layer.locked === true) throw new Error("CheckpointStoryboard behavior profile requires an unlocked root-owned shape layer with the declared shape kind.");
  if (FORBIDDEN_LAYER_OVERLAYS.some((field) => Object.hasOwn(layer, field))) throw new Error("CheckpointStoryboard behavior profile refuses full transform-overlay or timing authority on its target layer.");
  if (Object.hasOwn(layer, "depth") || Object.hasOwn(layer, "geometry") || Object.hasOwn(layer, "geometryKeyframes")) throw new Error("CheckpointStoryboard behavior profile refuses depth or geometry authority.");
  if (layer.startMs !== 0 || layer.durationMs !== request.base.motion.durationMs) throw new Error("CheckpointStoryboard behavior profile requires its target layer to span the exact document interval.");
  if (owned.length === 0) throw new Error("CheckpointStoryboard behavior profile internal authority-mask failure.");
  return layer;
}

function assertBehaviorSemantics(motion: MotionDocument, store: MotionBehaviorStore): void {
  const checked = validateMotionBehaviors(store, motion);
  if (!checked.ok) throw new Error(`CheckpointStoryboard behavior profile behaviors@1 binding is invalid: ${checked.issues[0]!.message}`);
}

function evaluate(atUs: number, startUs: number, durationUs: number, base: ReturnType<typeof baseTransform>, motion: CheckpointTransformBehavior): MotionTransformBehaviorEvaluation {
  const result = evaluateMotionTransformBehavior({ schema: "shellx-motion/transform-behavior@1", atUs, startUs, durationUs, base, motion });
  if (!result.ok) throw new Error(`CheckpointStoryboard behavior profile direct evaluation refused: ${result.message}`);
  return result.evaluation;
}

function assertEndpoint(evaluation: MotionTransformBehaviorEvaluation, state: CheckpointObjectState, mask: readonly CheckpointStoryboardBehaviorOwnedProperty[], label: string): void {
  if (state.state !== "present") throw new Error(`CheckpointStoryboard behavior profile requires a present ${label} state.`);
  for (const property of mask) {
    const expected = state.properties.find((entry) => entry.property === property)?.value;
    const actual = property === "transform.x" ? evaluation.transform.x : evaluation.transform.y;
    if (actual !== expected) throw new Error(`CheckpointStoryboard behavior profile ${label} endpoint does not exactly equal ${property}.`);
  }
}

function sameMask(actual: readonly CheckpointProperty[], expected: readonly CheckpointStoryboardBehaviorOwnedProperty[]): boolean {
  return actual.length === expected.length && actual.every((property, index) => property === expected[index]);
}

/** Private C6B2 compiler only: no COW, receipt, Debug command, or renderer invocation occurs here. */
