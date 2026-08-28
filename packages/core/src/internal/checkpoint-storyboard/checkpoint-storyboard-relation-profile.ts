/** Private installed C6B3a compiler for one existing-root semantic follow relation. */

import { canonicalJsonSha256 } from "../../canonical-json";
import { compileGpuSceneRelationsStaticPlan } from "../../gpu-scene-relations-composition";
import { evaluateMotionRelationAuthoringFrame, compileMotionRelationAuthoringFramePlanFromEvaluation, motionRelationLegacyAtMs } from "../../motion-relation-authoring-frame";
import { compileMotionRelationStaticPlan } from "../../motion-relation-plan";
import { readMotionRelationStore } from "../../motion-relation-read";
import { validateMotionRelations } from "../../motion-relation-validate";
import { readMotionDocument, readPackageManifest } from "../../package";
import type { MotionLayer, MotionDocument, PackageManifest } from "../../types";
import { loadSchemaSync, validateDocumentSync } from "../../validate";
import { compileCheckpointStoryboardPlan, readCheckpointStoryboard } from "../../internal/checkpoint-storyboard/checkpoint-storyboard-records.js";
import { exactArray, exactRecord, freeze, safeId, sha256, snapshotCheckpointStoryboardData, strictIds } from "../../internal/checkpoint-storyboard/checkpoint-storyboard-data.js";
import type { CheckpointObjectCatalogEntry, CheckpointObjectState, CheckpointProperty, CheckpointRelationIntent, CheckpointStoryboard, TransitionRecipe } from "../../internal/checkpoint-storyboard/checkpoint-storyboard-types.js";
import {
  CHECKPOINT_STORYBOARD_RELATION_PROFILE_PLAN_SCHEMA,
  CHECKPOINT_STORYBOARD_RELATION_PROFILE_REQUEST_SCHEMA,
  CHECKPOINT_STORYBOARD_RELATION_PROFILE_SCHEMA,
  type CheckpointStoryboardRelationOwnedProperty,
  type CheckpointStoryboardRelationProfileBinding,
  type CheckpointStoryboardRelationProfilePlan,
  type CheckpointStoryboardRelationProfileRequest,
} from "./checkpoint-storyboard-relation-profile-types";

const OWNED_PROPERTY_MASK = ["transform.x", "transform.y"] as const;
const FORBIDDEN_MOTION_AUTHORITIES = [
  "tracks", "relationships", "behaviors", "relations", "relationActions", "layoutGapAnimation", "layoutApplications", "scene3dAnimation",
] as const;
const FORBIDDEN_LAYER_AUTHORITIES = [
  "keyframes", "transitions", "tracking", "stabilization", "stabilize", "transformAuthority", "timingAuthority", "timeRemap",
  "trimStartMs", "trimDurationMs", "loop", "playbackRate", "x-tracking-stabilization",
] as const;
const PROFILE_PAYLOAD = freeze({
  schema: CHECKPOINT_STORYBOARD_RELATION_PROFILE_SCHEMA,
  requiredCapability: "renderer.gpu" as const,
  rootShapeKinds: ["rect", "ellipse"] as const,
  relationKinds: ["follow"] as ["follow"],
  offsetSpaces: ["world"] as ["world"],
  ownedPropertyMask: OWNED_PROPERTY_MASK,
  endpointRule: "closed-whole-millisecond-legacy-bridge" as const,
});

/**
 * Projects one sealed C6A follow recipe into the existing `relations@1` T3 Core contracts. The
 * result is a detached, deeply frozen materialization intent; it does not open a package, retain
 * host authority, write COW output, invoke a renderer, or create a receipt.
 */
