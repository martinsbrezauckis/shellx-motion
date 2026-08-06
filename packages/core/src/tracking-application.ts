import type { MotionDocument, MotionKeyframe, MotionKeyframeTarget, MotionLayer } from "./types";
import { STABILIZATION_PLAN_SCHEMA, type TrackingStabilizationPlan } from "./tracking-analysis";

export const TRACKING_STABILIZATION_ATTACHMENT_SCHEMA = "shellx-motion/tracking-stabilization-attachment@1" as const;
const ATTACHMENT_KEY = "x-tracking-stabilization" as const;
const TARGETS = ["transform.x", "transform.y", "transform.scale", "transform.rotation"] as const;
type StabilizationTarget = typeof TARGETS[number];

export interface TrackingStabilizationAttachment {
  schema: typeof TRACKING_STABILIZATION_ATTACHMENT_SCHEMA;
  analysisId: string;
  sourceSha256: string;
  targetLayerId: string;
  segmentIndex: number;
  segmentStartMs: number;
  segmentEndMs: number;
  fidelity: TrackingStabilizationPlan["fidelity"];
  previousKeyframes: Partial<Record<StabilizationTarget, MotionKeyframe[] | null>>;
  appliedKeyframes: Record<StabilizationTarget, MotionKeyframe[]>;
}

export interface TrackingStabilizationMutation {
  motion: MotionDocument;
  layerId: string;
  analysisId: string;
  segmentIndex: number;
  changedPaths: string[];
  attachment: TrackingStabilizationAttachment;
}

export function applyTrackingStabilization(input: {
  motion: MotionDocument;
  plan: TrackingStabilizationPlan;
  segmentIndex?: number;
}): TrackingStabilizationMutation {
  validatePlan(input.plan);
  const motion = structuredClone(input.motion);
  const layer = motion.layers.find((candidate) => candidate.id === input.plan.targetLayerId);
  if (!layer) throw new Error(`Tracking stabilization target layer does not exist: ${input.plan.targetLayerId}.`);
  if (layer.locked === true) throw new Error(`Tracking stabilization target layer is locked: ${layer.id}.`);
  if (readAttachment(layer)) throw new Error(`Tracking stabilization is already attached to layer: ${layer.id}.`);
  if (input.plan.status === "partial" && input.segmentIndex === undefined) {
    throw new Error("Partial tracking stabilization requires an explicit confidence-qualified segmentIndex.");
  }
  const segmentIndex = input.segmentIndex ?? 0;
  if (!Number.isSafeInteger(segmentIndex) || segmentIndex < 0 || segmentIndex >= input.plan.segments.length) {
    throw new Error("Tracking stabilization segmentIndex is out of range.");
  }
  const segment = input.plan.segments[segmentIndex];
  const previousKeyframes: TrackingStabilizationAttachment["previousKeyframes"] = {};
  const appliedKeyframes = {} as Record<StabilizationTarget, MotionKeyframe[]>;
  layer.keyframes ??= {};
  for (const target of TARGETS) {
    const prior = layer.keyframes[target];
    previousKeyframes[target] = prior ? structuredClone(prior) : null;
    appliedKeyframes[target] = structuredClone(segment.keyframes[target]);
    layer.keyframes[target] = structuredClone(segment.keyframes[target]);
  }
  const attachment: TrackingStabilizationAttachment = {
    schema: TRACKING_STABILIZATION_ATTACHMENT_SCHEMA,
    analysisId: input.plan.analysisId,
    sourceSha256: input.plan.sourceSha256,
    targetLayerId: layer.id,
    segmentIndex,
    segmentStartMs: segment.startMs,
    segmentEndMs: segment.endMs,
    fidelity: input.plan.fidelity,
    previousKeyframes,
    appliedKeyframes,
  };
  layer[ATTACHMENT_KEY] = attachment;
  return {
    motion,
    layerId: layer.id,
    analysisId: input.plan.analysisId,
    segmentIndex,
    changedPaths: [...TARGETS.map((target) => `/layers/${motion.layers.indexOf(layer)}/keyframes/${escapePointer(target)}`), `/layers/${motion.layers.indexOf(layer)}/${ATTACHMENT_KEY}`],
    attachment: structuredClone(attachment),
  };
}

export function detachTrackingStabilization(input: {
  motion: MotionDocument;
  layerId: string;
}): TrackingStabilizationMutation {
  const motion = structuredClone(input.motion);
  const layer = motion.layers.find((candidate) => candidate.id === input.layerId);
  if (!layer) throw new Error(`Tracking stabilization target layer does not exist: ${input.layerId}.`);
  if (layer.locked === true) throw new Error(`Tracking stabilization target layer is locked: ${layer.id}.`);
  const attachment = readAttachment(layer);
  if (!attachment) throw new Error(`Tracking stabilization is not attached to layer: ${layer.id}.`);
  layer.keyframes ??= {};
  for (const target of TARGETS) {
    const prior = attachment.previousKeyframes[target];
    if (prior === null || prior === undefined) delete layer.keyframes[target];
    else layer.keyframes[target] = structuredClone(prior);
  }
  if (Object.keys(layer.keyframes).length === 0) delete layer.keyframes;
  delete layer[ATTACHMENT_KEY];
  return {
    motion,
    layerId: layer.id,
    analysisId: attachment.analysisId,
    segmentIndex: attachment.segmentIndex,
    changedPaths: [...TARGETS.map((target) => `/layers/${motion.layers.indexOf(layer)}/keyframes/${escapePointer(target)}`), `/layers/${motion.layers.indexOf(layer)}/${ATTACHMENT_KEY}`],
    attachment: structuredClone(attachment),
  };
}

