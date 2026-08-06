/** Bulk keyframe transforms and animation-preset application. */
import {
  applyLayerAnimationPreset,
  applyLayerGroupAnimationPreset,
  distributeLayerKeyframes,
  duplicateLayerKeyframes,
  easingToken,
  isSupportedEasing,
  readMotionAnimationPreset,
  readSupportedKeyframeTarget,
  reverseLayerKeyframes,
  scaleLayerKeyframes,
  shiftLayerKeyframes,
  snapLayerKeyframes,
  timelineLayerLockedTrackId,
  type MotionDocument,
  type MotionEasing,
  type MotionLayer,
  type MotionPackage
} from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { unsupportedEnumValue } from "./enum-error.js";
import { easingArg, finiteNumberArg, nonNegativeNumberArg, objectArg, positiveNumberArg, stringArg, stringArrayArg } from "./args.js";
import {
  commitAtomicTimelineMutation,
  isTimelineCommonEditResult,
  readTimelineCommonEditArgs,
  type TimelinePackageEditServices
} from "./timeline-package-edit.js";

export interface TimelineKeyframesBulkServices extends TimelinePackageEditServices {}

type LayerEdit = { layer: MotionLayer };

export async function dispatchTimelineKeyframesBulkCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: TimelineKeyframesBulkServices
): Promise<MotionDebugResult | null> {
  if (command === "motion.timeline.keyframe.shift") return shift(args, services);
  if (command === "motion.timeline.keyframe.scale") return scale(args, services);
  if (command === "motion.timeline.keyframe.duplicate") return duplicate(args, services);
  if (command === "motion.timeline.keyframe.distribute") return distribute(args, services);
  if (command === "motion.timeline.keyframe.reverse") return reverse(args, services);
  if (command === "motion.timeline.keyframe.snap") return snap(args, services);
  if (command === "motion.timeline.animation.preset.apply") return applyPreset(args, services);
  return null;
}

async function shift(args: unknown, services: TimelineKeyframesBulkServices): Promise<MotionDebugResult> {
  const base = baseArgs("motion.timeline.keyframe.shift", args, services);
  if (isResult(base)) return base;
  const deltaMs = finiteNumberArg(args, "deltaMs");
  const range = rangeArgs(args);
  if (deltaMs === null || deltaMs === false || deltaMs === 0) return invalidArgs("deltaMs must be a finite non-zero number.");
  if (isResult(range)) return range;
  const inputFacts = { layerId: base.layerId, target: base.targetArg, deltaMs, ...range };
  return executeLayer({
    ...base, command: "motion.timeline.keyframe.shift", receiptPrefix: "timeline-keyframe-shift",
    receiptFileName: "timeline-keyframe-shift.receipt.json", failureCode: "timeline_keyframe_shift_failed", services,
    edit: (layer) => shiftLayerKeyframes(layer, { target: base.target, deltaMs, ...range }),
    outputFacts: (edit) => ({ ...inputFacts, changedPaths: edit.changedPaths, action: edit.action, shiftedCount: edit.shiftedKeyframes.length, shiftedKeyframes: edit.shiftedKeyframes }),
    resultFacts: (edit) => ({ ...inputFacts, ...editFacts(edit) }),
    visibleFacts: (edit) => ({ ...inputFacts, action: edit.action, shiftedCount: edit.shiftedKeyframes.length, changedPaths: edit.changedPaths })
  });
}

