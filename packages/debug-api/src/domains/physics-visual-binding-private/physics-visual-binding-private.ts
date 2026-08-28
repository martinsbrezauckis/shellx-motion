/** Private C7B4A strict-artifact visual binding and rational-frame evaluator. */
import { canonicalJson, canonicalJsonSha256 } from "@shellx-motion/core";
import {
  readPhysicsBakeAdmissionPlan,
  readSceneRecipeResources,
  snapshotSceneRecipeData,
  type PhysicsBakeAdmissionPlan,
} from "@shellx-motion/core/internal/scene-recipe";
import { reopenPhysicsBakeDurableArtifact } from "../physics-bake-durable-private/physics-bake-durable-private.js";
import type { PhysicsBakeRapierBodyState, PhysicsBakeRapierBodyStateObservation } from "../physics-bake-rapier-private/physics-bake-rapier-types-private.js";
import { mintPhysicsVisualBindingPlan, requirePhysicsVisualBindingPlan } from "./physics-visual-binding-authority-private.js";
import {
  PHYSICS_VISUAL_BINDING_CAPS,
  PHYSICS_VISUAL_BINDING_FRAME_SCHEMA,
  PHYSICS_VISUAL_BINDING_PLAN_SCHEMA,
  PHYSICS_VISUAL_BINDING_SCHEMA,
  type PhysicsVisualBinding,
  type PhysicsVisualBindingArtifactHost,
  type PhysicsVisualBindingFrame,
  type PhysicsVisualBindingPlan,
  type PhysicsVisualBindingRecipe,
  type PhysicsVisualFrameBinding,
} from "./physics-visual-binding-types-private.js";

/** Reopens C7B3 itself and binds every dynamic body to the existing C7A visual resource grammar. */
export async function compilePhysicsVisualBindingPlan(planValue: unknown, artifactHost: PhysicsVisualBindingArtifactHost, recipeValue: unknown): Promise<PhysicsVisualBindingPlan> {
  const physics = readPhysicsBakeAdmissionPlan(planValue), artifact = await reopenPhysicsBakeDurableArtifact(artifactHost);
  if (artifact.manifest.source.planFingerprint !== physics.fingerprint || artifact.manifest.source.recipeSha256 !== physics.recipeSha256) throw new Error("C7B4A physics plan does not match the strictly reopened C7B3 artifact.");
  const dynamicIds = physics.recipe.bodies.filter((body) => body.kind === "dynamic").map((body) => body.id);
  const recipe = readRecipe(recipeValue, physics, dynamicIds), descriptor = artifact.manifest.bodyObservations.find((entry) => entry.id === artifact.manifest.primaryBodyObservationId), observation = artifact.bodyStateObservations.find((entry) => entry.id === artifact.manifest.primaryBodyObservationId);
  if (!descriptor || !observation || !same(descriptor.bodyIds, dynamicIds) || !same(observation.samples[0]?.states.map((state) => state.bodyId) ?? [], dynamicIds) || canonicalJsonSha256(observation) !== descriptor.sourceSha256) throw new Error("C7B4A primary C7B3 body observation does not cover the exact dynamic-body order.");
  const durationUs = physics.schedule.endUs - physics.schedule.startUs, frameNumerator = durationUs * recipe.frameRate;
  if (!Number.isSafeInteger(frameNumerator) || frameNumerator % 1_000_000 !== 0) throw new Error("C7B4A physics duration must contain a whole number of requested render frames.");
  const renderFrameCount = frameNumerator / 1_000_000;
  if (renderFrameCount < 1 || renderFrameCount > PHYSICS_VISUAL_BINDING_CAPS.renderFrames) throw new Error(`C7B4A exceeds the ${PHYSICS_VISUAL_BINDING_CAPS.renderFrames}-render-frame cap.`);
  const source = frozen({ physicsPlanFingerprint: physics.fingerprint, physicsRecipeSha256: physics.recipeSha256, durableManifestFingerprint: artifact.manifest.fingerprint, durableReceiptFingerprint: artifact.receipt.fingerprint, providerResultFingerprint: artifact.manifest.source.resultFingerprint, bodyObservationId: observation.id, bodyObservationSha256: descriptor.sourceSha256 });
  const schedule = frozen({ startUs: physics.schedule.startUs, endUs: physics.schedule.endUs, stepsPerSecond: physics.schedule.stepsPerSecond, stepCount: physics.schedule.stepCount, sampleEverySteps: observation.sampleEverySteps, frameRate: recipe.frameRate, renderFrameCount, terminalFrameIndex: renderFrameCount });
  const baseBudget = { geometryResourceCount: recipe.resources.geometry.length, materialResourceCount: recipe.resources.materials.length, bindingCount: recipe.bindings.length, renderFrameCount, evaluationFrameCount: renderFrameCount + 1, caps: PHYSICS_VISUAL_BINDING_CAPS };
  const base = {
    schema: PHYSICS_VISUAL_BINDING_PLAN_SCHEMA,
    recipe,
    recipeSha256: canonicalJsonSha256(recipe),
    source,
    resourceFingerprint: canonicalJsonSha256(recipe.resources),
    bindings: recipe.bindings,
    schedule,
    evidence: frozen({ strictArtifactReopen: true as const, allDynamicBodiesBound: true as const, sharedC7aVisualResourceGrammar: true as const, visualCollisionGeometryIndependent: true as const, visualPhysicsMaterialsIndependent: true as const, rationalFrameSchedule: true as const, positionInterpolation: "linear" as const, rotationInterpolation: "slerp-shortest" as const, packageRead: false as const, packageWritten: false as const, rendererInvoked: false as const, pixels: false as const }),
  };
  let planBytes = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) { const next = Buffer.byteLength(canonicalJson({ ...base, budget: { ...baseBudget, planBytes } }), "utf8"); if (next === planBytes) break; planBytes = next; }
  if (planBytes > PHYSICS_VISUAL_BINDING_CAPS.planBytes) throw new Error(`C7B4A exceeds the ${PHYSICS_VISUAL_BINDING_CAPS.planBytes}-byte plan cap.`);
  const payload = { ...base, budget: frozen({ ...baseBudget, planBytes }) }, plan = frozen({ ...payload, fingerprint: canonicalJsonSha256(payload) }) as PhysicsVisualBindingPlan;
  mintPhysicsVisualBindingPlan(plan, { observation });
  return plan;
}

