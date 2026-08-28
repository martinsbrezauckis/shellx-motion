import type { PhysicsVisualBindingPlan } from "../physics-visual-binding-private/physics-visual-binding-types-private.js";
import type { PhysicsVisualRetainedFramePlan, PhysicsVisualRetainedStaticPlan } from "./physics-visual-retained-types-private.js";

const staticAuthorities = new WeakMap<PhysicsVisualRetainedStaticPlan, PhysicsVisualBindingPlan>();
const frameAuthorities = new WeakMap<PhysicsVisualRetainedFramePlan, PhysicsVisualRetainedStaticPlan>();

export function mintPhysicsVisualRetainedStaticPlan(plan: PhysicsVisualRetainedStaticPlan, visual: PhysicsVisualBindingPlan): void { staticAuthorities.set(plan, visual); }
export function mintPhysicsVisualRetainedFramePlan(plan: PhysicsVisualRetainedFramePlan, owner: PhysicsVisualRetainedStaticPlan): void { frameAuthorities.set(plan, owner); }

export function requirePhysicsVisualRetainedStaticPlan(value: unknown): Readonly<{ plan: PhysicsVisualRetainedStaticPlan; visual: PhysicsVisualBindingPlan }> {
  if (!value || typeof value !== "object") throw new Error("C7B4B requires a compiler-minted retained static plan.");
  const plan = value as PhysicsVisualRetainedStaticPlan, visual = staticAuthorities.get(plan);
  if (!visual) throw new Error("C7B4B requires a compiler-minted retained static plan.");
  return Object.freeze({ plan, visual });
}

export function requirePhysicsVisualRetainedFramePlan(value: unknown, owner: PhysicsVisualRetainedStaticPlan): PhysicsVisualRetainedFramePlan {
  if (!value || typeof value !== "object" || frameAuthorities.get(value as PhysicsVisualRetainedFramePlan) !== owner) throw new Error("C7B4B requires a compiler-minted retained frame plan owned by this static plan.");
  return value as PhysicsVisualRetainedFramePlan;
}