export function compileCheckpointStoryboardRelationProfilePlan(value: unknown): CheckpointStoryboardRelationProfilePlan {
  const request = readCheckpointStoryboardRelationProfileRequest(value);
  const profile = assertProfile(request.storyboard, request.base.motion);
  const bindings = bindObjects(request, profile);
  const store = relationStore(profile, bindings);
  const relationMotion = freeze({ ...request.base.motion, relations: store }) as MotionDocument;
  const validated = validateMotionRelations(store, relationMotion);
  if (!validated.ok) throw new Error(`CheckpointStoryboard relation profile relations@1 projection is invalid: ${validated.issues[0]!.message}`);
  const resolved = validated.bindings[0];
  if (!resolved || validated.bindings.length !== 1 || resolved.binding.kind !== "attach" || resolved.binding.mode !== "follow" || !sameMask(resolved.writeMask, OWNED_PROPERTY_MASK) || resolved.binding.target.layerId !== bindings.target.layerId) {
    throw new Error("CheckpointStoryboard relation profile internal target-only follow authority failure.");
  }
  const staticResult = compileMotionRelationStaticPlan(relationMotion);
  if (!staticResult.ok) throw new Error(`CheckpointStoryboard relation profile static relation plan refused: ${staticResult.message}`);
  const gpuPreview = compileGpuSceneRelationsStaticPlan(relationMotion);
  if (!gpuPreview.ok) throw new Error(`CheckpointStoryboard relation profile GPU relation-preview capability admission refused: ${gpuPreview.failure.message}`);
  if (gpuPreview.plan.relationStaticFingerprint !== staticResult.plan.fingerprint) throw new Error("CheckpointStoryboard relation profile GPU relation-preview admission does not bind its static relation plan.");
  const [startUs, endUs] = [profile.from.atUs, profile.to.atUs];
  // The existing authoring compositor is the sole exact whole-millisecond bridge and evaluator.
  motionRelationLegacyAtMs(startUs, relationMotion);
  motionRelationLegacyAtMs(endUs, relationMotion);
  const start = evaluateMotionRelationAuthoringFrame(relationMotion, startUs);
  const end = evaluateMotionRelationAuthoringFrame(relationMotion, endUs);
  assertEndpoint(start, profile.from, bindings, "start");
  assertEndpoint(end, profile.to, bindings, "end");
  const startFrame = compileMotionRelationAuthoringFramePlanFromEvaluation(relationMotion, start);
  const endFrame = compileMotionRelationAuthoringFramePlanFromEvaluation(relationMotion, end);
  if (!startFrame.ok) throw new Error(`CheckpointStoryboard relation profile start endpoint relation plan refused: ${startFrame.message}`);
  if (!endFrame.ok) throw new Error(`CheckpointStoryboard relation profile end endpoint relation plan refused: ${endFrame.message}`);
  if (startFrame.plan.staticFingerprint !== staticResult.plan.fingerprint || endFrame.plan.staticFingerprint !== staticResult.plan.fingerprint) {
    throw new Error("CheckpointStoryboard relation profile endpoint plans do not bind the static relation plan.");
  }
  const c6aPlan = compileCheckpointStoryboardPlan(request.storyboard);
  const lowererProfile = freeze({ ...PROFILE_PAYLOAD, fingerprint: canonicalJsonSha256(PROFILE_PAYLOAD) });
  const payload = {
    schema: CHECKPOINT_STORYBOARD_RELATION_PROFILE_PLAN_SCHEMA,
    storyboard: freeze({ id: request.storyboard.id, sha256: request.storyboard.sha256, revision: request.storyboard.revision, fingerprint: c6aPlan.fingerprint }),
    base: freeze({
      package: freeze({ id: request.base.packageId, motionPath: request.base.manifest.motion }),
      manifest: freeze({ id: request.base.manifest.id, sha256: canonicalJsonSha256(request.base.manifest) }),
      canonicalMotion: freeze({ id: request.base.motion.id, sha256: canonicalJsonSha256(request.base.motion) }),
      persistedMotion: freeze({ id: request.base.motion.id, sha256: request.base.persistedMotionSha256 }),
    }),
    lowererProfile,
    objectLayerBindings: bindings,
    projection: freeze({
      edge: freeze({ id: profile.edge.id, fromCheckpointId: profile.edge.fromCheckpointId, toCheckpointId: profile.edge.toCheckpointId }),
      recipe: freeze({ id: profile.recipe.id, sha256: profile.recipe.sha256, revision: profile.recipe.revision, recipeId: profile.recipe.recipeId }),
      interval: freeze({ startUs, durationUs: endUs - startUs }),
      path: "/relations" as const,
      store,
      storeSha256: canonicalJsonSha256(store),
      staticPlan: staticResult.plan,
      staticFingerprint: staticResult.plan.fingerprint,
      gpuPreviewStaticPlan: freeze({ schema: gpuPreview.plan.schema, fingerprint: gpuPreview.plan.fingerprint, relationStaticFingerprint: gpuPreview.plan.relationStaticFingerprint }),
      ownedPropertyMask: OWNED_PROPERTY_MASK,
    }),
    endpointEvaluations: freeze({ start, end }),
    endpointFramePlans: freeze({ start: startFrame.plan, end: endFrame.plan }),
    evidence: freeze({ noPackageIO: true as const, noPackageWrites: true as const, noCOW: true as const, noReceipt: true as const, noPublicSurface: true as const, noRenderer: true as const }),
  };
  return deepFreeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}

