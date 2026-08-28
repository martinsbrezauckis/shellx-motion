/** Immutable C5B2 keyframe-intent planning. This leaf has no COW, renderer, or provider route. */

import {
  MAX_MOTION_RELATION_BAKE_SAMPLES,
  MAX_MOTION_RELATION_COORDINATE,
  canonicalJsonSha256,
  validateMotionProceduralGraph,
  validateMotionRelations,
  type MotionDocument,
  type MotionLayer,
} from "@shellx-motion/core";
import {
  MAX_RENDER_DELIVERY_ANCHOR_COORDINATE_Q1024,
  assertMotionRelationTargetsEditable,
  validateMotionBehaviors,
} from "@shellx-motion/core/internal/render-delivery-source";
import {
  inspectImportedRenderDeliveryAnchors,
  takeImportedRenderDeliveryAnchorInspectionMotion,
  type ImportedRenderDeliveryAnchorInspection,
  type ImportedRenderDeliveryAnchorTrack,
} from "./render-delivery-package-anchor-inspect.js";
import { type RenderDeliveryPackageWorkspaceHost } from "./render-delivery-package-workspace.js";
import {
  readRenderDeliveryAnchorKeyframeIntentRequest,
  type RenderDeliveryAnchorKeyframeIntentMapping,
  type RenderDeliveryAnchorKeyframeIntentRequest,
} from "./render-delivery-package-anchor-bake-request.js";

export { MOTION_RENDER_DELIVERY_ANCHOR_KEYFRAME_INTENT_REQUEST_SCHEMA } from "./render-delivery-package-anchor-bake-request.js";
export type { RenderDeliveryAnchorKeyframeIntentMapping, RenderDeliveryAnchorKeyframeIntentRequest } from "./render-delivery-package-anchor-bake-request.js";
export const MOTION_RENDER_DELIVERY_ANCHOR_KEYFRAME_INTENT_PLAN_SCHEMA = "shellx-motion/render-delivery-anchor-keyframe-intent-plan/v1" as const;
/** B2 plans two ordinary Motion keyframes per admitted sample, with no relation-bake expansion. */
const MAX_RENDER_DELIVERY_ANCHOR_KEYFRAME_WRITES = 3_600 * 2;

export interface RenderDeliveryAnchorKeyframeIntentPlan {
  readonly schema: typeof MOTION_RENDER_DELIVERY_ANCHOR_KEYFRAME_INTENT_PLAN_SCHEMA;
  readonly fingerprint: string;
  readonly operation: "keyframe-intent";
  readonly inspection: Pick<ImportedRenderDeliveryAnchorInspection, "fingerprint" | "package" | "receiptFingerprint" | "delivery" | "anchorAsset">;
  readonly request: { readonly fingerprint: string; readonly mappings: readonly RenderDeliveryAnchorKeyframeIntentMapping[] };
  /** Original receipt schedule plus the exact ordinary-Motion atMs lowering used for every intent. */
  readonly timing: {
    readonly scheduleFingerprint: string;
    readonly derivedAtMs: readonly number[];
    readonly derivedAtMsFingerprint: string;
    /** The last final-frame hold ends here; B2 never leaves a gap longer than one frame interval. */
    readonly coverage: {
      readonly policy: "final-frame-interval-at-most";
      readonly endMs: number;
    };
  };
  readonly limits: { readonly maxMappings: 16; readonly maxSamples: number; readonly maxKeyframeWrites: number };
  readonly counts: { readonly mappings: number; readonly samples: number; readonly keyframeWrites: number };
  readonly mappings: readonly RenderDeliveryAnchorKeyframeIntentPlanMapping[];
  readonly changedPathIntents: readonly string[];
}

export interface RenderDeliveryAnchorKeyframeIntentPlanMapping {
  readonly anchorId: number;
  readonly target: {
    readonly layerId: string;
    readonly layerIndex: number;
    readonly baseTransform: { readonly x: number; readonly y: number };
    readonly localTargetAnchorOffsetQ1024: { readonly xQ1024: number; readonly yQ1024: number };
  };
  readonly keyframes: {
    readonly x: readonly { readonly atMs: number; readonly value: number; readonly easing: "linear" }[];
    readonly y: readonly { readonly atMs: number; readonly value: number; readonly easing: "linear" }[];
  };
}

