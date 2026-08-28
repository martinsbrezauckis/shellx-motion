import type { PhysicsBakeAdmissionPlan } from "@shellx-motion/core/internal/scene-recipe";
import type { PhysicsVisualRetainedStaticPlan } from "../physics-visual-retained-private/physics-visual-retained-types-private.js";
import type { PhysicsVisualPresentationFramePlan, PhysicsVisualPresentationStaticPlan } from "./physics-visual-presentation-types-private.js";

interface StaticAuthority {
  readonly retained: PhysicsVisualRetainedStaticPlan;
  readonly physics: PhysicsBakeAdmissionPlan;
}

const staticAuthorities = new WeakMap<PhysicsVisualPresentationStaticPlan, StaticAuthority>();
const frameAuthorities = new WeakMap<PhysicsVisualPresentationFramePlan, PhysicsVisualPresentationStaticPlan>();

export function mintPhysicsVisualPresentationStaticPlan(plan: PhysicsVisualPresentationStaticPlan, retained: PhysicsVisualRetainedStaticPlan, physics: PhysicsBakeAdmissionPlan): void {
  staticAuthorities.set(plan, Object.freeze({ retained, physics }));
}

export function mintPhysicsVisualPresentationFramePlan(plan: PhysicsVisualPresentationFramePlan, owner: PhysicsVisualPresentationStaticPlan): void {
  frameAuthorities.set(plan, owner);
}

export function requirePhysicsVisualPresentationStaticPlan(value: unknown): Readonly<{ plan: PhysicsVisualPresentationStaticPlan; retained: PhysicsVisualRetainedStaticPlan; physics: PhysicsBakeAdmissionPlan }> {
  if (!value || typeof value !== "object") throw new Error("C7B4C requires a compiler-minted presentation static plan.");
  const plan = value as PhysicsVisualPresentationStaticPlan, authority = staticAuthorities.get(plan);
  if (!authority) throw new Error("C7B4C requires a compiler-minted presentation static plan.");
  return Object.freeze({ plan, ...authority });
}

export function requirePhysicsVisualPresentationFramePlan(value: unknown, owner: PhysicsVisualPresentationStaticPlan): PhysicsVisualPresentationFramePlan {
  if (!value || typeof value !== "object" || frameAuthorities.get(value as PhysicsVisualPresentationFramePlan) !== owner) throw new Error("C7B4C requires a compiler-minted presentation frame owned by this static plan.");
  return value as PhysicsVisualPresentationFramePlan;
}