async function scale(args: unknown, services: TimelineKeyframesBulkServices): Promise<MotionDebugResult> {
  const base = baseArgs("motion.timeline.keyframe.scale", args, services);
  if (isResult(base)) return base;
  const scaleValue = finiteNumberArg(args, "scale");
  const originMs = nonNegativeNumberArg(args, "originMs");
  const range = rangeArgs(args);
  if (scaleValue === null || scaleValue === false || scaleValue <= 0 || scaleValue === 1) return invalidArgs("scale must be a positive finite number other than 1.");
  if (originMs === null || originMs === false) return invalidArgs("originMs must be a non-negative number.");
  if (isResult(range)) return range;
  const inputFacts = { layerId: base.layerId, target: base.targetArg, scale: scaleValue, originMs, ...range };
  return executeLayer({
    ...base, command: "motion.timeline.keyframe.scale", receiptPrefix: "timeline-keyframe-scale",
    receiptFileName: "timeline-keyframe-scale.receipt.json", failureCode: "timeline_keyframe_scale_failed", services,
    edit: (layer) => scaleLayerKeyframes(layer, { target: base.target, scale: scaleValue, originMs, ...range }),
    outputFacts: (edit) => ({ ...inputFacts, changedPaths: edit.changedPaths, action: edit.action, scaledCount: edit.scaledKeyframes.length, scaledKeyframes: edit.scaledKeyframes }),
    resultFacts: (edit) => ({ ...inputFacts, ...editFacts(edit) }),
    visibleFacts: (edit) => ({ ...inputFacts, action: edit.action, scaledCount: edit.scaledKeyframes.length, changedPaths: edit.changedPaths })
  });
}

async function duplicate(args: unknown, services: TimelineKeyframesBulkServices): Promise<MotionDebugResult> {
  const base = baseArgs("motion.timeline.keyframe.duplicate", args, services);
  if (isResult(base)) return base;
  const deltaMs = finiteNumberArg(args, "deltaMs");
  const range = rangeArgs(args);
  if (deltaMs === null || deltaMs === false || deltaMs === 0) return invalidArgs("deltaMs must be a finite non-zero number.");
  if (isResult(range)) return range;
  const inputFacts = { layerId: base.layerId, target: base.targetArg, deltaMs, ...range };
  return executeLayer({
    ...base, command: "motion.timeline.keyframe.duplicate", receiptPrefix: "timeline-keyframe-duplicate",
    receiptFileName: "timeline-keyframe-duplicate.receipt.json", failureCode: "timeline_keyframe_duplicate_failed", services,
    edit: (layer) => duplicateLayerKeyframes(layer, { target: base.target, deltaMs, ...range }),
    outputFacts: (edit) => ({ ...inputFacts, changedPaths: edit.changedPaths, action: edit.action, duplicatedCount: edit.duplicatedKeyframes.length, duplicatedKeyframes: edit.duplicatedKeyframes }),
    resultFacts: (edit) => ({ ...inputFacts, ...editFacts(edit) }),
    visibleFacts: (edit) => ({ ...inputFacts, action: edit.action, duplicatedCount: edit.duplicatedKeyframes.length, changedPaths: edit.changedPaths })
  });
}

async function distribute(args: unknown, services: TimelineKeyframesBulkServices): Promise<MotionDebugResult> {
  const base = baseArgs("motion.timeline.keyframe.distribute", args, services);
  if (isResult(base)) return base;
  const range = rangeArgs(args);
  if (isResult(range)) return range;
  return executeLayer({
    ...base, command: "motion.timeline.keyframe.distribute", receiptPrefix: "timeline-keyframe-distribute",
    receiptFileName: "timeline-keyframe-distribute.receipt.json", failureCode: "timeline_keyframe_distribute_failed", services,
    edit: (layer) => distributeLayerKeyframes(layer, { target: base.target, ...range }),
    outputFacts: (edit) => ({ layerId: base.layerId, target: base.targetArg, startMs: edit.startMs, endMs: edit.endMs, spacingMs: edit.spacingMs, changedPaths: edit.changedPaths, action: edit.action, distributedCount: edit.distributedKeyframes.length, distributedKeyframes: edit.distributedKeyframes }),
    resultFacts: editFacts,
    visibleFacts: (edit) => ({ layerId: base.layerId, target: base.targetArg, startMs: edit.startMs, endMs: edit.endMs, spacingMs: edit.spacingMs, action: edit.action, distributedCount: edit.distributedKeyframes.length, changedPaths: edit.changedPaths })
  });
}