/** Reopen and plan only; execution belongs to a later COW transaction seam. */
export async function planImportedRenderDeliveryAnchorKeyframes(
  host: RenderDeliveryPackageWorkspaceHost,
  value: unknown,
): Promise<RenderDeliveryAnchorKeyframeIntentPlan> {
  const request = readRenderDeliveryAnchorKeyframeIntentRequest(value);
  const inspection = await inspectImportedRenderDeliveryAnchors(host);
  if (request.inspectionFingerprint !== inspection.fingerprint || request.receiptFingerprint !== inspection.receiptFingerprint) {
    throw new Error("Provider-anchor keyframe request does not bind the current imported package inspection.");
  }
  return compilePlan(inspection, takeImportedRenderDeliveryAnchorInspectionMotion(inspection), request);
}

function compilePlan(
  inspection: ImportedRenderDeliveryAnchorInspection,
  motion: MotionDocument,
  request: RenderDeliveryAnchorKeyframeIntentRequest,
): RenderDeliveryAnchorKeyframeIntentPlan {
  const sampleCount = inspection.delivery.schedule.length * request.mappings.length;
  const keyframeWrites = sampleCount * 2;
  if (!Number.isSafeInteger(sampleCount) || sampleCount > MAX_MOTION_RELATION_BAKE_SAMPLES) {
    throw new Error(`Provider-anchor keyframe plan exceeds ${MAX_MOTION_RELATION_BAKE_SAMPLES} samples before evaluation.`);
  }
  if (!Number.isSafeInteger(keyframeWrites) || keyframeWrites > MAX_RENDER_DELIVERY_ANCHOR_KEYFRAME_WRITES) {
    throw new Error(`Provider-anchor keyframe plan exceeds ${MAX_RENDER_DELIVERY_ANCHOR_KEYFRAME_WRITES} keyframe writes before evaluation.`);
  }
  const timing = exactDeliveryTimes(inspection, motion);
  assertDeliveryDimensions(inspection, motion);
  assertExistingAuthoritiesValid(motion);
  const groups = new Set(motion.layers.filter((layer) => layer.type === "group").flatMap((layer) => layer.childLayerIds ?? []));
  const tracks = new Map(inspection.anchors.map((track) => [track.id, track]));
  const mappings = request.mappings.map((mapping) => planMapping(mapping, tracks.get(mapping.anchorId), motion, groups, timing.atMs));
  const changedPathIntents = mappings.flatMap((mapping) => [
    `/layers/${mapping.target.layerIndex}/keyframes/transform.x`,
    `/layers/${mapping.target.layerIndex}/keyframes/transform.y`,
  ]);
  const requestFingerprint = canonicalJsonSha256(request);
  const payload = {
    schema: MOTION_RENDER_DELIVERY_ANCHOR_KEYFRAME_INTENT_PLAN_SCHEMA,
    operation: "keyframe-intent" as const,
    inspection: inspectionBinding(inspection),
    request: { fingerprint: requestFingerprint, mappings: request.mappings },
    timing: {
      scheduleFingerprint: inspection.delivery.scheduleFingerprint,
      derivedAtMs: timing.atMs,
      derivedAtMsFingerprint: canonicalJsonSha256(timing.atMs),
      coverage: { policy: "final-frame-interval-at-most" as const, endMs: timing.coverageEndMs },
    },
    limits: { maxMappings: 16 as const, maxSamples: MAX_MOTION_RELATION_BAKE_SAMPLES, maxKeyframeWrites: MAX_RENDER_DELIVERY_ANCHOR_KEYFRAME_WRITES },
    counts: { mappings: mappings.length, samples: sampleCount, keyframeWrites },
    mappings,
    changedPathIntents,
  };
  return deepFreeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}

