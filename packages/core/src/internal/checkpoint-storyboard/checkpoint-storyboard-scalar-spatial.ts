/** Private C6B1a pure scalar/spatial lowering plan. It must stay outside every public barrel. */

import { canonicalJsonSha256 } from "../../canonical-json";
import {
  type CheckpointEdge,
  type CheckpointObjectCatalogEntry,
  type CheckpointObjectState,
  type CheckpointProperty,
  type CheckpointRecipeTarget,
  type CheckpointStoryboard,
  type TransitionRecipe,
} from "./checkpoint-storyboard-types";
import { compileCheckpointStoryboardPlan, readCheckpointStoryboard } from "./checkpoint-storyboard-records";
import { exactArray, exactRecord, freeze, safeId, sha256, snapshotCheckpointStoryboardData, strictIds } from "./checkpoint-storyboard-data";
import {
  CHECKPOINT_STORYBOARD_SCALAR_SPATIAL_LOWERER_PROFILE_SCHEMA,
  CHECKPOINT_STORYBOARD_SCALAR_SPATIAL_PLAN_SCHEMA,
  CHECKPOINT_STORYBOARD_SCALAR_SPATIAL_REQUEST_SCHEMA,
  type CheckpointScalarProperty,
  type CheckpointScalarSpatialCapability,
  type CheckpointStoryboardScalarSpatialBinding,
  type CheckpointStoryboardScalarSpatialKeyframe,
  type CheckpointStoryboardScalarSpatialLowering,
  type CheckpointStoryboardScalarSpatialPlan,
  type CheckpointStoryboardScalarSpatialRequest,
} from "./checkpoint-storyboard-scalar-spatial-types";
const SCALAR_PROPERTIES: readonly CheckpointScalarProperty[] = ["transform.rotation", "transform.scale", "opacity"];
const SCALAR_PROPERTY_SET = new Set<CheckpointProperty>(SCALAR_PROPERTIES);
const RECORD_PROPERTY_SET = new Set<CheckpointProperty>(["transform.x", "transform.y", "transform.rotation", "transform.scale", "opacity"]);
const SUPPORTED_CAPABILITIES: readonly CheckpointScalarSpatialCapability[] = ["renderer.browser", "renderer.native"];
const SUPPORTED_CAPABILITY_SET = new Set<string>(SUPPORTED_CAPABILITIES);
const TARGET_DYNAMIC_AUTHORITY_FIELDS = [
  "keyframes",
  "transitions",
  "tracking",
  "stabilization",
  "stabilize",
  "transformAuthority",
  "timingAuthority",
  "timeRemap",
  "trimStartMs",
  "trimDurationMs",
  "loop",
  "playbackRate",
  "x-tracking-stabilization",
] as const;
const TRACK_DYNAMIC_AUTHORITY_FIELDS = [
  "keyframes",
  "transitions",
  "transform",
  "tracking",
  "stabilization",
  "transformAuthority",
  "timingAuthority",
  "timeRemap",
  "fadeInMs",
  "fadeOutMs",
] as const;
const ZERO_HANDLE = freeze({ x: 0 as const, y: 0 as const });
type LowererSpatial = NonNullable<CheckpointStoryboardScalarSpatialKeyframe["spatial"]>;
const LINEAR_SPATIAL: LowererSpatial = freeze({ mode: "linear" as const, in: ZERO_HANDLE, out: ZERO_HANDLE });
const AUTO_SPATIAL: LowererSpatial = freeze({ mode: "auto" as const, in: ZERO_HANDLE, out: ZERO_HANDLE });

const LOWERER_PROFILE_PAYLOAD = freeze({
  schema: CHECKPOINT_STORYBOARD_SCALAR_SPATIAL_LOWERER_PROFILE_SCHEMA,
  supportedCapabilities: SUPPORTED_CAPABILITIES,
  scalarProperties: SCALAR_PROPERTIES,
  spatialTangentModes: ["linear", "auto"] as const,
});

/**
 * Plans only fresh ordinary scalar or paired-spatial keyframes. It is intentionally pure: callers
 * must supply detached base facts, and this function neither reads nor writes a package or receipt.
 */
