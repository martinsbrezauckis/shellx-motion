import { canonicalJson } from "./canonical-json";
import { compileMotionGroupLayout } from "./motion-group-layout";
import { readMotionGroupGraph } from "./motion-group-structural-support";
import { readMotionLayoutApplications } from "./motion-layout-application";
import { readMotionLayoutGapAnimationDescriptor } from "./motion-layout-gap-animation-read";
import { MAX_MOTION_LAYOUT_GAP_ANIMATION_WORK_UNITS, type MotionLayoutGapAnimationDescriptor, type MotionLayoutGapAnimationTrack, type MotionLayoutGapAnimationTrackBinding } from "./motion-layout-gap-animation-types";
import type { MotionDocument, MotionLayer } from "./types";

export interface MotionLayoutGapAnimationDocumentIssue { path: string; message: string }
export type MotionLayoutGapAnimationDocumentValidation =
  | { ok: true; descriptor: MotionLayoutGapAnimationDescriptor | undefined }
  | { ok: false; issues: readonly MotionLayoutGapAnimationDocumentIssue[] };

/** Validate the optional root against one still-exact static application per track. */
export function validateMotionLayoutGapAnimationDocument(value: unknown, motion: MotionDocument): MotionLayoutGapAnimationDocumentValidation {
  if (value === undefined) return { ok: true, descriptor: undefined };
  try {
    assertDataTree(motion, "Motion document");
    const descriptor = readMotionLayoutGapAnimationDescriptor(value);
    const durationUs = documentUs(motion.durationMs);
    let workUnits = 0;
    for (const [trackIndex, track] of descriptor.tracks.entries()) {
      for (const [keyframeIndex, keyframe] of track.keyframes.entries()) {
        if (keyframe.atUs > durationUs) return fail(`/layoutGapAnimation/tracks/${trackIndex}/keyframes/${keyframeIndex}/atUs`, "must fit the document duration exactly in microseconds");
      }
      const binding = layoutGapAnimationTrackBinding(motion, track);
      // Evaluation recompiles one fixed-child projection from the recorded `patches.before`.
      // Count both the admission compile and that projection compile before any mutation or I/O.
      workUnits += binding.childLayerIds.length * 2;
      if (workUnits > MAX_MOTION_LAYOUT_GAP_ANIMATION_WORK_UNITS) return fail(`/layoutGapAnimation/tracks/${trackIndex}`, `exceeds the ${MAX_MOTION_LAYOUT_GAP_ANIMATION_WORK_UNITS}-unit layout gap animation work cap`);
    }
    return { ok: true, descriptor };
  } catch (error) { return fail("/layoutGapAnimation", error instanceof Error ? error.message : "must be a valid layout gap animation descriptor"); }
}

export function readMotionLayoutGapAnimationDocumentRoot(value: unknown, motion: MotionDocument): MotionLayoutGapAnimationDescriptor | undefined {
  if (value === undefined) return undefined;
  const descriptor = readMotionLayoutGapAnimationDescriptor(value);
  const result = validateMotionLayoutGapAnimationDocument(descriptor, motion);
  if (!result.ok) throw new Error(`Motion document layoutGapAnimation is invalid: ${result.issues[0]!.message}`);
  return descriptor;
}

/**
 * Re-validates the persisted static layout application without consuming its removal authority.
 * This is deliberately shared by document validation and evaluation so a stale layout can never
 * be animated into a different topology.
 */
