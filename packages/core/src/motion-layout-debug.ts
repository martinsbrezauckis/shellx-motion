import { canonicalJson, canonicalJsonSha256 } from "./canonical-json";
import { compileMotionGroupLayout } from "./motion-group-layout";
import {
  createMotionLayoutApplication,
  MAX_MOTION_LAYOUT_APPLICATIONS,
  readMotionLayoutApplications,
  withoutMotionLayoutApplication
} from "./motion-layout-application";
import { readMotionGroupGraph, requireGroup } from "./motion-group-structural-support";
import {
  materializeMotionLayoutRepeaters,
  removeMaterializedMotionLayoutRepeaters
} from "./motion-layout-repeater-materialization";
import { loadSchemaSync, validateDocumentSync } from "./validate";
import { parseMotionLayoutDebugIntent } from "./motion-layout-debug-boundary";
import {
  consumeMotionLayoutRemovalAuthorization,
  hasMotionLayoutRemovalAuthorization,
} from "./motion-layout-removal-authority";
import { motionLayoutGapAnimationStorePresent } from "./motion-layout-gap-animation-lane-refusal";
import {
  MOTION_LAYOUT_DEBUG_APPLIED_SCHEMA,
  MOTION_LAYOUT_DEBUG_INTENT_SCHEMA,
  MOTION_LAYOUT_DEBUG_REMOVAL_SCHEMA,
  type MotionLayoutDebugApplied,
  type MotionLayoutDebugCompilation,
  type MotionLayoutDebugIntent,
  type MotionLayoutDebugIssue,
  type MotionLayoutDebugLayerSnapshot,
  type MotionLayoutDebugPatch,
  type MotionLayoutDebugRemoval,
  type MotionLayoutDebugResult,
  type MotionLayoutDebugRunOptions,
} from "./motion-layout-debug-types";
import type { MotionDocument, MotionLayer, MotionTransform, OperationReceipt } from "./types";

export * from "./motion-layout-debug-types";
export { parseMotionLayoutDebugIntent } from "./motion-layout-debug-boundary";

/** Strict, data-only Debug boundary. It does not register a command or mutate its input. */
export function runMotionLayoutDebug(value: unknown, options: MotionLayoutDebugRunOptions = {}): MotionLayoutDebugResult {
  const parsed = parseMotionLayoutDebugIntent(value);
  if (!parsed.ok) return { status: "refused", issues: parsed.issues };
  if (parsed.intent.operation === "remove") return removeLayout(parsed.intent, options);
  const compiled = compileLayout(parsed.intent);
  if (!compiled.ok) return { status: "refused", issues: compiled.issues };
  if (parsed.intent.operation === "inspect" || parsed.intent.operation === "compile") {
    return { status: "ok", operation: parsed.intent.operation, compilation: compiled.compilation, receipt: receipt(parsed.intent.operation, parsed.intent.motion, parsed.intent.createdAt, compiled.compilation) };
  }
  return applyLayout(parsed.intent, compiled.compilation);
}

function compileLayout(intent: Exclude<MotionLayoutDebugIntent, { operation: "remove" }>): { ok: true; compilation: MotionLayoutDebugCompilation } | { ok: false; issues: MotionLayoutDebugIssue[] } {
  const result = compileMotionGroupLayout({ schema: "shellx-motion/group-layout-compile@1", motion: intent.motion, groupId: intent.groupId, layout: intent.layout, repeaters: intent.repeaters });
  if (result.status !== "ok") return { ok: false, issues: result.issues.map((entry) => issue(entry.path, entry.code, entry.message)) };
  const outside = result.plan.instances.filter((entry) => entry.outsideBounds);
  return {
    ok: true,
    compilation: {
      source: structuredClone(result.plan.source), ownership: structuredClone(result.plan.ownership), instances: structuredClone(result.plan.instances), budget: structuredClone(result.plan.budget),
      layoutFingerprintInput: result.plan.layoutFingerprintInput, layoutFingerprint: result.plan.layoutFingerprint,
      overflow: { basis: "unscaled-unrotated-layout-slot", policy: intent.layout.overflow, outsideSlotCount: outside.length, clippedSlotCount: outside.filter((entry) => entry.overflow === "clipped").length, visibleOutsideSlotCount: outside.filter((entry) => entry.overflow === "visible").length, physicalClipping: "refused" },
      repeaters: intent.repeaters.map((repeater) => ({ sourceId: repeater.sourceId, count: repeater.count, instanceCount: result.plan.instances.filter((entry) => entry.sourceId === repeater.sourceId).length })),
    },
  };
}