export function compileCheckpointStoryboardScalarSpatialPlan(value: unknown): CheckpointStoryboardScalarSpatialPlan {
  const request = readCheckpointStoryboardScalarSpatialRequest(value);
  const storyboard = request.storyboard;
  const c6aPlan = compileCheckpointStoryboardPlan(storyboard);
  assertC6B1aRecordProfile(storyboard);
  assertC6B1aBaseDuration(storyboard, request.base.motion);
  const bindings = bindObjects(storyboard, request.base.motion, request.objectLayerBindings);
  const lowerings = lower(storyboard, bindings);
  const intendedChanges = changes(lowerings);
  const lowererProfile = freeze({ ...LOWERER_PROFILE_PAYLOAD, fingerprint: canonicalJsonSha256(LOWERER_PROFILE_PAYLOAD) });
  const payload = {
    schema: CHECKPOINT_STORYBOARD_SCALAR_SPATIAL_PLAN_SCHEMA,
    storyboard: freeze({ id: storyboard.id, sha256: storyboard.sha256, revision: storyboard.revision, fingerprint: c6aPlan.fingerprint }),
    base: freeze({
      package: freeze({ id: request.base.packageId, motionPath: request.base.manifest.motion }),
      manifest: freeze({ id: request.base.manifest.id, sha256: canonicalJsonSha256(request.base.manifest) }),
      canonicalMotion: freeze({ id: request.base.motion.id, sha256: canonicalJsonSha256(request.base.motion) }),
      persistedMotion: freeze({ id: request.base.motion.id, sha256: request.base.persistedMotionSha256 }),
    }),
    lowererProfile,
    objectLayerBindings: bindings,
    lowerings,
    intendedChanges,
    evidence: freeze({ noPackageIO: true as const, noPackageWrites: true as const, noReceipt: true as const, noPublicSurface: true as const, noRenderer: true as const }),
  };
  return freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}

/** Admit the base-independent B1 subset; exact base/binding/end checks remain materialization-only. */
export function admitCheckpointStoryboardScalarSpatialRecordProfile(value: unknown): CheckpointStoryboard {
  const storyboard = readCheckpointStoryboard(value); assertC6B1aRecordProfile(storyboard); return storyboard;
}

export function readCheckpointStoryboardScalarSpatialRequest(value: unknown): CheckpointStoryboardScalarSpatialRequest {
  const root = exactRecord(snapshotCheckpointStoryboardData(value), ["schema", "storyboard", "base", "objectLayerBindings"], [], "CheckpointStoryboard scalar/spatial request");
  if (root.schema !== CHECKPOINT_STORYBOARD_SCALAR_SPATIAL_REQUEST_SCHEMA) throw new Error(`CheckpointStoryboard scalar/spatial request.schema must equal ${CHECKPOINT_STORYBOARD_SCALAR_SPATIAL_REQUEST_SCHEMA}.`);
  const storyboard = readCheckpointStoryboard(root.storyboard);
  const base = readBase(root.base);
  const objectLayerBindings = readBindings(root.objectLayerBindings, storyboard);
  return freeze({ schema: CHECKPOINT_STORYBOARD_SCALAR_SPATIAL_REQUEST_SCHEMA, storyboard, base, objectLayerBindings });
}