export function readCheckpointStoryboardRelationProfileRequest(value: unknown): CheckpointStoryboardRelationProfileRequest {
  const root = exactRecord(snapshotCheckpointStoryboardData(value), ["schema", "storyboard", "base", "objectLayerBindings"], [], "CheckpointStoryboard relation profile request");
  if (root.schema !== CHECKPOINT_STORYBOARD_RELATION_PROFILE_REQUEST_SCHEMA) throw new Error(`CheckpointStoryboard relation profile request.schema must equal ${CHECKPOINT_STORYBOARD_RELATION_PROFILE_REQUEST_SCHEMA}.`);
  const storyboard = readCheckpointStoryboard(root.storyboard);
  const base = readBase(root.base);
  const objectLayerBindings = readBindings(root.objectLayerBindings, storyboard);
  return freeze({ schema: CHECKPOINT_STORYBOARD_RELATION_PROFILE_REQUEST_SCHEMA, storyboard, base, objectLayerBindings });
}

/** Base-independent C6C record admission. Exact [0,D] package facts stay resolver-only. */
export function admitCheckpointStoryboardRelationRecordProfile(value: unknown): CheckpointStoryboard {
  const storyboard = readCheckpointStoryboard(value);
  assertStaticProfile(storyboard);
  return storyboard;
}

function readBase(value: unknown): CheckpointStoryboardRelationProfileRequest["base"] {
  const record = exactRecord(value, ["packageId", "manifest", "motion", "persistedMotionSha256"], [], "CheckpointStoryboard relation profile base");
  const packageId = safeId(record.packageId, "CheckpointStoryboard relation profile base.packageId");
  const manifestData = exactRecord(record.manifest, ["schema", "id", "name", "motion", "assets", "sourceApp", "compatibility"], ["template", "quality", "workflow", "data", "selectedFrameId"], "CheckpointStoryboard relation profile base.manifest");
  assertCompleteDocument("manifest", "packageManifest", manifestData);
  const manifest = readPackageManifest(manifestData);
  if (safeId(manifest.id, "CheckpointStoryboard relation profile base.manifest.id") !== packageId) throw new Error("CheckpointStoryboard relation profile base must use its exact Motion package manifest.");
  readMotionPath(manifest.motion);
  const motionData = exactRecord(record.motion, ["schema", "id", "name", "durationMs", "fps", "width", "height", "layers", "assets", "provenance"], ["background", "audio", "scenes", "tracks", "markers", "safeAreas", "compositing", "relationships", "behaviors", "relations", "layoutGapAnimation", "scene3dAnimation", "relationActions", "layoutApplications"], "CheckpointStoryboard relation profile base.motion");
  assertCompleteDocument("Motion document", "motion", motionData);
  const motion = readMotionDocument(motionData);
  safeId(motion.id, "CheckpointStoryboard relation profile base.motion.id");
  if (!Number.isSafeInteger(motion.durationMs) || motion.durationMs < 1 || motion.durationMs > 3_600_000) throw new Error("CheckpointStoryboard relation profile base.motion.durationMs must be a bounded positive safe integer.");
  if (!Array.isArray(motion.assets) || motion.assets.length !== 0) throw new Error("CheckpointStoryboard relation profile requires an asset-free T3 GPU relation-preview base.");
  if (!Array.isArray(motion.layers) || motion.layers.length !== 2) throw new Error("CheckpointStoryboard relation profile requires exactly two existing base layers.");
  for (const field of FORBIDDEN_MOTION_AUTHORITIES) if (Object.hasOwn(motion, field)) throw new Error(`CheckpointStoryboard relation profile refuses existing ${field} authority.`);
  if (Object.hasOwn(motion, "traces") || Object.hasOwn(motion, "parametricTrace") || Object.hasOwn(motion, "parametricTraces")) throw new Error("CheckpointStoryboard relation profile refuses trace authority.");
  return freeze({ packageId, manifest: freeze(manifest) as PackageManifest, motion: freeze(motion), persistedMotionSha256: sha256(record.persistedMotionSha256, "CheckpointStoryboard relation profile base.persistedMotionSha256") });
}