/** Evaluates a render frame or the exact terminal review boundary from compiler-minted authority. */
export function evaluatePhysicsVisualBindingFrame(planValue: unknown, frameIndexValue: unknown): PhysicsVisualBindingFrame {
  const { plan, authority } = requirePhysicsVisualBindingPlan(planValue), frameIndex = integer(frameIndexValue, "C7B4A frame index", 0, plan.schedule.terminalFrameIndex);
  const stepNumerator = frameIndex * plan.schedule.stepsPerSecond, denominator = plan.schedule.frameRate, range = sampleRange(authority.observation, stepNumerator, denominator);
  const bindings = frozen(plan.bindings.map((binding, index) => frameBinding(binding, range.left.states[index]!, range.right.states[index]!, range.progressNumerator, range.progressDenominator)));
  const base = {
    schema: PHYSICS_VISUAL_BINDING_FRAME_SCHEMA,
    planFingerprint: plan.fingerprint,
    durableManifestFingerprint: plan.source.durableManifestFingerprint,
    frameIndex,
    terminal: frameIndex === plan.schedule.terminalFrameIndex,
    time: frozen({ startUs: plan.schedule.startUs, offsetNumeratorUs: frameIndex * 1_000_000, denominator }),
    physicsStep: frozen({ numerator: stepNumerator, denominator }),
    sampleRange: frozen({ leftStep: range.left.step, rightStep: range.right.step, progressNumerator: range.progressNumerator, progressDenominator: range.progressDenominator }),
    bindings,
    evidence: frozen({ rendererInvoked: false as const, pixels: false as const }),
  };
  const frame = frozen({ ...base, fingerprint: canonicalJsonSha256(base) }) as PhysicsVisualBindingFrame;
  if (Buffer.byteLength(canonicalJson(frame), "utf8") > PHYSICS_VISUAL_BINDING_CAPS.frameBytes) throw new Error(`C7B4A exceeds the ${PHYSICS_VISUAL_BINDING_CAPS.frameBytes}-byte frame cap.`);
  return frame;
}

function readRecipe(value: unknown, physics: PhysicsBakeAdmissionPlan, dynamicIds: readonly string[]): PhysicsVisualBindingRecipe {
  const root = exact(snapshotSceneRecipeData(value), ["schema", "physicsPlanFingerprint", "frameRate", "interpolation", "resources", "bindings"], "C7B4A recipe");
  if (root.schema !== PHYSICS_VISUAL_BINDING_SCHEMA || root.physicsPlanFingerprint !== physics.fingerprint) throw new Error("C7B4A recipe schema or physics-plan identity is invalid.");
  const interpolation = exact(root.interpolation, ["position", "rotation"], "C7B4A interpolation");
  if (interpolation.position !== "linear" || interpolation.rotation !== "slerp-shortest") throw new Error("C7B4A interpolation must equal linear/slerp-shortest.");
  const resources = readSceneRecipeResources(root.resources), geometryIds = new Set(resources.geometry.map((entry) => entry.id)), materialIds = new Set(resources.materials.map((entry) => entry.id));
  if (!Array.isArray(root.bindings) || root.bindings.length !== dynamicIds.length || root.bindings.length > PHYSICS_VISUAL_BINDING_CAPS.bindings) throw new Error("C7B4A bindings must cover every dynamic body exactly once.");
  const bindings = frozen(root.bindings.map((value, index) => {
    const entry = exact(value, ["bodyId", "geometryRef", "materialRef"], `C7B4A binding ${index}`), bodyId = id(entry.bodyId, `C7B4A binding ${index}.bodyId`), geometryRef = id(entry.geometryRef, `C7B4A binding ${index}.geometryRef`), materialRef = id(entry.materialRef, `C7B4A binding ${index}.materialRef`);
    if (bodyId !== dynamicIds[index] || !geometryIds.has(geometryRef) || !materialIds.has(materialRef)) throw new Error("C7B4A bindings must follow dynamic-body order and reference declared visual resources.");
    return frozen({ bodyId, geometryRef, materialRef });
  }));
  return frozen({ schema: PHYSICS_VISUAL_BINDING_SCHEMA, physicsPlanFingerprint: physics.fingerprint, frameRate: integer(root.frameRate, "C7B4A frameRate", 1, 120), interpolation: frozen({ position: "linear" as const, rotation: "slerp-shortest" as const }), resources, bindings });
}