async function reverse(args: unknown, services: TimelineKeyframesBulkServices): Promise<MotionDebugResult> {
  const base = baseArgs("motion.timeline.keyframe.reverse", args, services);
  if (isResult(base)) return base;
  const range = rangeArgs(args);
  if (isResult(range)) return range;
  return executeLayer({
    ...base, command: "motion.timeline.keyframe.reverse", receiptPrefix: "timeline-keyframe-reverse",
    receiptFileName: "timeline-keyframe-reverse.receipt.json", failureCode: "timeline_keyframe_reverse_failed", services,
    edit: (layer) => reverseLayerKeyframes(layer, { target: base.target, ...range }),
    outputFacts: (edit) => ({ layerId: base.layerId, target: base.targetArg, startMs: edit.startMs, endMs: edit.endMs, changedPaths: edit.changedPaths, action: edit.action, reversedCount: edit.reversedKeyframes.length, reversedKeyframes: edit.reversedKeyframes }),
    resultFacts: editFacts,
    visibleFacts: (edit) => ({ layerId: base.layerId, target: base.targetArg, startMs: edit.startMs, endMs: edit.endMs, action: edit.action, reversedCount: edit.reversedKeyframes.length, changedPaths: edit.changedPaths })
  });
}

async function snap(args: unknown, services: TimelineKeyframesBulkServices): Promise<MotionDebugResult> {
  const base = baseArgs("motion.timeline.keyframe.snap", args, services);
  if (isResult(base)) return base;
  const fpsArg = positiveNumberArg(args, "fps");
  const modeArg = stringArg(args, "mode");
  const mode = snapMode(modeArg);
  const range = rangeArgs(args);
  if (fpsArg === false) return invalidArgs("fps must be a positive number.");
  if (mode === false) return unsupportedEnumValue("keyframe snap mode", modeArg, "keyframeSnapMode");
  if (isResult(range)) return range;
  return executeLayer({
    ...base, command: "motion.timeline.keyframe.snap", receiptPrefix: "timeline-keyframe-snap",
    receiptFileName: "timeline-keyframe-snap.receipt.json", failureCode: "timeline_keyframe_snap_failed", services,
    edit: (layer, pkg) => snapLayerKeyframes(layer, { target: base.target, fps: fpsArg ?? pkg.motion.fps, ...(mode ? { mode } : {}), ...range }),
    outputFacts: (edit) => ({ layerId: base.layerId, target: base.targetArg, fps: edit.fps, mode: edit.mode, ...(edit.startMs !== undefined ? { startMs: edit.startMs } : {}), ...(edit.endMs !== undefined ? { endMs: edit.endMs } : {}), changedPaths: edit.changedPaths, action: edit.action, snappedCount: edit.snappedKeyframes.length, snappedKeyframes: edit.snappedKeyframes }),
    resultFacts: editFacts,
    visibleFacts: (edit) => ({ layerId: base.layerId, target: base.targetArg, fps: edit.fps, mode: edit.mode, ...(edit.startMs !== undefined ? { startMs: edit.startMs } : {}), ...(edit.endMs !== undefined ? { endMs: edit.endMs } : {}), action: edit.action, snappedCount: edit.snappedKeyframes.length, changedPaths: edit.changedPaths })
  });
}

async function applyPreset(args: unknown, services: TimelineKeyframesBulkServices): Promise<MotionDebugResult> {
  const common = readTimelineCommonEditArgs("motion.timeline.animation.preset.apply", args, services);
  if (isTimelineCommonEditResult(common)) return common;
  const layerId = stringArg(args, "layerId") ?? stringArg(args, "layer");
  const layerIds = stringArrayArg(args, "layerIds") ?? stringArrayArg(args, "layers");
  const selectedLayerIds = layerIds ?? (layerId ? [layerId] : []);
  const presetArg = stringArg(args, "preset");
  const preset = presetArg ? readMotionAnimationPreset(presetArg) : null;
  const startMs = nonNegativeNumberArg(args, "startMs");
  const durationMs = finiteNumberArg(args, "durationMs");
  const distancePx = finiteNumberArg(args, "distancePx");
  const staggerMs = nonNegativeNumberArg(args, "staggerMs");
  const easingArgValue = easingArg(args, "easing");
  if (selectedLayerIds.length === 0) return invalidArgs("motion.timeline.animation.preset.apply requires layerId or layerIds.");
  if (!presetArg) return invalidArgs("motion.timeline.animation.preset.apply requires preset.");
  if (!preset) return unsupportedEnumValue("animation preset", presetArg, "animationPreset");
  if (startMs === false) return invalidArgs("startMs must be a non-negative number.");
  if (durationMs === false) return invalidArgs("durationMs must be a finite number.");
  if (distancePx === false) return invalidArgs("distancePx must be a finite number.");
  if (staggerMs === false) return invalidArgs("staggerMs must be a non-negative number.");
  if (easingArgValue === false) return invalidArgs("Unsupported animation preset easing.");
  const easing = easingArgValue ?? undefined;
  if (easing !== undefined && !isSupportedEasing(easing)) return invalidArgs(`Unsupported animation preset easing: ${easingToken(easing)}.`);
  const group = layerIds !== null;
  return commitAtomicTimelineMutation({
    ...common, command: "motion.timeline.animation.preset.apply", receiptPrefix: "timeline-animation-preset-apply",
    receiptFileName: "timeline-animation-preset-apply.receipt.json", invalidCode: "timeline_animation_preset_invalid",
    failureCode: "timeline_animation_preset_apply_failed", services,
    mutate: (pkg) => applyPresetMutation(pkg, { selectedLayerIds, group, preset, startMs, durationMs, distancePx, staggerMs, easing }),
    outputFacts: (applied) => applied.output,
    resultFacts: (applied) => applied.result,
    visibleFacts: (applied) => applied.visible
  });
}