/** Snapshotting occurs before this canonical validator/reader pair, so neither invokes hostile input accessors. */
function assertCompleteDocument(label: string, schema: "packageManifest" | "motion", value: unknown): void {
  const result = validateDocumentSync(loadSchemaSync(schema), value);
  if (!result.ok) {
    const first = result.errors[0]!;
    throw new Error(`CheckpointStoryboard relation profile ${label} is invalid at ${first.path || "/"}: ${first.message}`);
  }
}

function readMotionPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value !== value.normalize("NFC") || /[\u0000-\u001F\u007F-\u009F]/u.test(value) || value.split("/").some((segment) => segment === "." || segment === ".." || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))) {
    throw new Error("CheckpointStoryboard relation profile base.manifest.motion must be an NFC package-relative POSIX locator with clean ASCII segments only.");
  }
  return value;
}

function readBindings(value: unknown, storyboard: CheckpointStoryboard): CheckpointStoryboardRelationProfileRequest["objectLayerBindings"] {
  const entries = exactArray(value, "CheckpointStoryboard relation profile objectLayerBindings", 2, 2).map((entry, index) => {
    const record = exactRecord(entry, ["objectId", "layerId"], [], `CheckpointStoryboard relation profile objectLayerBindings[${index}]`);
    return freeze({ objectId: safeId(record.objectId, `CheckpointStoryboard relation profile objectLayerBindings[${index}].objectId`), layerId: safeId(record.layerId, `CheckpointStoryboard relation profile objectLayerBindings[${index}].layerId`) });
  });
  if (storyboard.objectCatalog.length !== 2 || entries.some((binding, index) => binding.objectId !== storyboard.objectCatalog[index]!.objectId || binding.objectId !== binding.layerId)) {
    throw new Error("CheckpointStoryboard relation profile requires two exact same-ID object/layer bindings in catalog order.");
  }
  strictIds(entries.map((binding) => binding.objectId), "CheckpointStoryboard relation profile bound object ids");
  if (new Set(entries.map((binding) => binding.layerId)).size !== entries.length) throw new Error("CheckpointStoryboard relation profile cannot bind one layer to both objects.");
  return freeze(entries) as unknown as CheckpointStoryboardRelationProfileRequest["objectLayerBindings"];
}

function assertProfile(storyboard: CheckpointStoryboard, motion: MotionDocument) {
  const profile = assertStaticProfile(storyboard);
  if (profile.to.atUs !== motion.durationMs * 1_000) throw new Error("CheckpointStoryboard relation profile requires its terminal checkpoint at the exact package duration D.");
  return profile;
}

function assertStaticProfile(storyboard: CheckpointStoryboard) {
  if (storyboard.objectCatalog.some((catalog) => catalog.creation)) throw new Error("CheckpointStoryboard relation profile refuses catalog creation payloads.");
  if (storyboard.capabilityRequirements.length !== 1 || storyboard.capabilityRequirements[0] !== "renderer.gpu") throw new Error("CheckpointStoryboard relation profile requires exactly the renderer.gpu capability requirement.");
  if (storyboard.objectCatalog.length !== 2 || storyboard.checkpoints.length !== 2 || storyboard.edges.length !== 1 || storyboard.recipes.length !== 1) throw new Error("CheckpointStoryboard relation profile requires exactly two objects, two checkpoints, one edge, and one recipe.");
  const [from, to] = storyboard.checkpoints, edge = storyboard.edges[0]!, recipe = storyboard.recipes[0]!;
  if (from!.atUs !== 0 || from!.atUs % 1_000 !== 0 || to!.atUs % 1_000 !== 0) throw new Error("CheckpointStoryboard relation profile requires two whole-millisecond checkpoints beginning at zero.");
  if (edge.fromCheckpointId !== from!.id || edge.toCheckpointId !== to!.id || edge.recipeIds.length !== 1 || edge.recipeIds[0] !== recipe.recipeId || edge.lifecycle.length !== 2 || edge.lifecycle.some((entry, index) => entry.kind !== "preserve" || entry.objectId !== storyboard.objectCatalog[index]!.objectId)) {
    throw new Error("CheckpointStoryboard relation profile requires one edge with exactly both preserve lifecycle mappings and one relation recipe.");
  }
  if (recipe.exactBaseRequirements.length !== 0 || recipe.intent.kind !== "relation" || recipe.intent.relationKind !== "follow") throw new Error("CheckpointStoryboard relation profile requires exactly one semantic follow recipe without action dependencies.");
  const intent = recipe.intent;
  if (intent.offset.space !== "world" || intent.offset.rotationDeg !== 0 || intent.offset.scale !== 1) throw new Error("CheckpointStoryboard relation profile requires an explicit world translation-only offset.");
  if (storyboard.objectCatalog.some((entry) => (entry.rootShapeKind !== "rect" && entry.rootShapeKind !== "ellipse") || !sameMask(entry.propertyMask, OWNED_PROPERTY_MASK))) {
    throw new Error("CheckpointStoryboard relation profile requires two rect/ellipse objects with exact transform.x/transform.y state masks.");
  }
  if (storyboard.checkpoints.some((checkpoint) => checkpoint.objects.some((state) => state.state !== "present" || !sameMask(state.properties.map((entry) => entry.property), OWNED_PROPERTY_MASK)))) {
    throw new Error("CheckpointStoryboard relation profile refuses lifecycle, geometry, or non-position checkpoint state changes.");
  }
  const catalogIds = new Set(storyboard.objectCatalog.map((entry) => entry.objectId));
  if (!catalogIds.has(intent.sourceObjectId) || !catalogIds.has(intent.targetObjectId) || intent.sourceObjectId === intent.targetObjectId) throw new Error("CheckpointStoryboard relation profile follow endpoints must be the two distinct catalog objects.");
  return { from: from!, to: to!, edge, recipe, intent };
}

function bindObjects(request: CheckpointStoryboardRelationProfileRequest, profile: ReturnType<typeof assertProfile>): CheckpointStoryboardRelationProfilePlan["objectLayerBindings"] {
  const catalogById = new Map(request.storyboard.objectCatalog.map((entry) => [entry.objectId, entry]));
  const bindingByObjectId = new Map(request.objectLayerBindings.map((binding) => [binding.objectId, binding]));
  const layerById = new Map(request.base.motion.layers.map((layer, index) => [layer.id, { layer, index }]));
  const bind = (role: "source" | "target", objectId: string) => {
    const catalog = catalogById.get(objectId), binding = bindingByObjectId.get(objectId), layerEntry = binding ? layerById.get(binding.layerId) : undefined;
    if (!catalog || !binding || !layerEntry) throw new Error(`CheckpointStoryboard relation profile ${role} endpoint does not bind an existing catalog/base layer.`);
    assertBaseLayer(layerEntry.layer as unknown as Record<string, unknown>, binding, catalog, request.base.motion.durationMs, role);
    return freeze({ objectId, layerId: binding.layerId, layerIndex: layerEntry.index, rootShapeKind: catalog.rootShapeKind as "rect" | "ellipse" });
  };
  return freeze({ source: bind("source", profile.intent.sourceObjectId), target: bind("target", profile.intent.targetObjectId) });
}

function assertBaseLayer(
  layer: Record<string, unknown>,
  binding: CheckpointStoryboardRelationProfileBinding,
  catalog: CheckpointObjectCatalogEntry,
  durationMs: number,
  role: "source" | "target",
): void {
  if (safeId(layer.id, `CheckpointStoryboard relation profile ${role} layer.id`) !== binding.layerId || layer.type !== "shape" || (layer.shape !== "rect" && layer.shape !== "ellipse") || layer.shape !== catalog.rootShapeKind) {
    throw new Error(`CheckpointStoryboard relation profile requires its ${role} endpoint to be the exact existing declared rect or ellipse shape layer.`);
  }
  if (layer.visible === false || layer.locked === true || Object.hasOwn(layer, "childLayerIds") || Object.hasOwn(layer, "depth")) throw new Error(`CheckpointStoryboard relation profile requires a visible unlocked root-owned non-depth ${role} shape layer.`);
  if (layer.startMs !== 0 || layer.durationMs !== durationMs) throw new Error(`CheckpointStoryboard relation profile requires its ${role} layer to span the exact document interval.`);
  if (FORBIDDEN_LAYER_AUTHORITIES.some((field) => Object.hasOwn(layer, field))) throw new Error(`CheckpointStoryboard relation profile refuses existing transform/timing authority on its ${role} layer.`);
  if (Object.hasOwn(layer, "geometry") || Object.hasOwn(layer, "geometryKeyframes") || Object.hasOwn(layer, "morph")) throw new Error(`CheckpointStoryboard relation profile refuses geometry or morph authority on its ${role} layer.`);
  if (Object.hasOwn(layer, "effectModule") || hasMotionBlur(layer.effects)) throw new Error(`CheckpointStoryboard relation profile refuses non-T3 GPU-preview effect authority on its ${role} layer.`);
}

function hasMotionBlur(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "motionBlur");
}

function relationStore(
  profile: ReturnType<typeof assertProfile>,
  bindings: CheckpointStoryboardRelationProfilePlan["objectLayerBindings"],
) {
  const intent = profile.intent;
  return freeze(readMotionRelationStore({
    schema: "shellx-motion/relations@1",
    bindings: [{
      id: profile.recipe.recipeId,
      enabled: true,
      kind: "attach",
      source: { layerId: bindings.source.layerId, anchor: { x: intent.sourceAnchor.x, y: intent.sourceAnchor.y } },
      target: { layerId: bindings.target.layerId, anchor: { x: intent.targetAnchor.x, y: intent.targetAnchor.y } },
      startUs: profile.from.atUs,
      durationUs: profile.to.atUs - profile.from.atUs,
      mode: "follow",
      offset: { space: "world", x: intent.offset.x, y: intent.offset.y, rotationDeg: 0, scale: 1 },
    }],
  }));
}

function assertEndpoint(
  evaluation: CheckpointStoryboardRelationProfilePlan["endpointEvaluations"]["start"],
  checkpoint: { readonly objects: readonly CheckpointObjectState[] },
  bindings: CheckpointStoryboardRelationProfilePlan["objectLayerBindings"],
  label: "start" | "end",
): void {
  if (evaluation.samples.length !== 1 || evaluation.samples[0]!.targetLayerId !== bindings.target.layerId || !sameMask(evaluation.samples[0]!.writeMask, OWNED_PROPERTY_MASK)) throw new Error(`CheckpointStoryboard relation profile ${label} evaluation did not retain exactly one target-only follow sample.`);
  for (const role of ["source", "target"] as const) {
    const state = checkpoint.objects.find((item) => item.objectId === bindings[role].objectId);
    const layer = evaluation.layers.find((item) => item.id === bindings[role].layerId);
    if (!state || state.state !== "present" || !layer) throw new Error(`CheckpointStoryboard relation profile ${label} endpoint identity is unavailable.`);
    for (const property of OWNED_PROPERTY_MASK) {
      const expected = state.properties.find((item) => item.property === property)?.value;
      const actual = position(layer, property);
      if (expected !== actual) throw new Error(`CheckpointStoryboard relation profile ${label} endpoint does not exactly equal ${role}.${property}.`);
    }
  }
}

function position(layer: MotionLayer, property: CheckpointStoryboardRelationOwnedProperty): number {
  const value = property === "transform.x" ? layer.transform?.x : layer.transform?.y;
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`CheckpointStoryboard relation profile evaluated ${layer.id}.${property} is not finite.`);
  return value;
}

function sameMask(actual: readonly string[], expected: readonly CheckpointStoryboardRelationOwnedProperty[]): boolean {
  return actual.length === expected.length && actual.every((property, index) => property === expected[index]);
}

/** Embedded T3 evaluator/frame-plan snapshots freeze their roots but not every child. Seal all plan data. */
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}
