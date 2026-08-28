import { canonicalJson, canonicalJsonSha256 } from "../../canonical-json";
import { exactArray, exactRecord, freeze, safeId, safeUs, snapshotSceneRecipeData, uniqueIds } from "./scene-recipe-data";
import { assertGltfObjectPlanForScene, assertGltfObjectStoryPlanForScene } from "./gltf-object-scene";
import { mintGltfObjectSceneEvaluationPlan } from "./gltf-object-scene-evaluation-authority";
import {
  GLTF_OBJECT_SCENE_EVALUATION_CAPS,
  GLTF_OBJECT_SCENE_EVALUATION_PLAN_SCHEMA,
  GLTF_OBJECT_SCENE_EVALUATION_SCHEMA,
  type CompiledGltfObjectSceneEvaluationControl,
  type CompiledGltfObjectSceneEvaluationSegment,
  type GltfObjectSceneEvaluation,
  type GltfObjectSceneEvaluationControl,
  type GltfObjectSceneEvaluationPlan,
  type GltfObjectSceneTransformInterpolation,
} from "./gltf-object-scene-evaluation-types";
import { GLTF_OBJECT_SCENE_PLAN_SCHEMA, type GltfObjectScenePlan } from "./gltf-object-scene-types";
import type { GltfObjectPlan } from "./gltf-object-plan-types";
import type { CompiledGltfObjectStoryControl, CompiledGltfObjectStoryCheckpoint, GltfObjectStoryPlan } from "./gltf-object-story-types";

const TRANSFORM_INTERPOLATIONS = new Set<GltfObjectSceneTransformInterpolation>(["linear", "ease-in", "ease-out", "ease-in-out", "hold"]);

/** Compiles complete per-segment directed evaluation policies and mints exact-time authority. */
export function compileGltfObjectSceneEvaluationPlan(
  objectPlan: GltfObjectPlan,
  storyPlan: GltfObjectStoryPlan,
  scenePlan: GltfObjectScenePlan,
  value: unknown,
): GltfObjectSceneEvaluationPlan {
  assertGltfObjectPlanForScene(objectPlan);
  assertGltfObjectStoryPlanForScene(storyPlan, objectPlan);
  assertScenePlan(scenePlan, objectPlan, storyPlan);
  const evaluation = readEvaluation(value, scenePlan, storyPlan);
  const segments = freeze(evaluation.segments.map((segment, index) => compileSegment(segment, storyPlan.controls, storyPlan.checkpoints[index]!, storyPlan.checkpoints[index + 1]!)));
  const controlPolicyCount = segments.length * storyPlan.controls.length;
  if (controlPolicyCount > GLTF_OBJECT_SCENE_EVALUATION_CAPS.controlPolicies) throw new Error(`Imported-object scene evaluation exceeds the ${GLTF_OBJECT_SCENE_EVALUATION_CAPS.controlPolicies}-control-policy cap.`);
  const baseBudget = {
    segmentCount: segments.length,
    transformPolicyCount: segments.reduce((sum, segment) => sum + segment.controls.filter((control) => control.kind === "transform").length, 0),
    materialPolicyCount: segments.reduce((sum, segment) => sum + segment.controls.filter((control) => control.kind === "material").length, 0),
    controlPolicyCount,
    caps: GLTF_OBJECT_SCENE_EVALUATION_CAPS,
  };
  const base = {
    schema: GLTF_OBJECT_SCENE_EVALUATION_PLAN_SCHEMA,
    evaluation,
    evaluationSha256: canonicalJsonSha256(evaluation),
    objectFingerprint: objectPlan.fingerprint,
    storyFingerprint: storyPlan.fingerprint,
    sceneFingerprint: scenePlan.fingerprint,
    segments,
    evidence: freeze({
      completeOrderedSegmentPolicies: true as const,
      exactCheckpointIdentityPreserved: true as const,
      explicitTransformInterpolation: true as const,
      explicitMaterialSwitchTimes: true as const,
      degreeSpaceRotationPreserved: true as const,
      hierarchyBoundsAndCameraReevaluated: true as const,
      compilerMintedRuntimeAuthority: true as const,
      scriptsAccepted: false as const,
      physicsFieldsAccepted: false as const,
      rendererInvoked: false as const,
      packageRead: false as const,
      packageWritten: false as const,
    }),
  };
  let planBytes = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const next = Buffer.byteLength(canonicalJson({ ...base, budget: { ...baseBudget, planBytes } }), "utf8");
    if (next === planBytes) break;
    planBytes = next;
  }
  if (planBytes > GLTF_OBJECT_SCENE_EVALUATION_CAPS.planBytes) throw new Error(`Imported-object scene evaluation plan exceeds the ${GLTF_OBJECT_SCENE_EVALUATION_CAPS.planBytes}-byte cap.`);
  const payload = { ...base, budget: freeze({ ...baseBudget, planBytes }) };
  const plan = freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
  mintGltfObjectSceneEvaluationPlan(plan, objectPlan, storyPlan, scenePlan);
  return plan;
}