function sampleRange(observation: PhysicsBakeRapierBodyStateObservation, numerator: number, denominator: number): { left: PhysicsBakeRapierBodyStateObservation["samples"][number]; right: PhysicsBakeRapierBodyStateObservation["samples"][number]; progressNumerator: number; progressDenominator: number } {
  let low = 0, high = observation.samples.length - 1;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (observation.samples[mid]!.step * denominator <= numerator) low = mid; else high = mid - 1; }
  const left = observation.samples[low]!;
  if (left.step * denominator === numerator) return { left, right: left, progressNumerator: 0, progressDenominator: 1 };
  const right = observation.samples[low + 1];
  if (!right || numerator > right.step * denominator) throw new Error("C7B4A frame is outside the preserved body observation range.");
  return { left, right, progressNumerator: numerator - left.step * denominator, progressDenominator: (right.step - left.step) * denominator };
}

function frameBinding(binding: PhysicsVisualBinding, left: PhysicsBakeRapierBodyState, right: PhysicsBakeRapierBodyState, numerator: number, denominator: number): PhysicsVisualFrameBinding {
  if (left.bodyId !== binding.bodyId || right.bodyId !== binding.bodyId) throw new Error("C7B4A body state order changed during evaluation.");
  const position = numerator === 0 ? left.position : tuple3(left.position, right.position, numerator / denominator), rotation = numerator === 0 ? left.rotation : slerpShortest(left.rotation, right.rotation, numerator / denominator);
  return frozen({ ...binding, position, rotation });
}

export function slerpShortest(left: readonly [number, number, number, number], rightValue: readonly [number, number, number, number], progress: number): readonly [number, number, number, number] {
  let right = rightValue, dot = left.reduce((sum, entry, index) => sum + entry * right[index]!, 0);
  if (dot < 0) { right = frozen(right.map((entry) => f32(-entry)) as unknown as [number, number, number, number]); dot = -dot; }
  if (dot > 0.9995) return normalizedQuaternion(left.map((entry, index) => entry + (right[index]! - entry) * progress));
  const theta = Math.acos(Math.min(1, Math.max(-1, dot))), sinTheta = Math.sin(theta), leftWeight = Math.sin((1 - progress) * theta) / sinTheta, rightWeight = Math.sin(progress * theta) / sinTheta;
  return normalizedQuaternion(left.map((entry, index) => entry * leftWeight + right[index]! * rightWeight));
}

function normalizedQuaternion(values: readonly number[]): readonly [number, number, number, number] { const length = Math.hypot(...values); if (!Number.isFinite(length) || length < 1e-12) throw new Error("C7B4A cannot normalize an invalid quaternion."); return frozen(values.map((entry) => f32(entry / length)) as unknown as [number, number, number, number]); }
function tuple3(left: readonly number[], right: readonly number[], progress: number): readonly [number, number, number] { return frozen(left.map((entry, index) => f32(entry + (right[index]! - entry) * progress)) as unknown as [number, number, number]); }
function f32(value: number): number { const result = Math.fround(value); if (!Number.isFinite(result)) throw new Error("C7B4A produced a non-finite transform."); return Object.is(result, -0) ? 0 : result; }
function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object.`); const root = value as Record<string, unknown>, actual = Reflect.ownKeys(root); if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key)) || keys.some((key) => !Object.hasOwn(root, key))) throw new Error(`${label} has missing or unknown fields.`); return root; }
function id(value: unknown, label: string): string { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) throw new Error(`${label} is invalid.`); return value; }
function integer(value: unknown, label: string, minimum: number, maximum: number): number { if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${label} must be a safe integer in ${minimum}..${maximum}.`); return value as number; }
function same(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((entry, index) => entry === right[index]); }
function frozen<T extends object>(value: T): Readonly<T> { return Object.freeze(value); }
