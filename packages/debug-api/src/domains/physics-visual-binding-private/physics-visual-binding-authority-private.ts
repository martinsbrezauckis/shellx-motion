import type { PhysicsBakeRapierBodyStateObservation } from "../physics-bake-rapier-private/physics-bake-rapier-types-private.js";
import type { PhysicsVisualBindingPlan } from "./physics-visual-binding-types-private.js";

interface PhysicsVisualBindingAuthority {
  readonly observation: PhysicsBakeRapierBodyStateObservation;
}

const authorities = new WeakMap<PhysicsVisualBindingPlan, PhysicsVisualBindingAuthority>();

export function mintPhysicsVisualBindingPlan(plan: PhysicsVisualBindingPlan, authority: PhysicsVisualBindingAuthority): void {
  authorities.set(plan, Object.freeze(authority));
}

export function requirePhysicsVisualBindingPlan(value: unknown): Readonly<{ plan: PhysicsVisualBindingPlan; authority: PhysicsVisualBindingAuthority }> {
  if (!value || typeof value !== "object") throw new Error("C7B4A requires a compiler-minted visual binding plan.");
  const plan = value as PhysicsVisualBindingPlan, authority = authorities.get(plan);
  if (!authority) throw new Error("C7B4A requires a compiler-minted visual binding plan.");
  return Object.freeze({ plan, authority });
}