export function layoutGapAnimationTrackBinding(motion: MotionDocument, track: MotionLayoutGapAnimationTrack): MotionLayoutGapAnimationTrackBinding {
  const applications = readMotionLayoutApplications(motion);
  const application = applications.find((candidate) => candidate.id === track.applicationId);
  if (!application) throw new Error(`Layout gap animation application '${track.applicationId}' is absent.`);
  if (application.fingerprint !== track.applicationFingerprint) throw new Error(`Layout gap animation application '${track.applicationId}' fingerprint is stale.`);
  if (!sameIds(application.childLayerIds, track.childLayerIds)) throw new Error(`Layout gap animation application '${track.applicationId}' direct child order is stale.`);
  if (application.layout.kind !== "row" && application.layout.kind !== "column") throw new Error("Layout gap animation admits row or column applications only.");
  if (application.layout.distribution !== "start") throw new Error("Layout gap animation requires distribution 'start'.");
  if (application.repeaters.length !== 0 || application.generatedLayers.length !== 0 || application.trackPatches.length !== 0) throw new Error("Layout gap animation refuses repeaters and materialized layout applications.");
  if (!sameIds(application.childLayerIds, application.materializedChildLayerIds)) throw new Error("Layout gap animation requires fixed direct children with no materialized topology.");
  assertNoCompetingLayoutAuthority(motion);
  const graph = readMotionGroupGraph(motion);
  const group = graph.byId.get(application.groupId);
  if (!group || group.type !== "group") throw new Error(`Layout gap animation group '${application.groupId}' is absent.`);
  const currentChildIds = graph.childrenByGroupId.get(application.groupId) ?? [];
  if (!sameIds(currentChildIds, application.childLayerIds)) throw new Error("Layout gap animation direct child topology is stale.");
  if (!patchesMatchAfter(motion, application.patches)) throw new Error("Layout gap animation static application output is stale.");
  const reconstructed = restorePatches(motion, application.patches);
  const compiled = compileMotionGroupLayout({ schema: "shellx-motion/group-layout-compile@1", motion: reconstructed, groupId: application.groupId, layout: application.layout, repeaters: application.repeaters });
  if (compiled.status !== "ok") throw new Error(`Layout gap animation static layout is no longer admissible: ${compiled.issues[0]?.code ?? "unknown"}.`);
  if (!sameIds(compiled.plan.source.childLayerIds, application.childLayerIds)) throw new Error("Layout gap animation reconstructed direct child topology is stale.");
  if (compiled.plan.layoutFingerprint !== application.layoutFingerprint) throw new Error("Layout gap animation static application layout fingerprint is stale.");
  const expected = patchesForCompilation(reconstructed, compiled.plan.instances);
  if (canonicalJson(expected) !== canonicalJson(application.patches)) throw new Error("Layout gap animation static application inverse evidence is stale.");
  return Object.freeze({ applicationId: application.id, applicationFingerprint: application.fingerprint, groupId: application.groupId, childLayerIds: Object.freeze([...application.childLayerIds]), layoutKind: application.layout.kind, staticGap: application.layout.gap, layoutFingerprint: application.layoutFingerprint });
}

/**
 * Regenerate only the reserved layout-owned child transform/timing projection. The source is
 * always the persisted application inverse (`patches.before`), never today's translated output.
 */
export function projectMotionLayoutGapAnimationTrack(motion: MotionDocument, track: MotionLayoutGapAnimationTrack, gap: number) {
  const binding = layoutGapAnimationTrackBinding(motion, track);
  if (typeof gap !== "number" || !Number.isFinite(gap)) throw new Error("Layout gap animation projection gap must be finite.");
  const application = readMotionLayoutApplications(motion).find((candidate) => candidate.id === track.applicationId);
  if (!application) throw new Error(`Layout gap animation application '${track.applicationId}' is absent.`);
  const reconstructed = restorePatches(motion, application.patches);
  const compiled = compileMotionGroupLayout({ schema: "shellx-motion/group-layout-compile@1", motion: reconstructed, groupId: application.groupId, layout: { ...application.layout, gap }, repeaters: [] });
  if (compiled.status !== "ok") throw new Error(`Layout gap animation projection is no longer admissible: ${compiled.issues[0]?.code ?? "unknown"}.`);
  if (!sameIds(compiled.plan.source.childLayerIds, binding.childLayerIds) || compiled.plan.instances.length !== binding.childLayerIds.length) throw new Error("Layout gap animation projection direct child topology is stale.");
  return Object.freeze(compiled.plan.instances.map((instance, index) => {
    if (instance.instanceIndex !== 0 || instance.sourceId !== binding.childLayerIds[index]) throw new Error("Layout gap animation projection topology is not fixed direct children.");
    return Object.freeze({ layerId: instance.sourceId, transform: Object.freeze({ ...instance.transform }), timing: Object.freeze({ ...instance.timing }) });
  }));
}

