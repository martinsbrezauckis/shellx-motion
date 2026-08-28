import type { GltfObjectSceneEvaluationPlan } from "./gltf-object-scene-evaluation-types";
import type { GltfObjectPlan } from "./gltf-object-plan-types";
import type { GltfObjectRetainedRenderFramePlan, GltfObjectRetainedRenderStaticPlan } from "./gltf-object-retained-render-types";
import type { GltfObjectScenePlan } from "./gltf-object-scene-types";
import type { GltfObjectStoryPlan } from "./gltf-object-story-types";

export interface GltfObjectRetainedRenderAuthority {
  readonly fingerprint: string;
  readonly evaluationPlan: GltfObjectSceneEvaluationPlan;
  readonly objectPlan: GltfObjectPlan;
  readonly storyPlan: GltfObjectStoryPlan;
  readonly scenePlan: GltfObjectScenePlan;
}

const mintedPlans = new WeakMap<object, GltfObjectRetainedRenderAuthority>();
const mintedFrames = new WeakMap<object, Readonly<{ fingerprint: string; staticPlan: GltfObjectRetainedRenderStaticPlan }>>();

export function mintGltfObjectRetainedRenderStaticPlan(
  plan: GltfObjectRetainedRenderStaticPlan,
  authority: Omit<GltfObjectRetainedRenderAuthority, "fingerprint">,
): void {
  mintedPlans.set(plan, Object.freeze({ fingerprint: plan.fingerprint, ...authority }));
}

export function requireGltfObjectRetainedRenderStaticPlan(value: unknown): {
  plan: GltfObjectRetainedRenderStaticPlan;
  authority: GltfObjectRetainedRenderAuthority;
} {
  if (!value || typeof value !== "object") throw new Error("Imported-object retained rendering requires a compiler-minted static plan.");
  const authority = mintedPlans.get(value);
  if (!authority) throw new Error("Imported-object retained rendering requires a compiler-minted static plan.");
  const plan = value as GltfObjectRetainedRenderStaticPlan;
  if (!Object.isFrozen(plan) || plan.fingerprint !== authority.fingerprint) throw new Error("Imported-object retained rendering refused a stale static plan.");
  return { plan, authority };
}

export function mintGltfObjectRetainedRenderFramePlan(frame: GltfObjectRetainedRenderFramePlan, staticPlan: GltfObjectRetainedRenderStaticPlan): void {
  mintedFrames.set(frame, Object.freeze({ fingerprint: frame.fingerprint, staticPlan }));
}

export function requireGltfObjectRetainedRenderFramePlan(value: unknown, staticPlan: GltfObjectRetainedRenderStaticPlan): GltfObjectRetainedRenderFramePlan {
  if (!value || typeof value !== "object") throw new Error("Imported-object retained rendering requires a compiler-minted frame plan.");
  const authority = mintedFrames.get(value);
  if (!authority || authority.staticPlan !== staticPlan) throw new Error("Imported-object retained rendering requires a frame plan minted for its exact static plan.");
  const frame = value as GltfObjectRetainedRenderFramePlan;
  if (!Object.isFrozen(frame) || frame.fingerprint !== authority.fingerprint) throw new Error("Imported-object retained rendering refused a stale frame plan.");
  return frame;
}