function exactDeliveryTimes(inspection: ImportedRenderDeliveryAnchorInspection, motion: MotionDocument): { readonly atMs: number[]; readonly coverageEndMs: number } {
  if (!Number.isSafeInteger(motion.fps) || motion.fps <= 0 || inspection.delivery.rate.denominator !== 1
    || inspection.delivery.rate.numerator !== motion.fps) {
    throw new Error("Provider-anchor keyframe planning requires an integer delivery rate exactly equal to the Motion document fps.");
  }
  const result = inspection.delivery.schedule.map((frame) => {
    const atMs = frame.index * 1000 / motion.fps;
    if (!Number.isFinite(atMs) || atMs < 0 || atMs > motion.durationMs) {
      throw new Error("Provider-anchor schedule has a non-finite or out-of-document keyframe time.");
    }
    return Object.is(atMs, -0) ? 0 : atMs;
  });
  for (let index = 1; index < result.length; index += 1) if (!(result[index - 1]! < result[index]!)) {
    throw new Error("Provider-anchor schedule does not lower to strictly increasing Motion keyframe times.");
  }
  const coverageEndMs = result.length * 1000 / motion.fps;
  const lastAtMs = result[result.length - 1];
  if (!Number.isFinite(coverageEndMs) || lastAtMs === undefined || !(lastAtMs < motion.durationMs) || !(motion.durationMs <= coverageEndMs)) {
    throw new Error("Provider-anchor schedule does not cover the full Motion clip within its final frame interval.");
  }
  return { atMs: result, coverageEndMs };
}

function assertDeliveryDimensions(inspection: ImportedRenderDeliveryAnchorInspection, motion: MotionDocument): void {
  if (inspection.delivery.width !== motion.width || inspection.delivery.height !== motion.height) {
    throw new Error("Provider-anchor delivery dimensions must exactly match the Motion document before coordinate lowering.");
  }
}

function assertExistingAuthoritiesValid(motion: MotionDocument): void {
  if (motion.relationships) {
    const checked = validateMotionProceduralGraph(motion.relationships, motion);
    if (!checked.ok) throw new Error(`Current procedural authority is invalid at ${checked.issues[0]!.path}.`);
  }
  const behaviors = validateMotionBehaviors(motion.behaviors, motion);
  if (!behaviors.ok) throw new Error(`Current behavior authority is invalid at ${behaviors.issues[0]!.path}.`);
  const relations = validateMotionRelations(motion.relations, motion);
  if (!relations.ok) throw new Error(`Current relation authority is invalid at ${relations.issues[0]!.path}.`);
}

function planMapping(
  mapping: RenderDeliveryAnchorKeyframeIntentMapping,
  track: ImportedRenderDeliveryAnchorTrack | undefined,
  motion: MotionDocument,
  groupChildren: ReadonlySet<string>,
  atMs: readonly number[],
): RenderDeliveryAnchorKeyframeIntentPlanMapping {
  if (!track) throw new Error(`Provider-anchor ${mapping.anchorId} is not present in the imported payload.`);
  if (track.samples.some((sample) => !sample.visible)) {
    throw new Error(`Provider-anchor ${mapping.anchorId} has not-visible samples; B2 does not invent holds or gaps.`);
  }
  const layerIndex = motion.layers.findIndex((layer) => layer.id === mapping.targetLayerId);
  const layer = motion.layers[layerIndex];
  if (!layer || layer.type !== "shape" || groupChildren.has(layer.id) || layer.depth !== undefined || layer.visible === false) {
    throw new Error(`Provider-anchor target ${mapping.targetLayerId} must be a visible root-owned 2D shape layer.`);
  }
  assertMotionRelationTargetsEditable(motion, [layer.id]);
  if (Object.hasOwn(layer.keyframes ?? {}, "transform.x") || Object.hasOwn(layer.keyframes ?? {}, "transform.y")) {
    throw new Error(`Provider-anchor target ${layer.id} already has transform.x or transform.y keyframes.`);
  }
  if (hasProceduralTransformAuthority(motion, layer.id) || hasBehaviorTransformAuthority(motion, layer.id)
    || hasRelationAuthority(motion, layer.id)) {
    throw new Error(`Provider-anchor target ${layer.id} already has transform authority.`);
  }
  if (!activeAcross(layer, atMs, motion.durationMs)) throw new Error(`Provider-anchor target ${layer.id} is not active for every delivery sample.`);
  const baseTransform = baseXY(layer);
  const visibleSamples = track.samples.map((sample) => {
    if (!sample.visible) throw new Error(`Provider-anchor ${mapping.anchorId} has not-visible samples; B2 does not invent holds or gaps.`);
    return sample;
  });
  const x = visibleSamples.map((sample, index) => keyframeAt(atMs[index]!, subtractQ1024(sample.xQ1024, mapping.localTargetAnchorOffsetQ1024.xQ1024, "x")));
  const y = visibleSamples.map((sample, index) => keyframeAt(atMs[index]!, subtractQ1024(sample.yQ1024, mapping.localTargetAnchorOffsetQ1024.yQ1024, "y")));
  if (x.every((frame, index) => frame.value === baseTransform.x && y[index]!.value === baseTransform.y)) {
    throw new Error(`Provider-anchor mapping ${mapping.anchorId} is a no-op against target ${layer.id}.`);
  }
  return { anchorId: mapping.anchorId, target: { layerId: layer.id, layerIndex, baseTransform, localTargetAnchorOffsetQ1024: mapping.localTargetAnchorOffsetQ1024 }, keyframes: { x, y } };
}