function patchesForCompilation(motion: MotionDocument, instances: readonly { sourceId: string; instanceIndex: number; transform: object; timing: { startMs: number; durationMs: number } }[]) {
  const layers = new Map(motion.layers.map((layer) => [layer.id, layer]));
  const patches: Array<{ layerId: string; before: unknown; after: unknown }> = [];
  for (const instance of instances.filter((candidate) => candidate.instanceIndex === 0)) {
    const layer = layers.get(instance.sourceId);
    const before = layer && snapshot(layer);
    if (!before) throw new Error(`Layout gap animation child '${instance.sourceId}' lacks a static transform snapshot.`);
    const after = { transform: { ...structuredClone(before.transform), ...instance.transform }, timing: structuredClone(instance.timing) };
    if (canonicalJson(before) !== canonicalJson(after)) patches.push({ layerId: instance.sourceId, before, after });
  }
  return patches;
}
function patchesMatchAfter(motion: MotionDocument, patches: readonly { layerId: string; after: unknown }[]): boolean {
  const layers = new Map(motion.layers.map((layer) => [layer.id, layer]));
  return patches.every((patch) => {
    const layer = layers.get(patch.layerId);
    const current = layer && snapshot(layer);
    return current !== null && current !== undefined && canonicalJson(current) === canonicalJson(patch.after);
  });
}
function restorePatches(motion: MotionDocument, patches: readonly { layerId: string; before: { transform: MotionLayer["transform"]; timing: { startMs: number; durationMs: number } } }[]): MotionDocument {
  const byId = new Map(patches.map((patch) => [patch.layerId, patch]));
  return { ...motion, layers: motion.layers.map((layer) => {
    const patch = byId.get(layer.id); if (!patch) return layer;
    return { ...layer, transform: structuredClone(patch.before.transform), startMs: patch.before.timing.startMs, durationMs: patch.before.timing.durationMs };
  }) };
}
function snapshot(layer: MotionLayer): { transform: MotionLayer["transform"]; timing: { startMs: number; durationMs: number } } | null {
  if (!layer.transform || !Number.isInteger(layer.startMs) || !Number.isInteger(layer.durationMs)) return null;
  return { transform: structuredClone(layer.transform), timing: { startMs: layer.startMs, durationMs: layer.durationMs } };
}
function assertNoCompetingLayoutAuthority(motion: MotionDocument): void {
  // These roots can own transform channels. Refuse conservatively rather than guessing whether an
  // opaque relationship or behavior leaves this application's direct children untouched.
  for (const key of ["relationships", "behaviors", "relations"] as const) {
    const descriptor = ownDescriptor(motion, key, "Motion document");
    if (descriptor && "value" in descriptor && descriptor.value !== undefined) throw new Error(`Layout gap animation refuses competing ${key} transform authority.`);
  }
}
function documentUs(value: unknown): number { if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value * 1_000) || value <= 0) throw new Error("requires an exactly representable positive document duration in microseconds"); return value * 1_000; }
function sameIds(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((entry, index) => entry === right[index]); }
function fail(path: string, message: string): MotionLayoutGapAnimationDocumentValidation { return { ok: false, issues: Object.freeze([{ path, message }]) }; }

/** Bounded data-only guard used before every Core mutation and all document graph traversal. */
export function assertMotionLayoutGapAnimationData(value: unknown): void { assertDataTree(value, "Motion document"); }
function assertDataTree(value: unknown, label: string, seen = new WeakSet<object>(), depth = 0, state = { nodes: 0 }): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error(`${label} must contain finite numbers.`); return; }
  if (typeof value !== "object") throw new Error(`${label} must be JSON data.`);
  if (depth > 64 || ++state.nodes > 100_000 || seen.has(value)) throw new Error(`${label} must be a bounded acyclic data tree.`);
  seen.add(value);
  const prototype = prototypeOf(value, label);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) throw new Error(`${label} must be a plain dense array.`);
    const keys = ownKeys(value, label), lengthDescriptor = ownDescriptor(value, "length", label), length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1 || !keys.includes("length") || keys.some((key) => typeof key !== "string")) throw new Error(`${label} must be a dense data array.`);
    for (let index = 0; index < length; index += 1) assertDataTree(dataField(value, String(index), label), `${label}[${index}]`, seen, depth + 1, state);
    return;
  }
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain data object.`);
  const keys = ownKeys(value, label);
  if (keys.some((key) => typeof key !== "string")) throw new Error(`${label} must not contain symbol fields.`);
  for (const key of keys as string[]) assertDataTree(dataField(value, key, label), `${label}.${key}`, seen, depth + 1, state);
}
function ownKeys(value: object, label: string): PropertyKey[] { try { return Reflect.ownKeys(value); } catch { throw new Error(`${label} reflection failed.`); } }
function ownDescriptor(value: object, key: PropertyKey, label: string): PropertyDescriptor | undefined { try { return Object.getOwnPropertyDescriptor(value, key); } catch { throw new Error(`${label} reflection failed.`); } }
function dataField(value: object, key: PropertyKey, label: string): unknown { const descriptor = ownDescriptor(value, key, label); if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error(`${label}.${String(key)} must be an enumerable data field.`); return descriptor.value; }
function prototypeOf(value: object, label: string): object | null { try { return Object.getPrototypeOf(value); } catch { throw new Error(`${label} reflection failed.`); } }