function readBase(value: unknown): CheckpointStoryboardScalarSpatialRequest["base"] {
  const record = exactRecord(value, ["packageId", "manifest", "motion", "persistedMotionSha256"], [], "CheckpointStoryboard scalar/spatial base");
  const packageId = safeId(record.packageId, "CheckpointStoryboard scalar/spatial base.packageId");
  const manifest = exactRecord(record.manifest, ["schema", "id", "name", "motion", "assets", "sourceApp", "compatibility"], ["template", "quality", "workflow", "data", "selectedFrameId"], "CheckpointStoryboard scalar/spatial base.manifest");
  if (manifest.schema !== "shellx-motion/package-manifest@1") throw new Error("CheckpointStoryboard scalar/spatial base.manifest.schema is not a Motion package manifest.");
  if (safeId(manifest.id, "CheckpointStoryboard scalar/spatial base.manifest.id") !== packageId) throw new Error("CheckpointStoryboard scalar/spatial base packageId must exactly match manifest.id.");
  readPackageRelativeMotionLocator(manifest.motion);
  const motion = exactRecord(record.motion, ["schema", "id", "name", "durationMs", "fps", "width", "height", "layers", "assets", "provenance"], ["background", "audio", "scenes", "tracks", "markers", "safeAreas", "compositing", "relationships", "behaviors", "relations", "layoutGapAnimation", "scene3dAnimation", "relationActions", "layoutApplications"], "CheckpointStoryboard scalar/spatial base.motion");
  if (motion.schema !== "shellx-motion/motion@1") throw new Error("CheckpointStoryboard scalar/spatial base.motion.schema is not Motion@1.");
  safeId(motion.id, "CheckpointStoryboard scalar/spatial base.motion.id");
  if (typeof motion.durationMs !== "number" || !Number.isSafeInteger(motion.durationMs) || motion.durationMs < 1 || motion.durationMs > 3_600_000) throw new Error("CheckpointStoryboard scalar/spatial base.motion.durationMs must be a positive safe integer within the C6B1a bound.");
  if (!Array.isArray(motion.layers) || motion.layers.length < 1 || motion.layers.length > 64) throw new Error("CheckpointStoryboard scalar/spatial base.motion.layers must contain 1..64 layers.");
  for (const field of ["relationships", "behaviors", "relations", "relationActions", "layoutGapAnimation", "layoutApplications", "scene3dAnimation"] as const) {
    if (Object.hasOwn(motion, field)) throw new Error(`CheckpointStoryboard scalar/spatial base refuses existing ${field} authority.`);
  }
  if (Object.hasOwn(motion, "traces") || Object.hasOwn(motion, "parametricTrace") || Object.hasOwn(motion, "parametricTraces")) {
    throw new Error("CheckpointStoryboard scalar/spatial base refuses trace authority.");
  }
  return freeze({ packageId, manifest: freeze(manifest) as unknown as CheckpointStoryboardScalarSpatialRequest["base"]["manifest"], motion: freeze(motion) as unknown as CheckpointStoryboardScalarSpatialRequest["base"]["motion"], persistedMotionSha256: sha256(record.persistedMotionSha256, "CheckpointStoryboard scalar/spatial base.persistedMotionSha256") });
}

function readPackageRelativeMotionLocator(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new Error("CheckpointStoryboard scalar/spatial base.manifest.motion must be a bounded package-relative locator.");
  }
  if (
    value !== value.normalize("NFC") ||
    /[\u0000-\u001F\u007F-\u009F]/u.test(value) ||
    value.split("/").some((segment) =>
      segment === "." || segment === ".." || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment),
    )
  ) {
    throw new Error("CheckpointStoryboard scalar/spatial base.manifest.motion must be an NFC package-relative POSIX locator with clean ASCII segments only.");
  }
  return value;
}

function readBindings(value: unknown, storyboard: CheckpointStoryboard): readonly CheckpointStoryboardScalarSpatialBinding[] {
  const bindings = exactArray(value, "CheckpointStoryboard scalar/spatial objectLayerBindings", 64, storyboard.objectCatalog.length).map((item, index) => {
    const record = exactRecord(item, ["objectId", "layerId"], [], `CheckpointStoryboard scalar/spatial objectLayerBindings[${index}]`);
    return freeze({ objectId: safeId(record.objectId, `CheckpointStoryboard scalar/spatial objectLayerBindings[${index}].objectId`), layerId: safeId(record.layerId, `CheckpointStoryboard scalar/spatial objectLayerBindings[${index}].layerId`) });
  });
  if (bindings.length !== storyboard.objectCatalog.length) throw new Error("CheckpointStoryboard scalar/spatial objectLayerBindings must bind every catalog object exactly once.");
  for (const [index, binding] of bindings.entries()) if (binding.objectId !== storyboard.objectCatalog[index]!.objectId) {
    throw new Error("CheckpointStoryboard scalar/spatial objectLayerBindings must follow the exact sorted storyboard object catalog.");
  }
  strictIds(bindings.map((binding) => binding.objectId), "CheckpointStoryboard scalar/spatial bound object ids");
  if (new Set(bindings.map((binding) => binding.layerId)).size !== bindings.length) throw new Error("CheckpointStoryboard scalar/spatial objectLayerBindings cannot bind one layer to multiple objects.");
  if (bindings.some((binding) => binding.objectId !== binding.layerId)) {
    throw new Error("CheckpointStoryboard scalar/spatial objectLayerBindings must bind each storyboard object only to the exact same-ID base layer.");
  }
  return freeze(bindings);
}

