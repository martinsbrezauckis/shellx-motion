import type { GltfObjectPlan } from "./gltf-object-plan-types";
import type { GltfObjectSceneEvaluationPlan, GltfObjectSceneFrame } from "./gltf-object-scene-evaluation-types";
import type { GltfObjectScenePlan } from "./gltf-object-scene-types";
import type { GltfObjectStoryPlan } from "./gltf-object-story-types";

interface GltfObjectSceneEvaluationAuthority {
  readonly fingerprint: string;
  readonly objectPlan: GltfObjectPlan;
  readonly storyPlan: GltfObjectStoryPlan;
  readonly scenePlan: GltfObjectScenePlan;
}

const mintedPlans = new WeakMap<object, GltfObjectSceneEvaluationAuthority>();
const mintedFrames = new WeakMap<object, Readonly<{ evaluationPlan: GltfObjectSceneEvaluationPlan; scenePlan: GltfObjectScenePlan }>>();

export function mintGltfObjectSceneEvaluationPlan(
  plan: GltfObjectSceneEvaluationPlan,
  objectPlan: GltfObjectPlan,
  storyPlan: GltfObjectStoryPlan,
  scenePlan: GltfObjectScenePlan,
): void {
  mintedPlans.set(plan, Object.freeze({ fingerprint: plan.fingerprint, objectPlan, storyPlan, scenePlan }));
}

export function requireGltfObjectSceneEvaluationPlan(value: unknown): {
  plan: GltfObjectSceneEvaluationPlan;
  authority: GltfObjectSceneEvaluationAuthority;
} {
  if (!value || typeof value !== "object") throw new Error("Imported-object scene evaluation requires a compiler-minted immutable plan.");
  const authority = mintedPlans.get(value);
  if (!authority) throw new Error("Imported-object scene evaluation requires a compiler-minted immutable plan.");
  const plan = value as GltfObjectSceneEvaluationPlan;
  if (!Object.isFrozen(plan) || plan.fingerprint !== authority.fingerprint) throw new Error("Imported-object scene evaluation refused a stale compiler-minted plan.");
  return { plan, authority };
}

export function mintGltfObjectSceneFrame(frame: GltfObjectSceneFrame, evaluationPlan: GltfObjectSceneEvaluationPlan, scenePlan: GltfObjectScenePlan): void {
  mintedFrames.set(frame, Object.freeze({ evaluationPlan, scenePlan }));
}

export function requireGltfObjectSceneFrame(value: unknown, evaluationPlan: GltfObjectSceneEvaluationPlan, scenePlan: GltfObjectScenePlan): GltfObjectSceneFrame {
  if (!value || typeof value !== "object") throw new Error("Imported-object retained rendering requires an evaluator-minted scene frame.");
  const authority = mintedFrames.get(value);
  if (!authority || authority.evaluationPlan !== evaluationPlan || authority.scenePlan !== scenePlan) throw new Error("Imported-object retained rendering requires a frame minted by its exact evaluator and scene plans.");
  return value as GltfObjectSceneFrame;
}