function applyLayout(intent: Extract<MotionLayoutDebugIntent, { operation: "apply" }>, compilation: MotionLayoutDebugCompilation): MotionLayoutDebugResult {
  const patches = patchesForCompilation(intent.motion, compilation);
  if (!patches.ok) return { status: "refused", issues: patches.issues };
  const repeated = !oneIntentPerChild(compilation);
  if (!repeated && patches.patches.length === 0) return { status: "refused", issues: [issue("/", "apply.no_op", "compiled ordinary transform/timing output would not change any direct child")] };
  const latest = compileLayout(intent);
  if (!latest.ok || !sameOwnership(latest.compilation, compilation)) return { status: "refused", issues: latest.ok ? [issue("/groupId", "apply.stale_ownership", "direct group ownership changed before copy-on-write commit")] : latest.issues };
  let existing;
  try { existing = readMotionLayoutApplications(intent.motion); } catch (error) { return { status: "refused", issues: [issue("/motion/layoutApplications", "apply.application_state", errorMessage(error))] }; }
  if (existing.length >= MAX_MOTION_LAYOUT_APPLICATIONS) return { status: "refused", issues: [issue("/motion/layoutApplications", "apply.application_limit", `document already has the ${MAX_MOTION_LAYOUT_APPLICATIONS}-application cap`)] };
  if (existing.some((application) => application.groupId === compilation.source.groupId || application.materializedChildLayerIds.some((layerId) => compilation.source.childLayerIds.includes(layerId)))) {
    return { status: "refused", issues: [issue("/motion/layoutApplications", "apply.application_overlap", "an active layout application already owns this group or one of its direct children")] };
  }
  let materialized;
  try { materialized = repeated ? materializeMotionLayoutRepeaters(intent.motion, compilation, patches.patches) : null; }
  catch (error) { return { status: "refused", issues: [issue("/repeaters", "apply.materialization", errorMessage(error))] }; }
  let application;
  try {
    application = createMotionLayoutApplication({
      groupId: compilation.source.groupId,
      layoutFingerprint: compilation.layoutFingerprint,
      childLayerIds: [...compilation.source.childLayerIds],
      materializedChildLayerIds: materialized ? [...materialized.materializedChildLayerIds] : [...compilation.source.childLayerIds],
      layout: structuredClone(intent.layout),
      repeaters: structuredClone(intent.repeaters),
      patches: structuredClone(patches.patches),
      trackPatches: materialized ? structuredClone(materialized.trackPatches) : [],
      generatedLayers: materialized ? structuredClone(materialized.generatedLayers) : []
    });
  } catch (error) {
    return { status: "refused", issues: [issue("/motion/layoutApplications", "apply.application_record", errorMessage(error))] };
  }
  if (existing.some((entry) => entry.id === application.id)) return { status: "refused", issues: [issue("/motion/layoutApplications", "apply.application_id", `deterministic application id already exists: ${application.id}`)] };
  const patched = materialized?.motion ?? commitPatches(intent.motion, patches.patches, "after");
  const motion: MotionDocument = { ...patched, layoutApplications: [...existing, application] };
  const finalValidation = validateFinalMotion(motion);
  if (finalValidation) return { status: "refused", issues: [finalValidation] };
  const removal: MotionLayoutDebugRemoval = {
    schema: MOTION_LAYOUT_DEBUG_REMOVAL_SCHEMA,
    applicationId: application.id,
    applicationFingerprint: application.fingerprint
  };
  const applied: MotionLayoutDebugApplied = { schema: MOTION_LAYOUT_DEBUG_APPLIED_SCHEMA, removal };
  return { status: "ok", operation: "apply", motion, compilation, applied, receipt: receipt("apply", intent.motion, intent.createdAt, compilation, materialized?.changedLayerIds ?? patches.patches.map((patch) => patch.layerId), undefined, motion, applicationFacts(application, "applied")) };
}