function assertC6B1aRecordProfile(storyboard: CheckpointStoryboard): void {
  if (storyboard.capabilityRequirements.length === 0 || storyboard.capabilityRequirements.some((capability) => !SUPPORTED_CAPABILITY_SET.has(capability))) {
    throw new Error("CheckpointStoryboard scalar/spatial lowerer requires one or more canonical renderer.browser or renderer.native capability requirements.");
  }
  if (storyboard.checkpoints[0]!.atUs !== 0) throw new Error("CheckpointStoryboard scalar/spatial lowerer requires the first checkpoint at document zero.");
  if (storyboard.checkpoints.some((checkpoint) => checkpoint.atUs % 1_000 !== 0)) throw new Error("CheckpointStoryboard scalar/spatial lowerer requires whole-millisecond checkpoint endpoints.");
  if (storyboard.objectCatalog.some((entry) => entry.creation || (entry.rootShapeKind !== "rect" && entry.rootShapeKind !== "ellipse") || entry.propertyMask.some((property) => !RECORD_PROPERTY_SET.has(property)))) throw new Error("CheckpointStoryboard scalar/spatial lowerer refuses catalog creation payloads; geometry/morph or unsupported root-shape/property kinds.");
  for (const checkpoint of storyboard.checkpoints) for (const state of checkpoint.objects) {
    if (state.state !== "present" || state.properties.some((property) => !RECORD_PROPERTY_SET.has(property.property))) throw new Error("CheckpointStoryboard scalar/spatial lowerer refuses absent/create/remove lifecycle states and geometry.");
  }
  for (const edge of storyboard.edges) {
    if (edge.lifecycle.some((mapping) => mapping.kind !== "preserve")) throw new Error(`CheckpointStoryboard scalar/spatial lowerer requires preserve lifecycle on edge '${edge.id}'.`);
  }
  for (const recipe of storyboard.recipes) assertRecipe(recipe);
}

function assertC6B1aBaseDuration(
  storyboard: CheckpointStoryboard,
  motion: CheckpointStoryboardScalarSpatialRequest["base"]["motion"],
): void {
  const finalAtUs = motion.durationMs * 1_000;
  if (!Number.isSafeInteger(finalAtUs) || storyboard.checkpoints.at(-1)!.atUs !== finalAtUs) {
    throw new Error("CheckpointStoryboard scalar/spatial lowerer requires the final checkpoint at the exact document end.");
  }
}

function assertRecipe(recipe: TransitionRecipe): void {
  if (recipe.exactBaseRequirements.length !== 0) throw new Error(`CheckpointStoryboard scalar/spatial lowerer refuses exact-base action dependencies on recipe '${recipe.recipeId}'.`);
  if (recipe.intent.kind === "checkpoint-keyframe") {
    if (recipe.intent.targets.some((target) => target.propertyMask.some((property) => !SCALAR_PROPERTY_SET.has(property)))) {
      throw new Error(`CheckpointStoryboard scalar/spatial lowerer permits only rotation, scale, and opacity checkpoint-keyframes on recipe '${recipe.recipeId}'.`);
    }
    return;
  }
  if (recipe.intent.kind === "checkpoint-spatial-path") {
    if (recipe.intent.targets.some((target) => target.tangentMode !== "linear" && target.tangentMode !== "auto")) {
      throw new Error(`CheckpointStoryboard scalar/spatial lowerer permits only linear or auto checkpoint-spatial-path targets on recipe '${recipe.recipeId}'.`);
    }
    return;
  }
  throw new Error(`CheckpointStoryboard scalar/spatial lowerer refuses ${recipe.intent.kind} recipe '${recipe.recipeId}'.`);
}

