import type { MotionScene3DAnimationPlan, MotionScene3DAnimationSource } from "./motion-scene3d-animation-types";

interface CameraBase { layerId: string; position: readonly number[]; target: readonly number[] }
interface PlanAuthority { fingerprint: string; cameras: readonly CameraBase[] }

const compilerMintedPlans = new WeakMap<object, PlanAuthority>();

/** Keeps evaluator authority non-serializable and deliberately excludes scene geometry/asset payloads. */
export function mintMotionScene3DAnimationPlan(plan: MotionScene3DAnimationPlan, source: MotionScene3DAnimationSource): void {
  const cameras = source.layers.map((layer) => Object.freeze({ layerId: layer.id, position: Object.freeze([...layer.scene3d.camera.position]), target: Object.freeze([...layer.scene3d.camera.target]) }));
  compilerMintedPlans.set(plan, Object.freeze({ fingerprint: plan.fingerprint, cameras: Object.freeze(cameras) }));
}

/** Checks minting before reading any untrusted plan field or track array. */
export function requireMotionScene3DAnimationPlanAuthority(value: unknown): { plan: MotionScene3DAnimationPlan; authority: PlanAuthority } {
  if (typeof value !== "object" || value === null) throw new Error("Scene3d animation evaluation requires a compiler-minted immutable plan.");
  const authority = compilerMintedPlans.get(value);
  if (!authority) throw new Error("Scene3d animation evaluation requires a compiler-minted immutable plan.");
  const plan = value as MotionScene3DAnimationPlan;
  if (!Object.isFrozen(plan) || plan.fingerprint !== authority.fingerprint) throw new Error("Scene3d animation evaluation refused a stale compiler-minted plan.");
  return { plan, authority };
}
