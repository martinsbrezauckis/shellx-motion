import { canonicalJson, canonicalJsonSha256, compareCodeUnits } from "./canonical-json";
import { evaluateMotionPathFollow } from "./motion-path-follow";
import { evaluateMotionTransformBehavior } from "./motion-transform-behavior";
import { MAX_MOTION_BEHAVIOR_FRAME_WORK_UNITS, type MotionBehavior, type MotionBehaviorStore } from "./motion-behavior-types";
import { readMotionBehaviorStore } from "./motion-behavior-read";
import type { MotionLayer } from "./types";

export interface MotionBehaviorIssue { path: string; message: string }
export interface MotionBehaviorBaseTransform { x: number; y: number; rotation: number; scale: number; width?: number; height?: number }
export interface ResolvedMotionBehaviorBinding {
  binding: MotionBehavior;
  base: MotionBehaviorBaseTransform;
  sourceSha256: string;
  workUnits: number;
}
export interface MotionBehaviorBudget { inputBytes: number; bindingCount: number; enabledBindingCount: number; frameWorkUnits: number; limits: { maxBindings: 32; maxFrameWorkUnits: typeof MAX_MOTION_BEHAVIOR_FRAME_WORK_UNITS } }
export type MotionBehaviorValidationResult = { ok: true; store: MotionBehaviorStore | undefined; bindings: readonly ResolvedMotionBehaviorBinding[]; budget: MotionBehaviorBudget } | { ok: false; issues: MotionBehaviorIssue[] };

/** Validates the exact behavior store against document ownership and every competing transform authority. */
export function validateMotionBehaviors(value: unknown, context: { durationMs: unknown; layers: readonly unknown[]; relationships?: unknown }): MotionBehaviorValidationResult {
  if (value === undefined) return { ok: true, store: undefined, bindings: [], budget: emptyBudget() };
  let store: MotionBehaviorStore;
  try { store = readMotionBehaviorStore(value); }
  catch (error) { return fail("/behaviors", error instanceof Error ? error.message : "must be a valid behavior store"); }
  if (typeof context.durationMs !== "number") return fail("/behaviors", "requires a numeric document durationMs");
  const documentUs = context.durationMs * 1_000;
  if (!Number.isSafeInteger(documentUs) || documentUs <= 0) return fail("/behaviors", "requires an exactly representable positive document duration in microseconds");
  const issues: MotionBehaviorIssue[] = [];
  const layers: readonly MotionLayer[] = Array.from(context.layers).filter(isMotionLayer);
  const layerById = new Map(layers.map((layer) => [layer.id, layer]));
  const groupChildren = new Set(layers.filter((layer) => layer.type === "group").flatMap((layer) => layer.childLayerIds ?? []));
  const resolved: ResolvedMotionBehaviorBinding[] = [];
  let previousTarget: string | undefined, frameWorkUnits = 0;
  store.bindings.forEach((binding, index) => {
    const path = `/behaviors/bindings/${index}`;
    if (previousTarget !== undefined && compareCodeUnits(previousTarget, binding.targetLayerId) >= 0) issues.push({ path: `${path}/targetLayerId`, message: "must be strict UTF-16/code-unit ascending unique targetLayerId order" });
    previousTarget = binding.targetLayerId;
    if (binding.startUs + binding.durationUs > documentUs) issues.push({ path, message: "startUs plus durationUs must fit the document duration exactly in microseconds" });
    const layer = layerById.get(binding.targetLayerId);
    if (!layer) { issues.push({ path: `${path}/targetLayerId`, message: "must reference an existing root-owned shape layer" }); return; }
    if (layer.type !== "shape") { issues.push({ path: `${path}/targetLayerId`, message: "must reference a shape layer; text, caption, group, and scene3d targets are refused" }); return; }
    if (groupChildren.has(layer.id)) { issues.push({ path: `${path}/targetLayerId`, message: "must reference a root-owned shape layer, not a group child" }); return; }
    if (hasTransformKeyframes(layer)) issues.push({ path, message: "refuses a target with ordinary or spatial transform keyframes" });
    if (hasProceduralTransformRelation(context.relationships, layer.id)) issues.push({ path, message: "refuses a target with a procedural transform relation" });
    const base = baseTransform(layer);
    const checked = checkBinding(binding, base);
    if (!checked.ok) { issues.push({ path, message: checked.message }); return; }
    frameWorkUnits += checked.workUnits;
    resolved.push({ binding, base, sourceSha256: canonicalJsonSha256({ binding, base }), workUnits: checked.workUnits });
  });
  if (frameWorkUnits > MAX_MOTION_BEHAVIOR_FRAME_WORK_UNITS) issues.push({ path: "/behaviors", message: `exceeds the ${MAX_MOTION_BEHAVIOR_FRAME_WORK_UNITS}-unit frame behavior work limit` });
  if (issues.length) return { ok: false, issues };
  const inputBytes = Buffer.byteLength(canonicalJson(store), "utf8");
  return { ok: true, store, bindings: resolved, budget: { inputBytes, bindingCount: store.bindings.length, enabledBindingCount: store.bindings.filter((binding) => binding.enabled).length, frameWorkUnits, limits: { maxBindings: 32, maxFrameWorkUnits: MAX_MOTION_BEHAVIOR_FRAME_WORK_UNITS } } };
}