function bindObjects(
  storyboard: CheckpointStoryboard,
  motion: CheckpointStoryboardScalarSpatialRequest["base"]["motion"],
  requested: readonly CheckpointStoryboardScalarSpatialBinding[],
): CheckpointStoryboardScalarSpatialPlan["objectLayerBindings"] {
  const groupedChildren = new Set<string>();
  const trackLocks = new Set<string>();
  const trackAuthorities = new Set<string>();
  for (const layer of motion.layers) {
    if (Array.isArray(layer.childLayerIds)) layer.childLayerIds.forEach((childId) => typeof childId === "string" && groupedChildren.add(childId));
  }
  if (Array.isArray(motion.tracks)) for (const track of motion.tracks) {
    if (!track || typeof track !== "object" || Array.isArray(track)) continue;
    const record = track as unknown as Record<string, unknown>;
    const trackHasDynamicAuthority = TRACK_DYNAMIC_AUTHORITY_FIELDS.some((field) => Object.hasOwn(record, field));
    if (record.locked === true) {
      if (typeof record.id === "string") trackLocks.add(record.id);
      if (Array.isArray(record.layerIds)) record.layerIds.forEach((layerId) => typeof layerId === "string" && trackLocks.add(`layer:${layerId}`));
    }
    if (trackHasDynamicAuthority) {
      if (typeof record.id === "string") trackAuthorities.add(record.id);
      if (Array.isArray(record.layerIds)) record.layerIds.forEach((layerId) => typeof layerId === "string" && trackAuthorities.add(`layer:${layerId}`));
    }
  }
  const bound = requested.map((binding, index) => {
    const catalog = storyboard.objectCatalog[index]!;
    const layerIndex = motion.layers.findIndex((layer) => layer.id === binding.layerId);
    const layer = motion.layers[layerIndex];
    if (!layer) throw new Error(`CheckpointStoryboard scalar/spatial binding '${binding.objectId}' references no exact-base layer '${binding.layerId}'.`);
    assertLayer(binding.objectId, catalog, layer as unknown as Record<string, unknown>, layerIndex, storyboard, groupedChildren, trackLocks, trackAuthorities);
    return freeze({ objectId: binding.objectId, layerId: binding.layerId, layerIndex, rootShapeKind: catalog.rootShapeKind as "rect" | "ellipse" });
  });
  return freeze(bound);
}