export function verifyTrackingStabilization(input: {
  motion: MotionDocument;
  layerId: string;
  analysisId?: string;
  sourceSha256?: string;
}): {
  attached: boolean;
  current: boolean;
  layerId: string;
  analysisId?: string;
  sourceSha256?: string;
  segmentIndex?: number;
  mismatchedTargets: MotionKeyframeTarget[];
  reasons: string[];
} {
  const layer = input.motion.layers.find((candidate) => candidate.id === input.layerId);
  if (!layer) return { attached: false, current: false, layerId: input.layerId, mismatchedTargets: [], reasons: ["target_layer_missing"] };
  const attachment = readAttachment(layer);
  if (!attachment) return { attached: false, current: false, layerId: input.layerId, mismatchedTargets: [], reasons: ["attachment_missing"] };
  const mismatchedTargets = TARGETS.filter((target) => !sameJson(layer.keyframes?.[target], attachment.appliedKeyframes[target]));
  const reasons = [
    ...(input.analysisId && input.analysisId !== attachment.analysisId ? ["analysis_id_mismatch"] : []),
    ...(input.sourceSha256 && input.sourceSha256 !== attachment.sourceSha256 ? ["source_identity_mismatch"] : []),
    ...(mismatchedTargets.length > 0 ? ["generated_keyframes_changed"] : []),
  ];
  return {
    attached: true,
    current: reasons.length === 0,
    layerId: layer.id,
    analysisId: attachment.analysisId,
    sourceSha256: attachment.sourceSha256,
    segmentIndex: attachment.segmentIndex,
    mismatchedTargets,
    reasons,
  };
}

export function readTrackingStabilizationAttachment(layer: MotionLayer): TrackingStabilizationAttachment | null {
  const attachment = readAttachment(layer);
  return attachment ? structuredClone(attachment) : null;
}

function readAttachment(layer: MotionLayer): TrackingStabilizationAttachment | null {
  const value = layer[ATTACHMENT_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const attachment = value as Partial<TrackingStabilizationAttachment>;
  if (
    attachment.schema !== TRACKING_STABILIZATION_ATTACHMENT_SCHEMA
    || typeof attachment.analysisId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(attachment.analysisId)
    || !/^[a-f0-9]{64}$/.test(attachment.sourceSha256 ?? "")
    || attachment.targetLayerId !== layer.id
    || !Number.isSafeInteger(attachment.segmentIndex) || Number(attachment.segmentIndex) < 0
    || !Number.isFinite(attachment.segmentStartMs) || !Number.isFinite(attachment.segmentEndMs) || Number(attachment.segmentEndMs) < Number(attachment.segmentStartMs)
    || !["exact-similarity", "approximated-homography"].includes(attachment.fidelity ?? "")
    || !attachment.previousKeyframes || typeof attachment.previousKeyframes !== "object"
    || !attachment.appliedKeyframes || typeof attachment.appliedKeyframes !== "object"
  ) return null;
  for (const target of TARGETS) {
    const prior = attachment.previousKeyframes[target];
    if (prior !== undefined && prior !== null && !validKeyframes(prior)) return null;
    if (!validKeyframes(attachment.appliedKeyframes[target])) return null;
  }
  return attachment as TrackingStabilizationAttachment;
}

function validatePlan(plan: TrackingStabilizationPlan) {
  if (
    plan.schema !== STABILIZATION_PLAN_SCHEMA
    || typeof plan.analysisId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(plan.analysisId)
    || !/^[a-f0-9]{64}$/.test(plan.sourceSha256)
    || typeof plan.targetLayerId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(plan.targetLayerId)
    || !["ready", "partial"].includes(plan.status)
    || !["exact-similarity", "approximated-homography"].includes(plan.fidelity)
    || !Array.isArray(plan.segments) || plan.segments.length < 1
  ) throw new Error("Tracking stabilization plan is invalid.");
  for (const segment of plan.segments) {
    if (!Number.isFinite(segment.startMs) || !Number.isFinite(segment.endMs) || segment.endMs < segment.startMs) {
      throw new Error("Tracking stabilization segment range is invalid.");
    }
    for (const target of TARGETS) {
      const keyframes = segment.keyframes[target];
      if (!validKeyframes(keyframes)) throw new Error(`Tracking stabilization ${target} keyframes are invalid.`);
    }
  }
}

function validKeyframes(value: unknown): value is MotionKeyframe[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 30_000) return false;
  let previousAtMs = -1;
  for (const keyframe of value) {
    if (
      !keyframe || typeof keyframe !== "object" || Array.isArray(keyframe)
      || !Number.isFinite(keyframe.atMs) || keyframe.atMs < 0 || keyframe.atMs <= previousAtMs
      || typeof keyframe.value !== "number" || !Number.isFinite(keyframe.value)
    ) return false;
    previousAtMs = keyframe.atMs;
  }
  return true;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function escapePointer(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}