/** Computes the static evaluator base from exactly the target's authored transform. */
export function baseTransform(layer: MotionLayer): MotionBehaviorBaseTransform {
  const transform = layer.transform as Record<string, unknown> | undefined;
  const value = (name: "x" | "y" | "rotation" | "scale", fallback: number) => transform && Object.hasOwn(transform, name) ? transform[name] : fallback;
  const result: Record<string, unknown> = { x: value("x", 0), y: value("y", 0), rotation: value("rotation", 0), scale: value("scale", 1) };
  for (const name of ["width", "height"] as const) if (transform && Object.hasOwn(transform, name)) result[name] = transform[name];
  return result as unknown as MotionBehaviorBaseTransform;
}

function checkBinding(binding: MotionBehavior, base: MotionBehaviorBaseTransform): { ok: true; workUnits: number } | { ok: false; message: string } {
  if (binding.kind === "path-follow") {
    const result = evaluateMotionPathFollow({ schema: "shellx-motion/path-follow@1", atUs: binding.startUs, startUs: binding.startUs, durationUs: binding.durationUs, geometry: binding.geometry, ...(binding.offsetUs === undefined ? {} : { offsetUs: binding.offsetUs }), ...(binding.direction === undefined ? {} : { direction: binding.direction }), ...(binding.orientToPath === undefined ? {} : { orientToPath: binding.orientToPath }), ...(binding.easing === undefined ? {} : { easing: binding.easing }) });
    return result.ok ? { ok: true, workUnits: result.evaluation.budget.workUnits } : { ok: false, message: result.message };
  }
  const atUs = binding.startUs + binding.durationUs;
  const result = evaluateMotionTransformBehavior({ schema: "shellx-motion/transform-behavior@1", atUs, startUs: binding.startUs, durationUs: binding.durationUs, base, ...(binding.motion === undefined ? {} : { motion: binding.motion }), ...(binding.squash === undefined ? {} : { squash: binding.squash }) });
  return result.ok ? { ok: true, workUnits: result.evaluation.budget.workUnits } : { ok: false, message: result.message };
}

function hasTransformKeyframes(layer: MotionLayer): boolean { return Object.keys(layer.keyframes ?? {}).some((target) => target.startsWith("transform.")); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isMotionLayer(value: unknown): value is MotionLayer { return isRecord(value) && typeof value.id === "string"; }
function hasProceduralTransformRelation(relationships: unknown, layerId: string): boolean {
  if (!isRecord(relationships) || !Array.isArray(relationships.relationships)) return false;
  return relationships.relationships.some((candidate) => {
    if (!isRecord(candidate) || !isRecord(candidate.target)) return false;
    return candidate.target.layerId === layerId && typeof candidate.target.property === "string" && candidate.target.property.startsWith("transform.");
  });
}
function emptyBudget(): MotionBehaviorBudget { return { inputBytes: 0, bindingCount: 0, enabledBindingCount: 0, frameWorkUnits: 0, limits: { maxBindings: 32, maxFrameWorkUnits: MAX_MOTION_BEHAVIOR_FRAME_WORK_UNITS } }; }
function fail(path: string, message: string): MotionBehaviorValidationResult { return { ok: false, issues: [{ path, message }] }; }