function assertLayer(
  objectId: string,
  catalog: CheckpointObjectCatalogEntry,
  layer: Record<string, unknown>,
  layerIndex: number,
  storyboard: CheckpointStoryboard,
  groupedChildren: ReadonlySet<string>,
  trackLocks: ReadonlySet<string>,
  trackAuthorities: ReadonlySet<string>,
): void {
  if (layer.type !== "shape" || layer.shape !== catalog.rootShapeKind || (layer.shape !== "rect" && layer.shape !== "ellipse")) throw new Error(`CheckpointStoryboard scalar/spatial binding '${objectId}' must target an existing rect or ellipse shape layer.`);
  if (typeof layer.id !== "string" || groupedChildren.has(layer.id) || Object.hasOwn(layer, "childLayerIds")) throw new Error(`CheckpointStoryboard scalar/spatial binding '${objectId}' refuses groups and requires a root-owned layer.`);
  if (layer.locked === true || (typeof layer.trackId === "string" && trackLocks.has(layer.trackId)) || trackLocks.has(`layer:${layer.id}`)) throw new Error(`CheckpointStoryboard scalar/spatial binding '${objectId}' refuses locked layers or tracks.`);
  if ((typeof layer.trackId === "string" && trackAuthorities.has(layer.trackId)) || trackAuthorities.has(`layer:${layer.id}`)) throw new Error(`CheckpointStoryboard scalar/spatial binding '${objectId}' refuses track transform or timing authority.`);
  if (Object.hasOwn(layer, "depth")) throw new Error(`CheckpointStoryboard scalar/spatial binding '${objectId}' refuses depth.`);
  if (Object.hasOwn(layer, "geometry") || Object.hasOwn(layer, "geometryKeyframes")) throw new Error(`CheckpointStoryboard scalar/spatial binding '${objectId}' refuses geometry authority.`);
  for (const field of TARGET_DYNAMIC_AUTHORITY_FIELDS) {
    if (Object.hasOwn(layer, field)) throw new Error(`CheckpointStoryboard scalar/spatial binding '${objectId}' refuses existing ${field} authority.`);
  }
  const startMs = layer.startMs, durationMs = layer.durationMs;
  if (typeof startMs !== "number" || typeof durationMs !== "number" || !Number.isSafeInteger(startMs) || !Number.isSafeInteger(durationMs) || startMs < 0 || durationMs < 1 || startMs + durationMs > 3_600_000) throw new Error(`CheckpointStoryboard scalar/spatial binding '${objectId}' has an invalid exact-base layer span.`);
  for (const edge of storyboard.edges) {
    const from = storyboard.checkpoints.find((checkpoint) => checkpoint.id === edge.fromCheckpointId)!;
    const to = storyboard.checkpoints.find((checkpoint) => checkpoint.id === edge.toCheckpointId)!;
    const fromMs = from.atUs / 1_000, toMs = to.atUs / 1_000;
    if (startMs > fromMs || startMs + durationMs < toMs) throw new Error(`CheckpointStoryboard scalar/spatial binding '${objectId}' layer must span edge '${edge.id}'.`);
  }
  if (layerIndex < 0) throw new Error("CheckpointStoryboard scalar/spatial internal layer binding failure.");
}

function lower(
  storyboard: CheckpointStoryboard,
  bindings: CheckpointStoryboardScalarSpatialPlan["objectLayerBindings"],
): readonly CheckpointStoryboardScalarSpatialLowering[] {
  const bindingByObjectId = new Map(bindings.map((binding) => [binding.objectId, binding]));
  const recipeById = new Map(storyboard.recipes.map((recipe) => [recipe.recipeId, recipe]));
  const result: CheckpointStoryboardScalarSpatialLowering[] = [];
  for (const edge of storyboard.edges) {
    const from = storyboard.checkpoints.find((checkpoint) => checkpoint.id === edge.fromCheckpointId)!;
    const to = storyboard.checkpoints.find((checkpoint) => checkpoint.id === edge.toCheckpointId)!;
    for (const recipeId of edge.recipeIds) {
      const recipe = recipeById.get(recipeId)!;
      const recipeIdentity = freeze({ id: recipe.id, sha256: recipe.sha256, revision: recipe.revision, recipeId: recipe.recipeId });
      const edgeIdentity = freeze({ id: edge.id, fromCheckpointId: edge.fromCheckpointId, toCheckpointId: edge.toCheckpointId });
      if (recipe.intent.kind === "checkpoint-keyframe") for (const target of recipe.intent.targets) {
        const binding = bindingByObjectId.get(target.objectId)!;
        result.push(freeze({ kind: "checkpoint-keyframe" as const, edge: edgeIdentity, recipe: recipeIdentity, object: bindingObject(binding), properties: scalarProperties(target, from, to, recipe.intent.easing) }));
      }
      else if (recipe.intent.kind === "checkpoint-spatial-path") for (const target of recipe.intent.targets) {
        const binding = bindingByObjectId.get(target.objectId)!;
        const source = stateFor(from.objects, target.objectId), destination = stateFor(to.objects, target.objectId);
        if (target.tangentMode !== "linear" && target.tangentMode !== "auto") throw new Error(`CheckpointStoryboard scalar/spatial lowerer permits only linear or auto checkpoint-spatial-path targets on recipe '${recipe.recipeId}'.`);
        const tangentMode = target.tangentMode, spatial = tangentMode === "linear" ? LINEAR_SPATIAL : AUTO_SPATIAL;
        result.push(freeze({
          kind: "checkpoint-spatial-path" as const, edge: edgeIdentity, recipe: recipeIdentity, object: bindingObject(binding), tangentMode,
          keyframes: freeze({ x: freeze([spatialFrame(from.atUs / 1_000, propertyValue(source, "transform.x"), spatial), spatialFrame(to.atUs / 1_000, propertyValue(destination, "transform.x"), spatial)] as const), y: freeze([plainFrame(from.atUs / 1_000, propertyValue(source, "transform.y"), "linear"), plainFrame(to.atUs / 1_000, propertyValue(destination, "transform.y"))] as const) }),
        }));
      }
    }
  }
  return freeze(result);
}