function removeLayout(
  intent: Extract<MotionLayoutDebugIntent, { operation: "remove" }>,
  options: MotionLayoutDebugRunOptions,
): MotionLayoutDebugResult {
  let applications;
  try { applications = readMotionLayoutApplications(intent.motion); } catch (error) { return { status: "refused", issues: [issue("/motion/layoutApplications", "remove.application_state", errorMessage(error))] }; }
  const application = applications.find((entry) => entry.id === intent.removal.applicationId);
  if (!application) return { status: "refused", issues: [issue("/removal/applicationId", "remove.application_missing", "named layout application is not present in the current document")] };
  if (application.fingerprint !== intent.removal.applicationFingerprint) return { status: "refused", issues: [issue("/removal/applicationFingerprint", "remove.application_fingerprint", "named layout application fingerprint does not match the current document record")] };
  if (motionLayoutGapAnimationStorePresent(intent.motion)) return { status: "refused", issues: [issue("/layoutGapAnimation", "remove.animation_present", "remove layout gap track first")] };
  const authorization = {
    packageId: options.packageId ?? "",
    applicationId: application.id,
    applicationFingerprint: application.fingerprint,
  };
  if (!hasMotionLayoutRemovalAuthorization(options.removalAuthorization, authorization)) {
    return { status: "refused", issues: [issue("/removal", "remove.receipt_authorization", "layout removal requires a matching, host-verified one-shot apply receipt authorization")] };
  }
  let group;
  try { group = requireGroup(readMotionGroupGraph(intent.motion), application.groupId); } catch (error) { return { status: "refused", issues: [issue("/motion/layoutApplications", "remove.stale_ownership", errorMessage(error))] }; }
  if (!sameIds(group.childLayerIds ?? [], application.materializedChildLayerIds)) {
    return { status: "refused", issues: [issue("/motion/layoutApplications", "remove.stale_ownership", "current direct group ownership differs from the recorded applied state")] };
  }
  if (application.generatedLayers.length === 0 && !sameIds(application.childLayerIds, application.materializedChildLayerIds)) {
    return { status: "refused", issues: [issue("/motion/layoutApplications", "remove.record_integrity", "a non-materialized application must retain its original direct child order")] };
  }
  if (application.patches.some((patch) => !application.childLayerIds.includes(patch.layerId))) return { status: "refused", issues: [issue("/motion/layoutApplications", "remove.record_integrity", "application patch targets a layer outside its recorded direct children")] };
  let restoredMaterialization: MotionDocument;
  try {
    restoredMaterialization = application.generatedLayers.length > 0
      ? removeMaterializedMotionLayoutRepeaters(intent.motion, application)
      : intent.motion;
    if (application.generatedLayers.length === 0 && application.trackPatches.length > 0) {
      return { status: "refused", issues: [issue("/motion/layoutApplications", "remove.record_integrity", "a non-materialized application cannot carry track patches")] };
    }
  } catch (error) {
    return { status: "refused", issues: [issue("/motion/layoutApplications", "remove.stale_materialization", errorMessage(error))] };
  }
  const current = patchesMatchAfter(restoredMaterialization, application.patches);
  if (!current.ok) return { status: "refused", issues: current.issues };
  const reconstructed = commitPatches(restoredMaterialization, application.patches, "before");
  const removalIntent = { schema: MOTION_LAYOUT_DEBUG_INTENT_SCHEMA, operation: "compile" as const, motion: reconstructed, createdAt: intent.createdAt, groupId: application.groupId, layout: application.layout, repeaters: application.repeaters };
  const compiled = compileLayout(removalIntent);
  if (!compiled.ok) return { status: "refused", issues: compiled.issues };
  if (!sameIds(compiled.compilation.source.childLayerIds, application.childLayerIds)) return { status: "refused", issues: [issue("/motion/layoutApplications", "remove.stale_ownership", "reconstructed direct group ownership differs from the document application record")] };
  if (application.generatedLayers.length === 0 && !oneIntentPerChild(compiled.compilation)) return { status: "refused", issues: [issue("/motion/layoutApplications", "remove.record_integrity", "a repeated layout application is missing generated layer records")] };
  if (compiled.compilation.layoutFingerprint !== application.layoutFingerprint) return { status: "refused", issues: [issue("/motion/layoutApplications", "remove.record_integrity", "recorded layout fingerprint does not match its declared pre-application document state")] };
  const expectedPatches = patchesForCompilation(reconstructed, compiled.compilation);
  if (!expectedPatches.ok) return { status: "refused", issues: expectedPatches.issues };
  if (canonicalJson(expectedPatches.patches) !== canonicalJson(application.patches)) return { status: "refused", issues: [issue("/motion/layoutApplications", "remove.record_integrity", "recorded inverse patches do not exactly match the declared layout application")] };
  const motion = withoutMotionLayoutApplication(reconstructed, application.id);
  if (application.generatedLayers.length > 0) {
    let expectedMaterialization;
    try { expectedMaterialization = materializeMotionLayoutRepeaters(motion, compiled.compilation, expectedPatches.patches); }
    catch (error) { return { status: "refused", issues: [issue("/motion/layoutApplications", "remove.record_integrity", errorMessage(error))] }; }
    const observed = withoutMotionLayoutApplication(intent.motion, application.id);
    if (canonicalJson(expectedMaterialization.motion) !== canonicalJson(observed)) {
      return { status: "refused", issues: [issue("/motion/layoutApplications", "remove.record_integrity", "current materialized document does not exactly match its declared application record")] };
    }
  }
  const finalValidation = validateFinalMotion(motion);
  if (finalValidation) return { status: "refused", issues: [finalValidation] };
  if (!consumeMotionLayoutRemovalAuthorization(options.removalAuthorization, authorization)) {
    return { status: "refused", issues: [issue("/removal", "remove.receipt_authorization", "layout removal receipt authorization was released or already used")] };
  }
  const changedLayerIds = application.generatedLayers.length > 0
    ? [application.groupId, ...application.patches.map((patch) => patch.layerId), ...application.generatedLayers.map((layer) => layer.id)]
    : application.patches.map((patch) => patch.layerId);
  return { status: "ok", operation: "remove", motion, compilation: compiled.compilation, receipt: receipt("remove", intent.motion, intent.createdAt, compiled.compilation, changedLayerIds, application.layoutFingerprint, motion, applicationFacts(application, "removed")) };
}

function patchesForCompilation(motion: MotionDocument, compilation: MotionLayoutDebugCompilation): { ok: true; patches: MotionLayoutDebugPatch[] } | { ok: false; issues: MotionLayoutDebugIssue[] } {
  const layers = new Map(motion.layers.map((layer) => [layer.id, layer]));
  const patches: MotionLayoutDebugPatch[] = [];
  const sourceInstances = compilation.instances.filter((instance) => instance.instanceIndex === 0);
  if (sourceInstances.length !== compilation.source.childLayerIds.length || !sameIds(sourceInstances.map((instance) => instance.sourceId), compilation.source.childLayerIds)) {
    return { ok: false, issues: [issue("/instances", "apply.instances", "compiled instances must contain one ordered source instance for every direct child")] };
  }
  for (const instance of sourceInstances) {
    const layer = layers.get(instance.sourceId);
    const before = layer ? snapshot(layer, `/layers/${instance.sourceId}`) : null;
    if (!before) return { ok: false, issues: [issue(`/layers/${instance.sourceId}`, "apply.layer", "direct child is missing or does not have an exact ordinary transform/timing snapshot")] };
    const after: MotionLayoutDebugLayerSnapshot = { transform: { ...structuredClone(before.transform), ...instance.transform }, timing: structuredClone(instance.timing) };
    if (canonicalJson(before) !== canonicalJson(after)) patches.push({ layerId: instance.sourceId, before, after });
  }
  return { ok: true, patches };
}

function patchesMatchAfter(motion: MotionDocument, patches: MotionLayoutDebugPatch[]): { ok: true } | { ok: false; issues: MotionLayoutDebugIssue[] } {
  const layers = new Map(motion.layers.map((layer) => [layer.id, layer]));
  for (const patch of patches) {
    const layer = layers.get(patch.layerId);
    const current = layer ? snapshot(layer, `/layers/${patch.layerId}`) : null;
    if (!current || canonicalJson(current) !== canonicalJson(patch.after)) return { ok: false, issues: [issue(`/removal/patches/${patch.layerId}`, "remove.stale_output", "current ordinary transform/timing no longer matches the explicit applied state")] };
  }
  return { ok: true };
}

function commitPatches(motion: MotionDocument, patches: MotionLayoutDebugPatch[], side: "before" | "after"): MotionDocument {
  const byId = new Map(patches.map((patch) => [patch.layerId, patch]));
  return { ...motion, layers: motion.layers.map((layer) => {
    const patch = byId.get(layer.id);
    if (!patch) return layer;
    const state = patch[side];
    return { ...layer, transform: structuredClone(state.transform), startMs: state.timing.startMs, durationMs: state.timing.durationMs };
  }) };
}

function snapshot(layer: MotionLayer, path: string): MotionLayoutDebugLayerSnapshot | null {
  const transform = dataRecord(layer.transform);
  if (!transform || !validTransform(transform) || !validTiming(layer.startMs, layer.durationMs)) return null;
  return { transform: structuredClone(transform) as MotionTransform, timing: { startMs: layer.startMs, durationMs: layer.durationMs } };
}