function assertScenePlan(plan: GltfObjectScenePlan, objectPlan: GltfObjectPlan, storyPlan: GltfObjectStoryPlan): void {
  if (!plan || typeof plan !== "object" || plan.schema !== GLTF_OBJECT_SCENE_PLAN_SCHEMA || !Object.isFrozen(plan)) throw new Error("Imported-object scene evaluation requires an immutable compiled scene plan.");
  const { fingerprint, ...payload } = plan;
  if (!/^[a-f0-9]{64}$/.test(fingerprint) || canonicalJsonSha256(payload) !== fingerprint) throw new Error("Compiled imported-object scene plan fingerprint does not match its contents.");
  if (plan.objectFingerprint !== objectPlan.fingerprint || plan.storyFingerprint !== storyPlan.fingerprint) throw new Error("Compiled imported-object scene plan is bound to different object or story plans.");
  if (plan.checkpoints.length !== storyPlan.checkpoints.length || plan.checkpoints.some((checkpoint, index) => checkpoint.id !== storyPlan.checkpoints[index]!.id || checkpoint.atUs !== storyPlan.checkpoints[index]!.atUs)) throw new Error("Compiled imported-object scene checkpoints do not match the story plan.");
}

function readEvaluation(value: unknown, scenePlan: GltfObjectScenePlan, storyPlan: GltfObjectStoryPlan): GltfObjectSceneEvaluation {
  const root = exactRecord(snapshotSceneRecipeData(value), ["schema", "sceneFingerprint", "segments"], [], "glTF object scene evaluation");
  if (root.schema !== GLTF_OBJECT_SCENE_EVALUATION_SCHEMA) throw new Error(`glTF object scene evaluation.schema must equal ${GLTF_OBJECT_SCENE_EVALUATION_SCHEMA}.`);
  if (root.sceneFingerprint !== scenePlan.fingerprint) throw new Error("glTF object scene evaluation.sceneFingerprint does not match the assembled scene plan.");
  const expected = storyPlan.checkpoints.length - 1;
  const segments = exactArray(root.segments, "glTF object scene evaluation.segments", expected, expected).map((entry, index) => readSegment(entry, index, storyPlan.controls, storyPlan.checkpoints[index]!, storyPlan.checkpoints[index + 1]!));
  uniqueIds(segments.map((segment) => segment.id), "glTF object scene evaluation segment ids");
  return freeze({ schema: GLTF_OBJECT_SCENE_EVALUATION_SCHEMA, sceneFingerprint: scenePlan.fingerprint, segments });
}

function readSegment(value: unknown, index: number, controls: readonly CompiledGltfObjectStoryControl[], from: CompiledGltfObjectStoryCheckpoint, to: CompiledGltfObjectStoryCheckpoint) {
  const label = `glTF object scene evaluation.segments[${index}]`, record = exactRecord(value, ["id", "fromCheckpointId", "toCheckpointId", "controls"], [], label);
  if (record.fromCheckpointId !== from.id || record.toCheckpointId !== to.id) throw new Error(`${label} must bind the exact consecutive story checkpoints.`);
  const policies = exactArray(record.controls, `${label}.controls`, controls.length, controls.length).map((entry, controlIndex) => readControl(entry, `${label}.controls[${controlIndex}]`, controls[controlIndex]!, from.atUs, to.atUs));
  return freeze({ id: safeId(record.id, `${label}.id`), fromCheckpointId: from.id, toCheckpointId: to.id, controls: policies });
}

function readControl(value: unknown, label: string, control: CompiledGltfObjectStoryControl, startUs: number, endUs: number): GltfObjectSceneEvaluationControl {
  if (control.kind === "transform") {
    const record = exactRecord(value, ["controlId", "kind", "interpolation"], [], label);
    if (record.controlId !== control.id || record.kind !== "transform") throw new Error(`${label} must match the story control order and kind exactly.`);
    if (typeof record.interpolation !== "string" || !TRANSFORM_INTERPOLATIONS.has(record.interpolation as GltfObjectSceneTransformInterpolation)) throw new Error(`${label}.interpolation is not supported.`);
    return freeze({ controlId: control.id, kind: "transform", interpolation: record.interpolation as GltfObjectSceneTransformInterpolation });
  }
  const record = exactRecord(value, ["controlId", "kind", "switchAtUs"], [], label);
  if (record.controlId !== control.id || record.kind !== "material") throw new Error(`${label} must match the story control order and kind exactly.`);
  const switchAtUs = safeUs(record.switchAtUs, `${label}.switchAtUs`);
  if (switchAtUs <= startUs || switchAtUs > endUs) throw new Error(`${label}.switchAtUs must be greater than the segment start and no later than its end.`);
  return freeze({ controlId: control.id, kind: "material", switchAtUs });
}

function compileSegment(segment: GltfObjectSceneEvaluation["segments"][number], controls: readonly CompiledGltfObjectStoryControl[], from: CompiledGltfObjectStoryCheckpoint, to: CompiledGltfObjectStoryCheckpoint): CompiledGltfObjectSceneEvaluationSegment {
  const compiledControls = freeze(segment.controls.map((policy, index) => freeze({ ...policy, nodeId: controls[index]!.nodeId, primitiveRef: controls[index]!.kind === "material" ? controls[index]!.primitiveRef : null })) as CompiledGltfObjectSceneEvaluationControl[]);
  const payload = { id: segment.id, fromCheckpointId: from.id, toCheckpointId: to.id, startUs: from.atUs, endUs: to.atUs, controls: compiledControls };
  return freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}