function scalarProperties(target: CheckpointRecipeTarget, from: { readonly atUs: number; readonly objects: readonly CheckpointObjectState[] }, to: { readonly atUs: number; readonly objects: readonly CheckpointObjectState[] }, easing: "linear" | "ease-in" | "ease-out" | "ease-in-out") {
  const source = stateFor(from.objects, target.objectId), destination = stateFor(to.objects, target.objectId);
  return freeze(target.propertyMask.map((property) => freeze({ property: property as CheckpointScalarProperty, keyframes: freeze([plainFrame(from.atUs / 1_000, propertyValue(source, property), easing), plainFrame(to.atUs / 1_000, propertyValue(destination, property))] as const) })));
}
function stateFor(objects: readonly CheckpointObjectState[], objectId: string): Extract<CheckpointObjectState, { readonly state: "present" }> {
  const state = objects.find((object) => object.objectId === objectId);
  if (!state || state.state !== "present") throw new Error(`CheckpointStoryboard scalar/spatial lowering requires present object '${objectId}'.`);
  return state;
}
function propertyValue(state: Extract<CheckpointObjectState, { readonly state: "present" }>, property: CheckpointProperty): number {
  const entry = state.properties.find((candidate) => candidate.property === property);
  if (!entry) throw new Error(`CheckpointStoryboard scalar/spatial lowering requires '${property}' on '${state.objectId}'.`);
  return entry.value;
}
function plainFrame(atMs: number, value: number, easing?: "linear" | "ease-in" | "ease-out" | "ease-in-out"): CheckpointStoryboardScalarSpatialKeyframe {
  return freeze({ atMs, value, ...(easing ? { easing } : {}) });
}
function spatialFrame(atMs: number, value: number, spatial: LowererSpatial): CheckpointStoryboardScalarSpatialKeyframe {
  return freeze({ atMs, value, easing: "linear", spatial });
}
function bindingObject(binding: CheckpointStoryboardScalarSpatialPlan["objectLayerBindings"][number]) {
  return freeze({ objectId: binding.objectId, layerId: binding.layerId, layerIndex: binding.layerIndex });
}

function changes(lowerings: readonly CheckpointStoryboardScalarSpatialLowering[]): CheckpointStoryboardScalarSpatialPlan["intendedChanges"] {
  const paths: string[] = [], keys: { path: string; atMs: number; value: number }[] = [];
  const add = (path: string, keyframes: readonly CheckpointStoryboardScalarSpatialKeyframe[]) => {
    if (!paths.includes(path)) paths.push(path);
    keyframes.forEach((keyframe) => keys.push(freeze({ path, atMs: keyframe.atMs, value: keyframe.value })));
  };
  for (const lowering of lowerings) {
    if (lowering.kind === "checkpoint-keyframe") for (const property of lowering.properties) add(`/layers/${lowering.object.layerIndex}/keyframes/${property.property}`, property.keyframes);
    else {
      add(`/layers/${lowering.object.layerIndex}/keyframes/transform.x`, lowering.keyframes.x);
      add(`/layers/${lowering.object.layerIndex}/keyframes/transform.y`, lowering.keyframes.y);
    }
  }
  return freeze({ paths: freeze(paths), keys: freeze(keys) });
}