function receipt(
  operation: string,
  motion: MotionDocument,
  createdAt: string,
  compilation: MotionLayoutDebugCompilation,
  changedLayerIds: string[] = [],
  revertedAppliedFingerprint?: string,
  outputMotion?: MotionDocument,
  application?: ReturnType<typeof applicationFacts>
): OperationReceipt {
  const warnings = compilation.overflow.outsideSlotCount === 0 ? [] : [`${compilation.overflow.outsideSlotCount} layout slot(s) are outside the unscaled/unrotated content box; physical clipping is refused.`];
  const motionSha256 = canonicalJsonSha256(motion);
  const outputMotionSha256 = outputMotion ? canonicalJsonSha256(outputMotion) : undefined;
  const identity = canonicalJsonSha256({ operation, motionId: motion.id, motionSha256, layoutFingerprint: compilation.layoutFingerprint, changedLayerIds, revertedAppliedFingerprint: revertedAppliedFingerprint ?? null, outputMotionSha256: outputMotionSha256 ?? null });
  return {
    schema: "shellx-motion/receipt@1", id: `debug-layout-${operation}-${identity.slice(0, 16)}`, operation: `debug.layout.${operation}`, status: warnings.length ? "warning" : "passed", packageId: motion.id,
    inputHashes: { motion: motionSha256, layout: compilation.layoutFingerprint }, createdAt, lane: "debug-layout",
    output: { layoutFingerprint: compilation.layoutFingerprint, layoutFingerprintInput: compilation.layoutFingerprintInput, budget: compilation.budget, overflow: compilation.overflow, repeaters: compilation.repeaters, source: compilation.source, changedLayerIds, ...(outputMotionSha256 ? { outputMotionSha256 } : {}), ...(revertedAppliedFingerprint ? { revertedAppliedFingerprint } : {}), ...(application ? { application } : {}) }, warnings,
  };
}

function sameOwnership(left: MotionLayoutDebugCompilation, right: MotionLayoutDebugCompilation): boolean { return left.layoutFingerprint === right.layoutFingerprint && sameIds(left.source.childLayerIds, right.source.childLayerIds) && left.source.groupId === right.source.groupId; }
function oneIntentPerChild(compilation: MotionLayoutDebugCompilation): boolean { return compilation.instances.length === compilation.source.childLayerIds.length && compilation.instances.every((entry, index) => entry.sourceId === compilation.source.childLayerIds[index] && entry.instanceIndex === 0); }
function sameIds(left: string[], right: string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function validTransform(value: Record<string, unknown>): boolean {
  const known = new Set(["x", "y", "width", "height", "scale", "rotation", "opacity"]);
  return Object.keys(value).every((key) => known.has(key) || key.startsWith("x-"))
    && finiteRange(value.width, 0.000001, 1_000_000) && finiteRange(value.height, 0.000001, 1_000_000)
    && optionalRange(value.x, -1_000_000, 1_000_000) && optionalRange(value.y, -1_000_000, 1_000_000)
    && optionalRange(value.scale, 0.000001, 1_000) && optionalRange(value.rotation, -360_000, 360_000) && optionalRange(value.opacity, 0, 1);
}
function validTiming(startMs: unknown, durationMs: unknown): boolean { return Number.isInteger(startMs) && Number.isInteger(durationMs) && Number(startMs) >= 0 && Number(durationMs) >= 1 && Number(startMs) + Number(durationMs) <= 3_600_000; }
function optionalRange(value: unknown, minimum: number, maximum: number): boolean { return value === undefined || finiteRange(value, minimum, maximum); }
function finiteRange(value: unknown, minimum: number, maximum: number): boolean { return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum; }
function dataRecord(value: unknown): Record<string, unknown> | null { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function issue(path: string, code: string, message: string): MotionLayoutDebugIssue { return { path, code, message }; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "invalid document-resident layout application state"; }
function validateFinalMotion(motion: MotionDocument): MotionLayoutDebugIssue | null {
  const validation = validateDocumentSync(loadSchemaSync("motion"), motion);
  if (validation.ok) return null;
  const first = validation.errors[0];
  return issue(first?.path || "/motion", "motion.final_validation", `final Motion document is invalid: ${first?.message ?? "unknown validation error"}`);
}
function applicationFacts(application: import("./types").MotionLayoutApplicationRecord, disposition: "applied" | "removed") {
  return {
    disposition,
    id: application.id,
    fingerprint: application.fingerprint,
    groupId: application.groupId,
    sourceChildLayerIds: [...application.childLayerIds],
    materializedChildLayerIds: [...application.materializedChildLayerIds],
    generatedLayerIds: application.generatedLayers.map((layer) => layer.id),
    trackOrders: application.trackPatches.map((patch) => ({ trackId: patch.trackId, beforeLayerIds: [...patch.beforeLayerIds], afterLayerIds: [...patch.afterLayerIds] }))
  };
}