interface BaseArgs {
  packageRoot: string; outDir: string; receiptsRoot?: string; createdBy?: string;
  layerId: string; targetArg: string; target: NonNullable<ReturnType<typeof readSupportedKeyframeTarget>>;
}

function baseArgs(command: MotionDebugCommand, args: unknown, services: TimelineKeyframesBulkServices): BaseArgs | MotionDebugResult {
  const common = readTimelineCommonEditArgs(command, args, services);
  if (isTimelineCommonEditResult(common)) return common;
  const layerId = stringArg(args, "layerId") ?? stringArg(args, "layer");
  const targetArg = stringArg(args, "target");
  if (!layerId) return invalidArgs(`${command} requires layerId.`);
  if (!targetArg) return invalidArgs(`${command} requires target.`);
  const target = readSupportedKeyframeTarget(targetArg);
  if (!target) return invalidArgs(`Unsupported keyframe target: ${targetArg}.`);
  return { ...common, layerId, targetArg, target };
}

function executeLayer<T extends LayerEdit>(input: BaseArgs & {
  command: MotionDebugCommand; receiptPrefix: string; receiptFileName: string; failureCode: string;
  services: TimelineKeyframesBulkServices; edit: (layer: MotionLayer, pkg: MotionPackage) => T;
  outputFacts: (edit: T) => Record<string, unknown>; resultFacts: (edit: T) => Record<string, unknown>;
  visibleFacts: (edit: T) => Record<string, unknown>;
}): Promise<MotionDebugResult> {
  return commitAtomicTimelineMutation<T & { motion: MotionDocument }>({
    packageRoot: input.packageRoot, outDir: input.outDir,
    ...(input.receiptsRoot ? { receiptsRoot: input.receiptsRoot } : {}), ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    command: input.command, receiptPrefix: input.receiptPrefix, receiptFileName: input.receiptFileName,
    invalidCode: "timeline_keyframe_invalid", failureCode: input.failureCode, services: input.services,
    mutate: (pkg) => mutateLayer(pkg, input.layerId, input.edit),
    outputFacts: (mutation) => input.outputFacts(mutation), resultFacts: (mutation) => input.resultFacts(mutation),
    visibleFacts: (mutation) => input.visibleFacts(mutation)
  });
}

function mutateLayer<T extends LayerEdit>(pkg: MotionPackage, layerId: string, edit: (layer: MotionLayer, pkg: MotionPackage) => T): T & { motion: MotionDocument } {
  const index = pkg.motion.layers.findIndex((layer) => layer.id === layerId);
  if (index === -1) throw new Error(`Motion layer not found: ${layerId}.`);
  assertEditable(pkg, pkg.motion.layers[index]);
  const edited = edit(pkg.motion.layers[index], pkg);
  return { ...edited, motion: { ...pkg.motion, layers: pkg.motion.layers.map((layer, candidate) => candidate === index ? edited.layer : layer) } };
}