function hasProceduralTransformAuthority(motion: MotionDocument, layerId: string): boolean {
  return (motion.relationships?.relationships ?? []).some((relation) => relation.target.layerId === layerId
    && (relation.target.property === "transform.x" || relation.target.property === "transform.y"));
}
function hasBehaviorTransformAuthority(motion: MotionDocument, layerId: string): boolean {
  return (motion.behaviors?.bindings ?? []).some((binding) => binding.targetLayerId === layerId);
}
function hasRelationAuthority(motion: MotionDocument, layerId: string): boolean {
  return (motion.relations?.bindings ?? []).some((binding) => binding.source.layerId === layerId || binding.target.layerId === layerId);
}
function activeAcross(layer: MotionLayer, atMs: readonly number[], documentDurationMs: number): boolean {
  const start = layer.startMs ?? 0, end = start + (layer.durationMs ?? documentDurationMs);
  return Number.isFinite(start) && Number.isFinite(end) && atMs.every((time) => time >= start && time < end);
}
function baseXY(layer: MotionLayer): { x: number; y: number } {
  const x = layer.transform?.x ?? 0, y = layer.transform?.y ?? 0;
  if (![x, y].every((value) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_MOTION_RELATION_COORDINATE)) {
    throw new Error(`Provider-anchor target ${layer.id} has an invalid base transform.`);
  }
  return { x: normalizeZero(x), y: normalizeZero(y) };
}
function subtractQ1024(anchor: number, offset: number, axis: string): number {
  const result = anchor - offset;
  if (!Number.isSafeInteger(result) || Math.abs(result) > MAX_RENDER_DELIVERY_ANCHOR_COORDINATE_Q1024 * 2) {
    throw new Error(`Provider-anchor ${axis} subtraction exceeds the admitted Q1024 range.`);
  }
  const pixels = result / 1024;
  if (!Number.isFinite(pixels) || Math.abs(pixels) > MAX_MOTION_RELATION_COORDINATE) {
    throw new Error(`Provider-anchor ${axis} lowering exceeds the Motion coordinate range.`);
  }
  return normalizeZero(pixels);
}
function keyframeAt(atMs: number, value: number): { readonly atMs: number; readonly value: number; readonly easing: "linear" } { return { atMs, value, easing: "linear" }; }

function inspectionBinding(inspection: ImportedRenderDeliveryAnchorInspection): RenderDeliveryAnchorKeyframeIntentPlan["inspection"] {
  const { fingerprint, package: packageIdentity, receiptFingerprint, delivery, anchorAsset } = inspection;
  return { fingerprint, package: packageIdentity, receiptFingerprint, delivery, anchorAsset };
}
function normalizeZero(value: number): number { return Object.is(value, -0) ? 0 : value; }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }
