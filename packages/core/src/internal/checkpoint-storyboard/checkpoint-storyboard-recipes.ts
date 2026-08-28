import {
  MAX_CHECKPOINT_STORYBOARD_RECIPE_BYTES, MAX_CHECKPOINT_STORYBOARD_SEED, MAX_CHECKPOINT_STORYBOARD_WORK_UNITS,
  type CheckpointBehaviorIntent, type CheckpointGeometryMorphIntent, type CheckpointParametricTraceIntent, type CheckpointProperty,
  type CheckpointRecipeIntent, type CheckpointRecipeKind, type CheckpointRecipeTarget,
  type CheckpointRelationActionIntent, type CheckpointRelationIntent, type TransitionRecipe, type TransitionRecipeDescriptor,
  TRANSITION_RECIPE_SCHEMA,
} from "./checkpoint-storyboard-types";
import { readMotionParametricTraceDescriptor } from "../../motion-parametric-trace-read";
import { MAX_MOTION_SHAPE_GEOMETRY_KEYFRAME_INTERPOLATION_SCALARS } from "../../motion-shape-geometry-keyframes";
import {
  assertSealed, exactArray, exactRecord, finite, freeze, safeId, sealed, sha256, snapshotCheckpointStoryboardData,
  storageBytes, strictIds,
} from "./checkpoint-storyboard-data";

const PROPERTY_ORDER: readonly CheckpointProperty[] = ["transform.x", "transform.y", "transform.rotation", "transform.scale", "opacity"];
const PROPERTY_SET = new Set<CheckpointProperty>(PROPERTY_ORDER);
const RECIPE_KINDS = new Set<CheckpointRecipeKind>(["checkpoint-keyframe", "checkpoint-spatial-path", "checkpoint-geometry-morph", "transform-behavior", "relation", "relation-action", "parametric-trace"]);

export function createTransitionRecipe(value: unknown): TransitionRecipe {
  const descriptor = readTransitionRecipeDescriptor(value), parent = descriptor.parent ? readTransitionRecipe(descriptor.parent) : undefined;
  if (parent && parent.recipeId !== descriptor.recipeId) throw new Error("TransitionRecipe.parent must retain the same recipeId.");
  const revisionValue = parent ? parent.revision + 1 : 1;
  if (revisionValue > 1_000_000) throw new Error("TransitionRecipe revision exceeds the 1000000-revision limit.");
  const payload = { schema: TRANSITION_RECIPE_SCHEMA, revision: revisionValue, ...(parent ? { parentRevision: identity(parent) } : {}), recipeId: descriptor.recipeId, seed: descriptor.seed, intent: descriptor.intent, exactBaseRequirements: descriptor.exactBaseRequirements };
  const budget = freeze({ workUnits: workUnits(descriptor.intent), storageBytes: storageBytes(payload) });
  if (budget.storageBytes > MAX_CHECKPOINT_STORYBOARD_RECIPE_BYTES) throw new Error(`Transition recipe exceeds the ${MAX_CHECKPOINT_STORYBOARD_RECIPE_BYTES}-byte storage limit.`);
  const sealedPayload = { ...payload, budget }, sealedIdentity = sealed("transition_recipe", sealedPayload);
  return freeze({ ...sealedPayload, ...sealedIdentity }) as TransitionRecipe;
}

export function readTransitionRecipe(value: unknown): TransitionRecipe {
  const record = exactRecord(snapshotCheckpointStoryboardData(value), ["schema", "id", "sha256", "revision", "recipeId", "seed", "intent", "exactBaseRequirements", "budget"], ["parentRevision"], "TransitionRecipe");
  if (record.schema !== TRANSITION_RECIPE_SCHEMA) throw new Error(`TransitionRecipe.schema must equal ${TRANSITION_RECIPE_SCHEMA}.`);
  const descriptor = readDescriptorRecord(record), revisionValue = revision(record.revision, "TransitionRecipe.revision"), parentRevision = Object.hasOwn(record, "parentRevision") ? readIdentity(record.parentRevision, "TransitionRecipe.parentRevision") : undefined;
  if (revisionValue === 1 && parentRevision) throw new Error("TransitionRecipe revision 1 must not declare parentRevision.");
  if (revisionValue > 1 && !parentRevision) throw new Error("TransitionRecipe revision greater than 1 requires parentRevision.");
  const payload = { schema: TRANSITION_RECIPE_SCHEMA, revision: revisionValue, ...(parentRevision ? { parentRevision } : {}), recipeId: descriptor.recipeId, seed: descriptor.seed, intent: descriptor.intent, exactBaseRequirements: descriptor.exactBaseRequirements };
  const budgetRecord = exactRecord(record.budget, ["workUnits", "storageBytes"], [], "TransitionRecipe.budget");
  const expected = freeze({ workUnits: workUnits(descriptor.intent), storageBytes: storageBytes(payload) });
  if (budgetRecord.workUnits !== expected.workUnits || budgetRecord.storageBytes !== expected.storageBytes) throw new Error("TransitionRecipe.budget is stale.");
  if (expected.storageBytes > MAX_CHECKPOINT_STORYBOARD_RECIPE_BYTES) throw new Error(`Transition recipe exceeds the ${MAX_CHECKPOINT_STORYBOARD_RECIPE_BYTES}-byte storage limit.`);
  assertSealed("transition_recipe", record, { ...payload, budget: expected });
  return freeze({ ...payload, budget: expected, id: record.id as string, sha256: record.sha256 as string }) as TransitionRecipe;
}

export function readTransitionRecipeDescriptor(value: unknown): TransitionRecipeDescriptor {
  const record = exactRecord(snapshotCheckpointStoryboardData(value), ["recipeId", "seed", "intent", "exactBaseRequirements"], ["parent"], "TransitionRecipeDescriptor");
  const descriptor = readDescriptorRecord(record);
  return freeze({ ...descriptor, ...(Object.hasOwn(record, "parent") ? { parent: readTransitionRecipe(record.parent) } : {}) });
}

function readDescriptorRecord(record: Record<string, unknown>): TransitionRecipeDescriptor {
  const recipeId = safeId(record.recipeId, "TransitionRecipe.recipeId");
  if (typeof record.seed !== "number" || !Number.isSafeInteger(record.seed) || record.seed < 0 || record.seed > MAX_CHECKPOINT_STORYBOARD_SEED) throw new Error(`TransitionRecipe.seed must be a safe integer in 0..${MAX_CHECKPOINT_STORYBOARD_SEED}.`);
  const intent = readIntent(record.intent), exactBaseRequirements = readExactBaseRequirements(record.exactBaseRequirements, intent.kind);
  return freeze({ recipeId, seed: record.seed, intent, exactBaseRequirements });
}

function readIntent(value: unknown): CheckpointRecipeIntent {
  const kind = exactRecord(value, ["kind"], ["targets", "easing", "targetObjectId", "behavior", "relationKind", "sourceObjectId", "sourceAnchor", "targetAnchor", "offset", "rotationOffsetDeg", "roleBindings", "parameterValues", "declaredWrites", "outputObjectId", "trace"], "TransitionRecipe.intent").kind;
  if (typeof kind !== "string" || !RECIPE_KINDS.has(kind as CheckpointRecipeKind)) throw new Error("TransitionRecipe.intent.kind is not a C6-owned closed lowering intent.");
  if (kind === "checkpoint-keyframe") {
    const record = exactRecord(value, ["kind", "targets", "easing"], [], "checkpoint-keyframe intent");
    if (record.easing !== "linear" && record.easing !== "ease-in" && record.easing !== "ease-out" && record.easing !== "ease-in-out") throw new Error("checkpoint-keyframe intent.easing is not admitted.");
    return freeze({ kind, targets: readTargets(record.targets, "checkpoint-keyframe intent.targets", 1), easing: record.easing });
  }
  if (kind === "checkpoint-spatial-path") {
    const record = exactRecord(value, ["kind", "targets"], [], "checkpoint-spatial-path intent"), targets = exactArray(record.targets, "checkpoint-spatial-path intent.targets", 16, 1).map((item, index) => {
      const target = exactRecord(item, ["objectId", "tangentMode"], [], `checkpoint-spatial-path intent.targets[${index}]`);
      if (target.tangentMode !== "linear" && target.tangentMode !== "smooth" && target.tangentMode !== "broken" && target.tangentMode !== "auto") throw new Error("checkpoint-spatial-path tangentMode is not admitted.");
      return freeze({ objectId: safeId(target.objectId, "checkpoint-spatial-path objectId"), tangentMode: target.tangentMode as "linear" | "smooth" | "broken" | "auto" });
    });
    strictIds(targets.map((target) => target.objectId), "checkpoint-spatial-path intent target object ids"); return freeze({ kind, targets: freeze(targets) });
  }
  if (kind === "checkpoint-geometry-morph") return readGeometryMorphIntent(value);
  if (kind === "transform-behavior") return readBehaviorIntent(value);
  if (kind === "relation") return readRelationIntent(value);
  if (kind === "relation-action") return readRelationActionIntent(value);
  return readTraceIntent(value);
}

function readGeometryMorphIntent(value: unknown): CheckpointGeometryMorphIntent {
  const record = exactRecord(value, ["kind", "targets"], [], "checkpoint-geometry-morph intent");
  const targets = exactArray(record.targets, "checkpoint-geometry-morph intent.targets", 16, 1).map((item, index) => {
    const target = exactRecord(item, ["objectId", "easing"], [], `checkpoint-geometry-morph intent.targets[${index}]`);
    if (target.easing !== "linear") throw new Error("checkpoint-geometry-morph intent target easing must be linear.");
    return freeze({ objectId: safeId(target.objectId, `checkpoint-geometry-morph intent.targets[${index}].objectId`), easing: "linear" as const });
  });
  strictIds(targets.map((target) => target.objectId), "checkpoint-geometry-morph intent target object ids");
  return freeze({ kind: "checkpoint-geometry-morph", targets: freeze(targets) });
}

function readTargets(value: unknown, label: string, minimum = 0): readonly CheckpointRecipeTarget[] {
  const targets = exactArray(value, label, 16, minimum).map((item, index) => {
    const record = exactRecord(item, ["objectId", "propertyMask"], [], `${label}[${index}]`);
    return freeze({ objectId: safeId(record.objectId, `${label}[${index}].objectId`), propertyMask: readMask(record.propertyMask, `${label}[${index}].propertyMask`, 1) });
  });
  strictIds(targets.map((target) => target.objectId), `${label} object ids`); return freeze(targets);
}

function readBehaviorIntent(value: unknown): CheckpointBehaviorIntent {
  const record = exactRecord(value, ["kind", "targetObjectId", "behavior"], [], "transform-behavior intent"), behaviorRecord = exactRecord(record.behavior, ["kind"], ["velocityX", "velocityY", "gravityY", "floorY", "restitution"], "transform-behavior intent.behavior");
  const targetObjectId = safeId(record.targetObjectId, "transform-behavior intent.targetObjectId");
  if (behaviorRecord.kind === "gravity") {
    const gravity = exactRecord(record.behavior, ["kind", "velocityX", "velocityY", "gravityY"], [], "gravity behavior");
    return freeze({ kind: "transform-behavior", targetObjectId, behavior: freeze({ kind: "gravity", velocityX: finite(gravity.velocityX, "gravity.velocityX", -100_000, 100_000), velocityY: finite(gravity.velocityY, "gravity.velocityY", -100_000, 100_000), gravityY: finite(gravity.gravityY, "gravity.gravityY", 0.000001, 100_000) }) });
  }
  if (behaviorRecord.kind === "bounce") {
    const bounce = exactRecord(record.behavior, ["kind", "floorY", "velocityY", "gravityY", "restitution"], [], "bounce behavior");
    return freeze({ kind: "transform-behavior", targetObjectId, behavior: freeze({ kind: "bounce", floorY: finite(bounce.floorY, "bounce.floorY", -1_000_000, 1_000_000), velocityY: finite(bounce.velocityY, "bounce.velocityY", -100_000, 100_000), gravityY: finite(bounce.gravityY, "bounce.gravityY", 0.000001, 100_000), restitution: finite(bounce.restitution, "bounce.restitution", 0, 1) }) });
  }
  throw new Error("transform-behavior intent.behavior.kind must be gravity or bounce.");
}

function readRelationIntent(value: unknown): CheckpointRelationIntent {
  const record = exactRecord(value, ["kind", "relationKind", "sourceObjectId", "targetObjectId", "sourceAnchor", "targetAnchor"], ["offset", "rotationOffsetDeg"], "relation intent"), base = { kind: "relation" as const, relationKind: record.relationKind, sourceObjectId: safeId(record.sourceObjectId, "relation intent.sourceObjectId"), targetObjectId: safeId(record.targetObjectId, "relation intent.targetObjectId"), sourceAnchor: anchor(record.sourceAnchor, "relation intent.sourceAnchor"), targetAnchor: anchor(record.targetAnchor, "relation intent.targetAnchor") };
  if (base.sourceObjectId === base.targetObjectId) throw new Error("relation intent sourceObjectId and targetObjectId must differ.");
  if (record.relationKind === "follow" || record.relationKind === "similarity") {
    const offset = exactRecord(record.offset, ["space", "x", "y", "rotationDeg", "scale"], [], "relation intent.offset");
    if (offset.space !== "source" && offset.space !== "world") throw new Error("relation intent.offset.space must be source or world.");
    return freeze({ ...base, relationKind: record.relationKind, offset: freeze({ space: offset.space, x: finite(offset.x, "relation intent.offset.x", -1_000_000, 1_000_000), y: finite(offset.y, "relation intent.offset.y", -1_000_000, 1_000_000), rotationDeg: finite(offset.rotationDeg, "relation intent.offset.rotationDeg", -360_000, 360_000), scale: finite(offset.scale, "relation intent.offset.scale", 0.001, 64) }) });
  }
  if (record.relationKind === "aim") return freeze({ ...base, relationKind: "aim", rotationOffsetDeg: finite(record.rotationOffsetDeg, "relation intent.rotationOffsetDeg", -360_000, 360_000) });
  throw new Error("relation intent.relationKind must be follow, similarity, or aim.");
}

function anchor(value: unknown, label: string) {
  const record = exactRecord(value, ["x", "y"], [], label);
  return freeze({ x: finite(record.x, `${label}.x`, -1_000_000, 1_000_000), y: finite(record.y, `${label}.y`, -1_000_000, 1_000_000) });
}

function readRelationActionIntent(value: unknown): CheckpointRelationActionIntent {
  const record = exactRecord(value, ["kind", "roleBindings", "parameterValues", "declaredWrites"], [], "relation-action intent");
  const roleBindings = exactArray(record.roleBindings, "relation-action intent.roleBindings", 16).map((item, index) => { const binding = exactRecord(item, ["roleId", "objectId"], [], `relation-action roleBindings[${index}]`); return freeze({ roleId: safeId(binding.roleId, "relation-action roleId"), objectId: safeId(binding.objectId, "relation-action objectId") }); });
  strictIds(roleBindings.map((binding) => binding.roleId), "relation-action role ids");
  const parameterValues = exactArray(record.parameterValues, "relation-action intent.parameterValues", 16).map((item, index) => { const parameter = exactRecord(item, ["parameterId", "value"], [], `relation-action parameterValues[${index}]`); if (typeof parameter.value !== "number" && (typeof parameter.value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(parameter.value))) throw new Error("relation-action parameter values must be finite numbers or #RRGGBB colours."); if (typeof parameter.value === "number" && !Number.isFinite(parameter.value)) throw new Error("relation-action parameter values must be finite numbers or #RRGGBB colours."); return freeze({ parameterId: safeId(parameter.parameterId, "relation-action parameterId"), value: typeof parameter.value === "string" ? parameter.value.toLowerCase() : parameter.value }); });
  strictIds(parameterValues.map((parameter) => parameter.parameterId), "relation-action parameter ids");
  return freeze({ kind: "relation-action", roleBindings: freeze(roleBindings), parameterValues: freeze(parameterValues), declaredWrites: readTargets(record.declaredWrites, "relation-action intent.declaredWrites") });
}

function readTraceIntent(value: unknown): CheckpointParametricTraceIntent {
  const record = exactRecord(value, ["kind", "outputObjectId", "trace"], [], "parametric-trace intent"), trace = readMotionParametricTraceDescriptor(record.trace);
  if (trace.drawers.some((drawer) => drawer.driver.kind === "behavior" || drawer.driver.kind === "relation")) throw new Error("parametric-trace intent refuses behavior- or relation-driven traces until C6B exact-base resolution exists.");
  return freeze({ kind: "parametric-trace", outputObjectId: safeId(record.outputObjectId, "parametric-trace intent.outputObjectId"), trace });
}

function readExactBaseRequirements(value: unknown, intentKind: CheckpointRecipeKind) {
  const requirements = exactArray(value, "TransitionRecipe.exactBaseRequirements", 1).map((item, index) => {
    const record = exactRecord(item, ["resolution", "definitionId", "definitionSha256"], [], `TransitionRecipe.exactBaseRequirements[${index}]`);
    if (record.resolution !== "deferred-exact-base") throw new Error("TransitionRecipe exact-base requirement resolution must be deferred-exact-base.");
    return freeze({ resolution: "deferred-exact-base" as const, definitionId: safeId(record.definitionId, "TransitionRecipe exact-base definitionId"), definitionSha256: sha256(record.definitionSha256, "TransitionRecipe exact-base definitionSha256") });
  });
  if (intentKind === "relation-action" ? requirements.length !== 1 : requirements.length !== 0) throw new Error(intentKind === "relation-action" ? "relation-action requires exactly one deferred-exact-base definition requirement." : "Only relation-action may carry an exact-base requirement in C6A.");
  return freeze(requirements);
}

function readMask(value: unknown, label: string, minimum: number): readonly CheckpointProperty[] {
  const mask = exactArray(value, label, PROPERTY_ORDER.length, minimum).map((item, index) => { if (typeof item !== "string" || !PROPERTY_SET.has(item as CheckpointProperty)) throw new Error(`${label}[${index}] is not an admitted property.`); return item as CheckpointProperty; });
  if (mask.some((property, index) => index > 0 && PROPERTY_ORDER.indexOf(mask[index - 1]!) >= PROPERTY_ORDER.indexOf(property))) throw new Error(`${label} must follow canonical property order without duplicates.`);
  return freeze(mask);
}

function workUnits(intent: CheckpointRecipeIntent): number {
  const computed = intent.kind === "checkpoint-keyframe" ? intent.targets.reduce((total, target) => total + target.propertyMask.length * 2, 0)
    : intent.kind === "checkpoint-spatial-path" ? intent.targets.length * 8
      : intent.kind === "checkpoint-geometry-morph" ? intent.targets.length * MAX_MOTION_SHAPE_GEOMETRY_KEYFRAME_INTERPOLATION_SCALARS
        : intent.kind === "transform-behavior" ? 32
          : intent.kind === "relation" ? 16
            : intent.kind === "relation-action" ? 16 + intent.declaredWrites.reduce((total, target) => total + target.propertyMask.length, 0)
              : intent.trace.drawers.reduce((total, drawer) => total + Math.ceil(intent.trace.clip.durationUs / intent.trace.clip.sampleIntervalUs) + (drawer.driver.kind === "bounded-bounce" ? drawer.driver.maxCollisions : 0), 0);
  if (!Number.isSafeInteger(computed) || computed < 1 || computed > MAX_CHECKPOINT_STORYBOARD_WORK_UNITS) throw new Error(`Transition recipe exceeds the ${MAX_CHECKPOINT_STORYBOARD_WORK_UNITS}-work-unit limit.`);
  return computed;
}

function identity(value: Pick<TransitionRecipe, "id" | "sha256">) { return freeze({ id: value.id, sha256: value.sha256 }); }
function readIdentity(value: unknown, label: string) {
  const record = exactRecord(value, ["id", "sha256"], [], label);
  if (typeof record.id !== "string" || !/^transition_recipe_[a-f0-9]{32}$/.test(record.id)) throw new Error(`${label}.id must be a canonical transition recipe identity.`);
  const digest = sha256(record.sha256, `${label}.sha256`);
  if (record.id !== `transition_recipe_${digest.slice(0, 32)}`) throw new Error(`${label}.id must match the supplied sha256 prefix.`);
  return freeze({ id: record.id, sha256: digest });
}
function revision(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 1_000_000) throw new Error(`${label} must be a positive safe integer revision.`);
  return value;
}
