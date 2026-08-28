import { canonicalJsonSha256 } from "../../canonical-json";
import { freeze, safeUs } from "./scene-recipe-data";
import { assembleGltfObjectSceneCheckpoint } from "./gltf-object-scene";
import { mintGltfObjectSceneFrame, requireGltfObjectSceneEvaluationPlan } from "./gltf-object-scene-evaluation-authority";
import {
  GLTF_OBJECT_SCENE_FRAME_SCHEMA,
  type CompiledGltfObjectSceneEvaluationControl,
  type GltfObjectSceneEvaluationPlan,
  type GltfObjectSceneFrame,
  type GltfObjectSceneFrameResult,
  type GltfObjectSceneTransformInterpolation,
} from "./gltf-object-scene-evaluation-types";
import type { CompiledGltfObjectStoryCheckpoint, CompiledGltfObjectStoryState } from "./gltf-object-story-types";

/** Evaluates one exact time from compiler-minted directed-scene authority. */
export function evaluateGltfObjectSceneAtUs(value: unknown, atUsValue: unknown): GltfObjectSceneFrameResult {
  try {
    const { plan, authority } = requireGltfObjectSceneEvaluationPlan(value);
    const atUs = safeUs(atUsValue, "Imported-object scene evaluation atUs");
    const checkpoints = authority.storyPlan.checkpoints;
    if (atUs < checkpoints[0]!.atUs || atUs > checkpoints.at(-1)!.atUs) throw new Error("Imported-object scene evaluation atUs is outside the story range.");
    const exactIndex = checkpoints.findIndex((checkpoint) => checkpoint.atUs === atUs);
    if (exactIndex >= 0) return freeze({ ok: true, frame: frame(plan, authority.scenePlan, atUs, checkpoints[exactIndex]!.id, null, null, authority.scenePlan.checkpoints[exactIndex]!) });
    const segmentIndex = plan.segments.findIndex((segment) => atUs > segment.startUs && atUs < segment.endUs);
    if (segmentIndex < 0) throw new Error("Imported-object scene evaluation found no segment for atUs.");
    const segment = plan.segments[segmentIndex]!, left = checkpoints[segmentIndex]!, right = checkpoints[segmentIndex + 1]!;
    const progress = sceneFloat((atUs - segment.startUs) / (segment.endUs - segment.startUs));
    const checkpoint = interpolatedCheckpoint(segment.id, atUs, progress, segment.controls, left, right);
    const scene = assembleGltfObjectSceneCheckpoint(authority.objectPlan, checkpoint, authority.scenePlan.assembly);
    return freeze({ ok: true, frame: frame(plan, authority.scenePlan, atUs, null, segment.id, progress, scene) });
  } catch (error) {
    return freeze({ ok: false, message: error instanceof Error ? error.message : "Imported-object scene evaluation refused." });
  }
}

function interpolatedCheckpoint(
  segmentId: string,
  atUs: number,
  progress: number,
  policies: readonly CompiledGltfObjectSceneEvaluationControl[],
  left: CompiledGltfObjectStoryCheckpoint,
  right: CompiledGltfObjectStoryCheckpoint,
): CompiledGltfObjectStoryCheckpoint {
  const states = freeze(policies.map((policy, index) => interpolateState(policy, atUs, progress, left.states[index]!, right.states[index]!)));
  return freeze({ id: `${segmentId}.frame.${atUs}`, atUs, states, stateSha256: canonicalJsonSha256(states) });
}

function interpolateState(
  policy: CompiledGltfObjectSceneEvaluationControl,
  atUs: number,
  progress: number,
  left: CompiledGltfObjectStoryState,
  right: CompiledGltfObjectStoryState,
): CompiledGltfObjectStoryState {
  if (policy.kind === "material") {
    const source = atUs < policy.switchAtUs ? left : right;
    return freeze({ ...source, value: freeze({ ...(source.value as { materialRef: string }) }) });
  }
  const first = left.value as TransformValue, second = right.value as TransformValue;
  const eased = easing(policy.interpolation, progress);
  const tuple = (leftValues: readonly number[], rightValues: readonly number[]) => freeze(leftValues.map((entry, index) => sceneFloat(entry + (rightValues[index]! - entry) * eased))) as unknown as readonly [number, number, number];
  return freeze({
    controlId: left.controlId,
    nodeId: left.nodeId,
    primitiveRef: null,
    value: freeze({
      translation: tuple(first.translation, second.translation),
      rotationDeg: tuple(first.rotationDeg, second.rotationDeg),
      scale: sceneFloat(first.scale + (second.scale - first.scale) * eased),
    }),
  });
}

function easing(kind: GltfObjectSceneTransformInterpolation, progress: number): number {
  if (kind === "hold") return 0;
  if (kind === "linear") return progress;
  if (kind === "ease-in") return sceneFloat(progress * progress);
  if (kind === "ease-out") return sceneFloat(1 - (1 - progress) * (1 - progress));
  return progress < 0.5 ? sceneFloat(2 * progress * progress) : sceneFloat(1 - 2 * (1 - progress) * (1 - progress));
}

function frame(evaluationPlan: GltfObjectSceneEvaluationPlan, scenePlan: import("./gltf-object-scene-types").GltfObjectScenePlan, atUs: number, checkpointId: string | null, segmentId: string | null, segmentProgress: number | null, scene: GltfObjectSceneFrame["scene"]): GltfObjectSceneFrame {
  const payload = { schema: GLTF_OBJECT_SCENE_FRAME_SCHEMA, evaluationFingerprint: evaluationPlan.fingerprint, sceneFingerprint: scenePlan.fingerprint, atUs, checkpointId, segmentId, segmentProgress, scene };
  const result = freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
  mintGltfObjectSceneFrame(result, evaluationPlan, scenePlan);
  return result;
}

interface TransformValue {
  readonly translation: readonly [number, number, number];
  readonly rotationDeg: readonly [number, number, number];
  readonly scale: number;
}

function sceneFloat(value: number): number { const normalized = Math.abs(value) < 1e-7 ? 0 : Math.fround(value); return Object.is(normalized, -0) ? 0 : normalized; }