function applyPresetMutation(pkg: MotionPackage, input: {
  selectedLayerIds: string[]; group: boolean; preset: NonNullable<ReturnType<typeof readMotionAnimationPreset>>;
  startMs: number | null; durationMs: number | null; distancePx: number | null; staggerMs: number | null; easing?: MotionEasing;
}): { motion: MotionDocument; output: Record<string, unknown>; result: Record<string, unknown>; visible: Record<string, unknown> } {
  for (const id of input.selectedLayerIds) {
    const layer = pkg.motion.layers.find((candidate) => candidate.id === id);
    if (!layer) throw new Error(`Motion layer not found: ${id}.`);
    assertEditable(pkg, layer);
  }
  const options = {
    preset: input.preset,
    ...(input.startMs !== null ? { startMs: input.startMs } : {}), ...(input.durationMs !== null ? { durationMs: input.durationMs } : {}),
    ...(input.distancePx !== null ? { distancePx: input.distancePx } : {}), ...(input.easing ? { easing: input.easing } : {})
  };
  if (input.group) {
    const applied = applyLayerGroupAnimationPreset(pkg.motion.layers, { ...options, layerIds: input.selectedLayerIds, ...(input.staggerMs !== null ? { staggerMs: input.staggerMs } : {}) });
    return {
      motion: { ...pkg.motion, layers: applied.layers },
      output: { layerIds: input.selectedLayerIds, ...options, staggerMs: applied.staggerMs, changedPaths: applied.changedPaths, action: applied.action, applications: applied.applications },
      result: { layerIds: input.selectedLayerIds, changedPaths: applied.changedPaths, action: applied.action, preset: applied.preset, staggerMs: applied.staggerMs, applications: applied.applications },
      visible: { layerIds: input.selectedLayerIds, preset: input.preset, staggerMs: applied.staggerMs, action: applied.action, applications: applied.applications, changedPaths: applied.changedPaths }
    };
  }
  const index = pkg.motion.layers.findIndex((layer) => layer.id === input.selectedLayerIds[0]);
  const applied = applyLayerAnimationPreset(pkg.motion.layers[index], options);
  return {
    motion: { ...pkg.motion, layers: pkg.motion.layers.map((layer, candidate) => candidate === index ? applied.layer : layer) },
    output: { layerId: input.selectedLayerIds[0], ...options, changedPaths: applied.changedPaths, action: applied.action, timing: applied.timing, appliedKeyframes: applied.appliedKeyframes },
    result: { changedPaths: applied.changedPaths, action: applied.action, preset: applied.preset, timing: applied.timing, appliedKeyframes: applied.appliedKeyframes, layer: applied.layer },
    visible: { layerId: input.selectedLayerIds[0], preset: input.preset, action: applied.action, timing: applied.timing, changedPaths: applied.changedPaths }
  };
}

function assertEditable(pkg: MotionPackage, layer: MotionLayer): void {
  const lockedTrackId = timelineLayerLockedTrackId(pkg.motion, layer);
  if (lockedTrackId) throw new Error(`Cannot edit layer on locked track: ${lockedTrackId}.`);
}

function rangeArgs(args: unknown): { startMs?: number; endMs?: number } | MotionDebugResult {
  const startMs = nonNegativeNumberArg(args, "startMs");
  const endMs = nonNegativeNumberArg(args, "endMs");
  if (startMs === false) return invalidArgs("startMs must be a non-negative number.");
  if (endMs === false) return invalidArgs("endMs must be a non-negative number.");
  return { ...(startMs !== null ? { startMs } : {}), ...(endMs !== null ? { endMs } : {}) };
}

function snapMode(value: string | null): "nearest" | "floor" | "ceil" | false | null {
  if (value === null) return null;
  return value === "nearest" || value === "floor" || value === "ceil" ? value : false;
}

function editFacts<T extends LayerEdit>(edit: T): Record<string, unknown> { return { ...edit }; }
function isResult(value: object): value is MotionDebugResult { return "ok" in value; }
function invalidArgs(message: string): MotionDebugResult { return { ok: false, error: { code: "invalid_args", message }, warnings: [] }; }
