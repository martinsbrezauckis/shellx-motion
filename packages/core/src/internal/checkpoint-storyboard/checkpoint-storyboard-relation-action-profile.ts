/** Private installed C6B4a compiler for one existing-root C4B follow action. */

import { canonicalJson, canonicalJsonSha256, compareCodeUnits } from "../../canonical-json";
import { compileGpuSceneRelationsStaticPlan } from "../../gpu-scene-relations-composition";
import { compileMotionRelationAuthoringFramePlanFromEvaluation, evaluateMotionRelationAuthoringFrame, motionRelationLegacyAtMs } from "../../motion-relation-authoring-frame";
import { compileMotionRelationStaticPlan } from "../../motion-relation-plan";
import { applyMotionRelationAction, inspectMotionRelationActions } from "../../motion-relation-actions-public";
import type { MotionRelationActionDefinition } from "../../motion-relation-actions-public-types";
import { readMotionRelationStore } from "../../motion-relation-read";
import { validateMotionRelations } from "../../motion-relation-validate";
import { readMotionDocument, readPackageManifest } from "../../package";
import type { MotionDocument, MotionLayer, PackageManifest } from "../../types";
import { loadSchemaSync, validateDocumentSync } from "../../validate";
import { compileCheckpointStoryboardPlan, readCheckpointStoryboard } from "./checkpoint-storyboard-records.js";
import { exactArray, exactRecord, freeze, safeId, sha256, snapshotCheckpointStoryboardData, strictIds } from "./checkpoint-storyboard-data.js";
import type { CheckpointObjectCatalogEntry, CheckpointObjectState, CheckpointProperty, CheckpointStoryboard, TransitionRecipe } from "./checkpoint-storyboard-types.js";
import { assertCheckpointStoryboardRelationActionStaticProfile, CHECKPOINT_STORYBOARD_RELATION_ACTION_OWNED_PROPERTY_MASK } from "./checkpoint-storyboard-relation-action-record-profile.js";
import {
  CHECKPOINT_STORYBOARD_RELATION_ACTION_PROFILE_PLAN_SCHEMA,
  CHECKPOINT_STORYBOARD_RELATION_ACTION_PROFILE_REQUEST_SCHEMA,
  CHECKPOINT_STORYBOARD_RELATION_ACTION_PROFILE_SCHEMA,
  type CheckpointStoryboardRelationActionOwnedProperty,
  type CheckpointStoryboardRelationActionProfilePlan,
  type CheckpointStoryboardRelationActionProfileRequest,
} from "./checkpoint-storyboard-relation-action-profile-types";
const OWNED_PROPERTY_MASK = CHECKPOINT_STORYBOARD_RELATION_ACTION_OWNED_PROPERTY_MASK;
const FORBIDDEN_MOTION_AUTHORITIES = [
  "tracks", "relationships", "behaviors", "relations", "layoutGapAnimation", "layoutApplications", "scene3dAnimation",
] as const;
const FORBIDDEN_LAYER_AUTHORITIES = [
  "keyframes", "transitions", "tracking", "stabilization", "stabilize", "transformAuthority", "timingAuthority", "timeRemap",
  "trimStartMs", "trimDurationMs", "loop", "playbackRate", "x-tracking-stabilization",
] as const;
const PROFILE_PAYLOAD = freeze({
  schema: CHECKPOINT_STORYBOARD_RELATION_ACTION_PROFILE_SCHEMA,
  requiredCapability: "renderer.gpu" as const,
  rootShapeKinds: ["rect", "ellipse"] as const,
  actionStoreSchema: "shellx-motion/relation-actions@2" as const,
  relationKinds: ["follow"] as ["follow"],
  offsetSpaces: ["world"] as ["world"],
  roles: 2 as const,
  parameters: 0 as const,
  templateLayers: 0 as const,
  sequenceSteps: 1 as const,
  relationTemplates: 1 as const,
  ownedPropertyMask: OWNED_PROPERTY_MASK,
  endpointRule: "closed-whole-millisecond-legacy-bridge" as const,
});
/** Resolves a sealed C6A requirement into a detached, deeply frozen C4B projection plan only. */
export function compileCheckpointStoryboardRelationActionProfilePlan(value: unknown): CheckpointStoryboardRelationActionProfilePlan {
  const request = readCheckpointStoryboardRelationActionProfileRequest(value);
  const profile = assertProfile(request.storyboard, request.base.motion);
  const action = resolveAction(request, profile);
  const actionRequest = freeze({
    definitionId: action.definition.id,
    expectedMotionSha256: canonicalJsonSha256(request.base.motion),
    expectedStoreSha256: action.storeSha256,
    expectedDefinitionSha256: action.definitionSha256,
    instanceId: stableInstanceId(request.storyboard, profile.recipe),
    startAtUs: profile.from.atUs,
    roleBindings: action.roleLayerBindings,
    parameterValues: {},
  });
  const applied = applyMotionRelationAction(request.base.motion, actionRequest);
  assertActionProjection(request.base.motion, applied, action);
  const relationStore = readMotionRelationStore(applied.motion.relations);
  const relation = relationStore.bindings[0];
  if (!relation || relationStore.bindings.length !== 1 || relation.id !== applied.relationIds[0] || relation.kind !== "attach" || relation.mode !== "follow") {
    throw new Error("CheckpointStoryboard relation-action profile did not materialize exactly one follow relation.");
  }
  const relationMotion = applied.motion;
  const validated = validateMotionRelations(relationStore, relationMotion);
  if (!validated.ok) throw new Error(`CheckpointStoryboard relation-action profile relations@1 projection is invalid: ${validated.issues[0]!.message}`);
  const resolved = validated.bindings[0];
  if (!resolved || resolved.binding.id !== relation.id || resolved.binding.target.layerId !== action.target.layerId || !sameMask(resolved.writeMask, OWNED_PROPERTY_MASK)) {
    throw new Error("CheckpointStoryboard relation-action profile internal target-only follow authority failure.");
  }
  const staticResult = compileMotionRelationStaticPlan(relationMotion);
  if (!staticResult.ok) throw new Error(`CheckpointStoryboard relation-action profile static relation plan refused: ${staticResult.message}`);
  const gpuPreview = compileGpuSceneRelationsStaticPlan(relationMotion);
  if (!gpuPreview.ok) throw new Error(`CheckpointStoryboard relation-action profile GPU relation-preview capability admission refused: ${gpuPreview.failure.message}`);
  if (gpuPreview.plan.relationStaticFingerprint !== staticResult.plan.fingerprint) {
    throw new Error("CheckpointStoryboard relation-action profile GPU relation-preview admission does not bind its static relation plan.");
  }
  motionRelationLegacyAtMs(profile.from.atUs, relationMotion);
  motionRelationLegacyAtMs(profile.to.atUs, relationMotion);
  const start = evaluateMotionRelationAuthoringFrame(relationMotion, profile.from.atUs);
  const end = evaluateMotionRelationAuthoringFrame(relationMotion, profile.to.atUs);
  assertEndpoint(start, profile.from, action.objectLayerBindings, "start");
  assertEndpoint(end, profile.to, action.objectLayerBindings, "end");
  const startFrame = compileMotionRelationAuthoringFramePlanFromEvaluation(relationMotion, start);
  const endFrame = compileMotionRelationAuthoringFramePlanFromEvaluation(relationMotion, end);
  if (!startFrame.ok) throw new Error(`CheckpointStoryboard relation-action profile start endpoint relation plan refused: ${startFrame.message}`);
  if (!endFrame.ok) throw new Error(`CheckpointStoryboard relation-action profile end endpoint relation plan refused: ${endFrame.message}`);
  if (startFrame.plan.staticFingerprint !== staticResult.plan.fingerprint || endFrame.plan.staticFingerprint !== staticResult.plan.fingerprint) {
    throw new Error("CheckpointStoryboard relation-action profile endpoint plans do not bind the static relation plan.");
  }
  const c6aPlan = compileCheckpointStoryboardPlan(request.storyboard);
  const lowererProfile = freeze({ ...PROFILE_PAYLOAD, fingerprint: canonicalJsonSha256(PROFILE_PAYLOAD) });
  const payload = {
    schema: CHECKPOINT_STORYBOARD_RELATION_ACTION_PROFILE_PLAN_SCHEMA,
    storyboard: freeze({ id: request.storyboard.id, sha256: request.storyboard.sha256, revision: request.storyboard.revision, fingerprint: c6aPlan.fingerprint }),
    base: freeze({
      package: freeze({ id: request.base.packageId, motionPath: request.base.manifest.motion }),
      manifest: freeze({ id: request.base.manifest.id, sha256: canonicalJsonSha256(request.base.manifest) }),
      canonicalMotion: freeze({ id: request.base.motion.id, sha256: canonicalJsonSha256(request.base.motion) }),
      persistedMotion: freeze({ id: request.base.motion.id, sha256: request.base.persistedMotionSha256 }),
    }),
    lowererProfile,
    objectLayerBindings: action.objectLayerBindings,
    projection: freeze({
      edge: freeze({ id: profile.edge.id, fromCheckpointId: profile.edge.fromCheckpointId, toCheckpointId: profile.edge.toCheckpointId }),
      recipe: freeze({ id: profile.recipe.id, sha256: profile.recipe.sha256, revision: profile.recipe.revision, recipeId: profile.recipe.recipeId }),
      action: freeze({
        store: freeze({ schema: "shellx-motion/relation-actions@2" as const, sha256: action.storeSha256 }),
        definition: freeze({ id: action.definition.id, sha256: action.definitionSha256 }),
        request: freeze({ instanceId: actionRequest.instanceId, sha256: canonicalJsonSha256(actionRequest) }),
        applyPlan: applied.plan,
        outputCanonicalMotionSha256: applied.outputMotionSha256,
        changedPaths: freeze([...applied.changedPaths]),
        relationIds: freeze([relation.id]) as unknown as readonly [string],
      }),
      path: "/relations" as const,
      store: relationStore,
      storeSha256: canonicalJsonSha256(relationStore),
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
export function readCheckpointStoryboardRelationActionProfileRequest(value: unknown): CheckpointStoryboardRelationActionProfileRequest {
  const root = exactRecord(snapshotCheckpointStoryboardData(value), ["schema", "storyboard", "base", "objectLayerBindings"], [], "CheckpointStoryboard relation-action profile request");
  if (root.schema !== CHECKPOINT_STORYBOARD_RELATION_ACTION_PROFILE_REQUEST_SCHEMA) {
    throw new Error(`CheckpointStoryboard relation-action profile request.schema must equal ${CHECKPOINT_STORYBOARD_RELATION_ACTION_PROFILE_REQUEST_SCHEMA}.`);
  }
  const storyboard = readCheckpointStoryboard(root.storyboard);
  const base = readBase(root.base);
  const objectLayerBindings = readBindings(root.objectLayerBindings, storyboard);
  return freeze({ schema: CHECKPOINT_STORYBOARD_RELATION_ACTION_PROFILE_REQUEST_SCHEMA, storyboard, base, objectLayerBindings });
}
function readBase(value: unknown): CheckpointStoryboardRelationActionProfileRequest["base"] {
  const record = exactRecord(value, ["packageId", "manifest", "motion", "persistedMotionSha256"], [], "CheckpointStoryboard relation-action profile base");
  const packageId = safeId(record.packageId, "CheckpointStoryboard relation-action profile base.packageId");
  const manifestData = exactRecord(record.manifest, ["schema", "id", "name", "motion", "assets", "sourceApp", "compatibility"], ["template", "quality", "workflow", "data", "selectedFrameId"], "CheckpointStoryboard relation-action profile base.manifest");
  assertCompleteDocument("manifest", "packageManifest", manifestData);
  const manifest = readPackageManifest(manifestData);
  if (safeId(manifest.id, "CheckpointStoryboard relation-action profile base.manifest.id") !== packageId) {
    throw new Error("CheckpointStoryboard relation-action profile base must use its exact Motion package manifest.");
  }
  readMotionPath(manifest.motion);
  const motionData = exactRecord(record.motion, ["schema", "id", "name", "durationMs", "fps", "width", "height", "layers", "assets", "provenance"], ["background", "audio", "scenes", "tracks", "markers", "safeAreas", "compositing", "relationships", "behaviors", "relations", "layoutGapAnimation", "scene3dAnimation", "relationActions", "layoutApplications"], "CheckpointStoryboard relation-action profile base.motion");
  assertCompleteDocument("Motion document", "motion", motionData);
  const motion = readMotionDocument(motionData);
  safeId(motion.id, "CheckpointStoryboard relation-action profile base.motion.id");
  if (!Number.isSafeInteger(motion.durationMs) || motion.durationMs < 1 || motion.durationMs > 3_600_000) {
    throw new Error("CheckpointStoryboard relation-action profile base.motion.durationMs must be a bounded positive safe integer.");
  }
  if (!Array.isArray(motion.assets) || motion.assets.length !== 0) throw new Error("CheckpointStoryboard relation-action profile requires an asset-free T3 GPU relation-preview base.");
  if (!Array.isArray(motion.layers) || motion.layers.length !== 2) throw new Error("CheckpointStoryboard relation-action profile requires exactly two existing base layers.");
  for (const field of FORBIDDEN_MOTION_AUTHORITIES) if (Object.hasOwn(motion, field)) throw new Error(`CheckpointStoryboard relation-action profile refuses existing ${field} authority.`);
  if (!Object.hasOwn(motion, "relationActions")) throw new Error("CheckpointStoryboard relation-action profile requires its exact relationActions@2 definition store.");
  if (Object.hasOwn(motion, "traces") || Object.hasOwn(motion, "parametricTrace") || Object.hasOwn(motion, "parametricTraces")) throw new Error("CheckpointStoryboard relation-action profile refuses trace authority.");
  return freeze({ packageId, manifest: freeze(manifest) as PackageManifest, motion: freeze(motion), persistedMotionSha256: sha256(record.persistedMotionSha256, "CheckpointStoryboard relation-action profile base.persistedMotionSha256") });
}
function assertCompleteDocument(label: string, schema: "packageManifest" | "motion", value: unknown): void {
  const result = validateDocumentSync(loadSchemaSync(schema), value);
  if (!result.ok) {
    const first = result.errors[0]!;
    throw new Error(`CheckpointStoryboard relation-action profile ${label} is invalid at ${first.path || "/"}: ${first.message}`);
  }
}
function readMotionPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value !== value.normalize("NFC") || /[\u0000-\u001F\u007F-\u009F]/u.test(value) || value.split("/").some((segment) => segment === "." || segment === ".." || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))) {
    throw new Error("CheckpointStoryboard relation-action profile base.manifest.motion must be an NFC package-relative POSIX locator with clean ASCII segments only.");
  }
  return value;
}
function readBindings(value: unknown, storyboard: CheckpointStoryboard): CheckpointStoryboardRelationActionProfileRequest["objectLayerBindings"] {
  const entries = exactArray(value, "CheckpointStoryboard relation-action profile objectLayerBindings", 2, 2).map((entry, index) => {
    const record = exactRecord(entry, ["objectId", "layerId"], [], `CheckpointStoryboard relation-action profile objectLayerBindings[${index}]`);
    return freeze({ objectId: safeId(record.objectId, `CheckpointStoryboard relation-action profile objectLayerBindings[${index}].objectId`), layerId: safeId(record.layerId, `CheckpointStoryboard relation-action profile objectLayerBindings[${index}].layerId`) });
  });
  if (storyboard.objectCatalog.length !== 2 || entries.some((binding, index) => binding.objectId !== storyboard.objectCatalog[index]!.objectId || binding.objectId !== binding.layerId)) {
    throw new Error("CheckpointStoryboard relation-action profile requires two exact same-ID object/layer bindings in catalog order.");
  }
  strictIds(entries.map((binding) => binding.objectId), "CheckpointStoryboard relation-action profile bound object ids");
  return freeze(entries) as unknown as CheckpointStoryboardRelationActionProfileRequest["objectLayerBindings"];
}
function assertProfile(storyboard: CheckpointStoryboard, motion: MotionDocument) {
  const profile = assertCheckpointStoryboardRelationActionStaticProfile(storyboard);
  if (profile.to.atUs !== motion.durationMs * 1_000) {
    throw new Error("CheckpointStoryboard relation-action profile requires its terminal checkpoint at the exact package duration D.");
  }
  return profile;
}
function resolveAction(request: CheckpointStoryboardRelationActionProfileRequest, profile: ReturnType<typeof assertProfile>) {
  const inspection = inspectMotionRelationActions(request.base.motion);
  if (!inspection.store || !inspection.storeSha256 || inspection.store.definitions.length !== 1) {
    throw new Error("CheckpointStoryboard relation-action profile requires exactly one persisted relationActions@2 definition.");
  }
  const requirement = profile.recipe.exactBaseRequirements[0]!;
  const definition = inspection.store.definitions[0]!;
  const definitionSha256 = canonicalJsonSha256(definition);
  if (requirement.definitionId !== definition.id || requirement.definitionSha256 !== definitionSha256) {
    throw new Error("CheckpointStoryboard relation-action profile deferred exact-base definition does not match the persisted action definition.");
  }
  const action = assertDefinition(definition, profile, request.storyboard.objectCatalog);
  const bindingByObject = new Map(request.objectLayerBindings.map((binding, index) => [binding.objectId, {
    ...binding,
    layerIndex: index,
    // assertStaticProfile has already refused the only wider catalog member, "path".
    rootShapeKind: request.storyboard.objectCatalog[index]!.rootShapeKind as "rect" | "ellipse",
  }]));
  const roleObjectBindings = profile.intent.roleBindings;
  if (roleObjectBindings.length !== 2 || !strictOrder(roleObjectBindings.map((binding) => binding.roleId))) {
    throw new Error("CheckpointStoryboard relation-action profile requires two lexically sorted role bindings.");
  }
  if (!sameIds(roleObjectBindings.map((binding) => binding.roleId), definition.roles.map((role) => role.id))) {
    throw new Error("CheckpointStoryboard relation-action profile recipe roles must exactly match the selected action definition.");
  }
  if (new Set(roleObjectBindings.map((binding) => binding.objectId)).size !== 2 || !sameIds(roleObjectBindings.map((binding) => binding.objectId), request.storyboard.objectCatalog.map((entry) => entry.objectId))) {
    throw new Error("CheckpointStoryboard relation-action profile roles must bind one-to-one to the catalog objects.");
  }
  if (profile.intent.parameterValues.length !== 0) throw new Error("CheckpointStoryboard relation-action profile refuses action parameters.");
  const byRole = new Map(roleObjectBindings.map((binding) => [binding.roleId, binding.objectId]));
  const sourceObjectId = byRole.get(action.sourceRoleId)!;
  const targetObjectId = byRole.get(action.targetRoleId)!;
  const source = bindingByObject.get(sourceObjectId);
  const target = bindingByObject.get(targetObjectId);
  if (!source || !target) throw new Error("CheckpointStoryboard relation-action profile role bindings are stale.");
  if (source.objectId === target.objectId) throw new Error("CheckpointStoryboard relation-action profile action source and target must be distinct.");
  if (profile.intent.declaredWrites.length !== 1 || profile.intent.declaredWrites[0]!.objectId !== target.objectId || !sameMask(profile.intent.declaredWrites[0]!.propertyMask, OWNED_PROPERTY_MASK)) {
    throw new Error("CheckpointStoryboard relation-action profile declaredWrites must exactly name its relation target transform.x/transform.y authority.");
  }
  assertBaseLayer(request.base.motion.layers[source.layerIndex]!, source, request.base.motion.durationMs);
  assertBaseLayer(request.base.motion.layers[target.layerIndex]!, target, request.base.motion.durationMs);
  const roleLayerBindings = Object.fromEntries(roleObjectBindings.map((binding) => [binding.roleId, bindingByObject.get(binding.objectId)!.layerId]).sort(([left], [right]) => compareCodeUnits(left, right)));
  return freeze({
    definition,
    definitionSha256,
    storeSha256: inspection.storeSha256,
    source: freeze(source),
    target: freeze(target),
    objectLayerBindings: freeze({ source: freeze(source), target: freeze(target) }),
    roleLayerBindings: freeze(roleLayerBindings),
  });
}
function assertDefinition(definition: MotionRelationActionDefinition, profile: ReturnType<typeof assertProfile>, catalog: readonly CheckpointObjectCatalogEntry[]) {
  if (definition.roles.length !== 2 || !strictOrder(definition.roles.map((role) => role.id)) || definition.roles.some((role) => role.kind !== "layer" || role.layerTypes.length !== 1 || role.layerTypes[0] !== "shape")) {
    throw new Error("CheckpointStoryboard relation-action profile requires two sorted shape-only action roles.");
  }
  if (definition.parameters.length !== 0 || definition.templateLayers.length !== 0 || definition.relationTemplates.length !== 1 || definition.sequence.length !== 1) {
    throw new Error("CheckpointStoryboard relation-action profile requires no parameters/templates and exactly one relation template/step.");
  }
  const template = definition.relationTemplates[0]!;
  if (template.kind !== "attach" || template.enabled !== true || template.mode !== "follow" || template.offset.space !== "world" || template.startUs !== 0 || !literal(template.durationUs) || template.durationUs.value !== profile.to.atUs - profile.from.atUs || template.source.layer.source !== "role" || template.target.layer.source !== "role" || template.source.layer.roleId === template.target.layer.roleId) {
    throw new Error("CheckpointStoryboard relation-action profile requires one enabled world-space follow template spanning the exact edge.");
  }
  const sourceRoleId = template.source.layer.roleId;
  const targetRoleId = template.target.layer.roleId;
  if (!definition.roles.some((role) => role.id === sourceRoleId) || !definition.roles.some((role) => role.id === targetRoleId) || !literal(template.source.anchorX) || !literal(template.source.anchorY) || !literal(template.target.anchorX) || !literal(template.target.anchorY) || !literal(template.offset.x) || !literal(template.offset.y) || !literal(template.offset.rotationDeg) || !literal(template.offset.scale) || template.offset.rotationDeg.value !== 0 || template.offset.scale.value !== 1) {
    throw new Error("CheckpointStoryboard relation-action profile requires literal role endpoints and a translation-only world offset.");
  }
  const step = definition.sequence[0]!;
  if (step.kind !== "relation" || step.atUs !== 0 || step.relationTemplateId !== template.id) {
    throw new Error("CheckpointStoryboard relation-action profile requires exactly one zero-local-time relation step.");
  }
  if (catalog.length !== 2) throw new Error("CheckpointStoryboard relation-action profile internal catalog failure.");
  return freeze({ sourceRoleId, targetRoleId });
}
function assertBaseLayer(layer: MotionLayer, binding: { readonly objectId: string; readonly layerId: string; readonly rootShapeKind: string }, durationMs: number): void {
  const raw = layer as unknown as Record<string, unknown>;
  if (layer.id !== binding.layerId || layer.type !== "shape" || (layer.shape !== "rect" && layer.shape !== "ellipse") || layer.shape !== binding.rootShapeKind || Object.hasOwn(raw, "childLayerIds") || layer.visible === false || layer.locked === true) {
    throw new Error("CheckpointStoryboard relation-action profile requires exact unlocked root-owned rect or ellipse layers.");
  }
  if (FORBIDDEN_LAYER_AUTHORITIES.some((field) => Object.hasOwn(raw, field))) throw new Error("CheckpointStoryboard relation-action profile refuses transform/timing authority on a bound layer.");
  if (Object.hasOwn(raw, "depth") || Object.hasOwn(raw, "geometry") || Object.hasOwn(raw, "geometryKeyframes") || Object.hasOwn(raw, "morph")) throw new Error("CheckpointStoryboard relation-action profile refuses depth, geometry, or morph authority.");
  if (Object.hasOwn(raw, "effectModule") || hasMotionBlur(raw.effects)) throw new Error("CheckpointStoryboard relation-action profile refuses non-T3 GPU-preview effect authority.");
  if (layer.startMs !== 0 || layer.durationMs !== durationMs) throw new Error("CheckpointStoryboard relation-action profile requires each bound layer to span the exact document interval.");
}
function hasMotionBlur(value: unknown): boolean { return !!value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "motionBlur"); }
function assertActionProjection(source: MotionDocument, applied: ReturnType<typeof applyMotionRelationAction>, action: ReturnType<typeof resolveAction>): void {
  if (applied.createdObjectIds.length !== 0 || applied.relationIds.length !== 1 || applied.plan.counts.objects !== 0 || applied.plan.counts.relations !== 1 || applied.plan.counts.keyframeWrites !== 0) {
    throw new Error("CheckpointStoryboard relation-action profile action projection must create no objects and exactly one relation.");
  }
  const expectedPath = `/relations/bindings/${applied.relationIds[0]!}`;
  if (applied.changedPaths.length !== 1 || applied.changedPaths[0] !== expectedPath || !sameWithoutRelations(source, applied.motion)) {
    throw new Error("CheckpointStoryboard relation-action profile action projection changed a field outside /relations.");
  }
  if (canonicalJson(source.relationActions) !== canonicalJson(applied.motion.relationActions) || applied.plan.definition.id !== action.definition.id || applied.plan.definition.sha256 !== action.definitionSha256 || applied.plan.storeSha256 !== action.storeSha256) {
    throw new Error("CheckpointStoryboard relation-action profile action projection did not retain its exact action definition identity.");
  }
}
function assertEndpoint(evaluation: ReturnType<typeof evaluateMotionRelationAuthoringFrame>, checkpoint: { readonly objects: readonly CheckpointObjectState[] }, bindings: { readonly source: { readonly objectId: string; readonly layerId: string }; readonly target: { readonly objectId: string; readonly layerId: string } }, label: string): void {
  if (evaluation.samples.length !== 1 || evaluation.samples[0]!.targetLayerId !== bindings.target.layerId || !sameMask(evaluation.samples[0]!.writeMask, OWNED_PROPERTY_MASK)) throw new Error(`CheckpointStoryboard relation-action profile ${label} evaluation did not retain exactly one target-only follow sample.`);
  for (const role of ["source", "target"] as const) {
    const state = checkpoint.objects.find((item) => item.objectId === bindings[role].objectId);
    const layer = evaluation.layers.find((item) => item.id === bindings[role].layerId);
    if (!state || state.state !== "present" || !layer) throw new Error(`CheckpointStoryboard relation-action profile ${label} endpoint identity is unavailable.`);
    for (const property of OWNED_PROPERTY_MASK) {
      const expected = state.properties.find((entry) => entry.property === property)?.value;
      const actual = position(layer, property);
      if (expected !== actual) throw new Error(`CheckpointStoryboard relation-action profile ${label} endpoint does not exactly equal ${role}.${property}.`);
    }
  }
}
function position(layer: MotionLayer, property: CheckpointStoryboardRelationActionOwnedProperty): number {
  const value = property === "transform.x" ? layer.transform?.x : layer.transform?.y;
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`CheckpointStoryboard relation-action profile evaluated ${layer.id}.${property} is not finite.`);
  return value;
}
function stableInstanceId(storyboard: CheckpointStoryboard, recipe: TransitionRecipe): string {
  return `c6ra_${canonicalJsonSha256({ storyboard: { id: storyboard.id, sha256: storyboard.sha256 }, recipe: { id: recipe.id, sha256: recipe.sha256, revision: recipe.revision } }).slice(0, 32)}`;
}
function literal(value: unknown): value is { readonly source: "literal"; readonly value: number } {
  return !!value && typeof value === "object" && (value as { source?: unknown }).source === "literal" && typeof (value as { value?: unknown }).value === "number" && Number.isFinite((value as { value: number }).value);
}
function strictOrder(ids: readonly string[]): boolean { return ids.every((id, index) => index === 0 || compareCodeUnits(ids[index - 1]!, id) < 0); }
function sameIds(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && [...left].sort(compareCodeUnits).every((id, index) => id === [...right].sort(compareCodeUnits)[index]); }
function sameMask(actual: readonly CheckpointProperty[], expected: readonly CheckpointStoryboardRelationActionOwnedProperty[]): boolean { return actual.length === expected.length && actual.every((property, index) => property === expected[index]); }
function sameWithoutRelations(left: MotionDocument, right: MotionDocument): boolean { const { relations: _left, ...leftRest } = left, { relations: _right, ...rightRest } = right; return canonicalJson(leftRest) === canonicalJson(rightRest); }
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T { if (!value || typeof value !== "object" || seen.has(value)) return value; seen.add(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen); return Object.freeze(value); }
