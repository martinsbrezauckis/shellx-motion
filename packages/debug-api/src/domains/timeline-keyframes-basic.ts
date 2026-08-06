/** Point, range-delete, move, and easing keyframe mutations. */
import {
  applyLayerKeyframeEasing,
  deleteLayerKeyframe,
  deleteLayerKeyframeRange,
  isSupportedEasing,
  moveLayerKeyframe,
  readSupportedKeyframeTarget,
  timelineLayerLockedTrackId,
  upsertLayerKeyframe,
  type MotionDocument,
  type MotionLayer,
  type MotionPackage
} from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { easingArg, nonNegativeNumberArg, objectArg, stringArg } from "./args.js";
import { easingToken } from "@shellx-motion/core";
import {
  commitAtomicTimelineMutation,
  isTimelineCommonEditResult,
  readTimelineCommonEditArgs,
  type TimelinePackageEditServices
} from "./timeline-package-edit.js";

export interface TimelineKeyframesBasicServices extends TimelinePackageEditServices {}

type LayerEdit = { layer: MotionLayer };

export async function dispatchTimelineKeyframesBasicCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: TimelineKeyframesBasicServices
): Promise<MotionDebugResult | null> {
  if (command === "motion.timeline.keyframe.upsert") return upsert(args, services);
  if (command === "motion.timeline.keyframe.delete") return remove(args, services);
  if (command === "motion.timeline.keyframe.range.delete") return removeRange(args, services);
  if (command === "motion.timeline.keyframe.move") return move(args, services);
  if (command === "motion.timeline.keyframe.easing.apply") return applyEasing(args, services);
  return null;
}

async function upsert(args: unknown, services: TimelineKeyframesBasicServices): Promise<MotionDebugResult> {
  const base = baseArgs("motion.timeline.keyframe.upsert", args, services);
  if (isResult(base)) return base;
  const atMs = nonNegativeNumberArg(args, "atMs");
  const value = keyframeValueArg(args, "value");
  const easingArgValue = easingArg(args, "easing");
  if (atMs === null || atMs === false) return invalidArgs("atMs must be a non-negative number.");
  if (value === null || value === false) return invalidArgs("value must be a finite number or supported color string.");
  if (easingArgValue === false) return invalidArgs("Unsupported keyframe easing.");
  const easing = easingArgValue ?? undefined;
  if (easing !== undefined && !isSupportedEasing(easing)) return invalidArgs(`Unsupported keyframe easing: ${easingToken(easing)}.`);
  const inputFacts = { layerId: base.layerId, target: base.targetArg, atMs, value, ...(easing ? { easing } : {}) };
  return execute({
    ...base,
    inputFacts,
    command: "motion.timeline.keyframe.upsert",
    receiptPrefix: "timeline-keyframe-upsert",
    receiptFileName: "timeline-keyframe-upsert.receipt.json",
    failureCode: "timeline_keyframe_upsert_failed",
    services,
    edit: (layer) => upsertLayerKeyframe(layer, { target: base.target, atMs, value, ...(easing ? { easing } : {}) }),
    outputFacts: (edit) => ({ ...inputFacts, changedPath: edit.changedPath, action: edit.action }),
    visibleFacts: (edit) => ({ layerId: base.layerId, target: base.targetArg, atMs, action: edit.action, changedPath: edit.changedPath })
  });
}

async function remove(args: unknown, services: TimelineKeyframesBasicServices): Promise<MotionDebugResult> {
  const base = baseArgs("motion.timeline.keyframe.delete", args, services);
  if (isResult(base)) return base;
  const atMs = nonNegativeNumberArg(args, "atMs");
  if (atMs === null || atMs === false) return invalidArgs("atMs must be a non-negative number.");
  const inputFacts = { layerId: base.layerId, target: base.targetArg, atMs };
  return execute({
    ...base,
    inputFacts,
    command: "motion.timeline.keyframe.delete",
    receiptPrefix: "timeline-keyframe-delete",
    receiptFileName: "timeline-keyframe-delete.receipt.json",
    failureCode: "timeline_keyframe_delete_failed",
    services,
    edit: (layer) => deleteLayerKeyframe(layer, { target: base.target, atMs }),
    outputFacts: (edit) => ({ ...inputFacts, changedPath: edit.changedPath, action: edit.action, removed: edit.removed, remainingCount: edit.remainingCount }),
    visibleFacts: (edit) => ({ ...inputFacts, action: edit.action, changedPath: edit.changedPath })
  });
}

async function removeRange(args: unknown, services: TimelineKeyframesBasicServices): Promise<MotionDebugResult> {
  const base = baseArgs("motion.timeline.keyframe.range.delete", args, services);
  if (isResult(base)) return base;
  const startMs = nonNegativeNumberArg(args, "startMs");
  const endMs = nonNegativeNumberArg(args, "endMs");
  if (startMs === false) return invalidArgs("startMs must be a non-negative number.");
  if (endMs === false) return invalidArgs("endMs must be a non-negative number.");
  const inputFacts = { layerId: base.layerId, target: base.targetArg, ...(startMs !== null ? { startMs } : {}), ...(endMs !== null ? { endMs } : {}) };
  return execute({
    ...base,
    inputFacts,
    command: "motion.timeline.keyframe.range.delete",
    receiptPrefix: "timeline-keyframe-range-delete",
    receiptFileName: "timeline-keyframe-range-delete.receipt.json",
    failureCode: "timeline_keyframe_range_delete_failed",
    services,
    edit: (layer) => deleteLayerKeyframeRange(layer, { target: base.target, ...(startMs !== null ? { startMs } : {}), ...(endMs !== null ? { endMs } : {}) }),
    outputFacts: (edit) => ({ ...inputFacts, changedPaths: edit.changedPaths, action: edit.action, deletedCount: edit.removedKeyframes.length, removedKeyframes: edit.removedKeyframes, remainingCount: edit.remainingCount }),
    visibleFacts: (edit) => ({ ...inputFacts, action: edit.action, deletedCount: edit.removedKeyframes.length, remainingCount: edit.remainingCount, changedPaths: edit.changedPaths })
  });
}

async function move(args: unknown, services: TimelineKeyframesBasicServices): Promise<MotionDebugResult> {
  const base = baseArgs("motion.timeline.keyframe.move", args, services);
  if (isResult(base)) return base;
  const fromMs = nonNegativeNumberArg(args, "fromMs");
  const toMs = nonNegativeNumberArg(args, "toMs");
  if (fromMs === null || fromMs === false) return invalidArgs("fromMs must be a non-negative number.");
  if (toMs === null || toMs === false) return invalidArgs("toMs must be a non-negative number.");
  const inputFacts = { layerId: base.layerId, target: base.targetArg, fromMs, toMs };
  return execute({
    ...base,
    inputFacts,
    command: "motion.timeline.keyframe.move",
    receiptPrefix: "timeline-keyframe-move",
    receiptFileName: "timeline-keyframe-move.receipt.json",
    failureCode: "timeline_keyframe_move_failed",
    services,
    edit: (layer) => moveLayerKeyframe(layer, { target: base.target, fromMs, toMs }),
    outputFacts: (edit) => ({ ...inputFacts, changedPaths: edit.changedPaths, action: edit.action, previousKeyframe: edit.previousKeyframe, keyframe: edit.keyframe }),
    visibleFacts: (edit) => ({ ...inputFacts, action: edit.action, changedPaths: edit.changedPaths })
  });
}

async function applyEasing(args: unknown, services: TimelineKeyframesBasicServices): Promise<MotionDebugResult> {
  const base = baseArgs("motion.timeline.keyframe.easing.apply", args, services);
  if (isResult(base)) return base;
  const easingArgValue = easingArg(args, "easing");
  const atMs = nonNegativeNumberArg(args, "atMs");
  const startMs = nonNegativeNumberArg(args, "startMs");
  const endMs = nonNegativeNumberArg(args, "endMs");
  if (easingArgValue === null) return invalidArgs("motion.timeline.keyframe.easing.apply requires easing.");
  if (easingArgValue === false) return invalidArgs("Unsupported keyframe easing.");
  const easing = easingArgValue;
  if (!isSupportedEasing(easing)) return invalidArgs(`Unsupported keyframe easing: ${easingToken(easing)}.`);
  if (atMs === false) return invalidArgs("atMs must be a non-negative number.");
  if (startMs === false) return invalidArgs("startMs must be a non-negative number.");
  if (endMs === false) return invalidArgs("endMs must be a non-negative number.");
  const inputFacts = { layerId: base.layerId, target: base.targetArg, easing, ...(atMs !== null ? { atMs } : {}), ...(startMs !== null ? { startMs } : {}), ...(endMs !== null ? { endMs } : {}) };
  return execute({
    ...base,
    inputFacts,
    command: "motion.timeline.keyframe.easing.apply",
    receiptPrefix: "timeline-keyframe-easing-apply",
    receiptFileName: "timeline-keyframe-easing-apply.receipt.json",
    failureCode: "timeline_keyframe_easing_apply_failed",
    services,
    edit: (layer) => applyLayerKeyframeEasing(layer, { target: base.target, easing, ...(atMs !== null ? { atMs } : {}), ...(startMs !== null ? { startMs } : {}), ...(endMs !== null ? { endMs } : {}) }),
    outputFacts: (edit) => ({ ...inputFacts, changedPaths: edit.changedPaths, action: edit.action, updatedCount: edit.updatedKeyframes.length, updatedKeyframes: edit.updatedKeyframes }),
    resultFacts: (edit) => ({ ...inputFacts, ...layerEditFacts(edit) }),
    visibleFacts: (edit) => ({ ...inputFacts, action: edit.action, updatedCount: edit.updatedKeyframes.length, changedPaths: edit.changedPaths })
  });
}

interface BaseArgs {
  packageRoot: string;
  outDir: string;
  receiptsRoot?: string;
  createdBy?: string;
  layerId: string;
  targetArg: string;
  target: NonNullable<ReturnType<typeof readSupportedKeyframeTarget>>;
}

function baseArgs(command: MotionDebugCommand, args: unknown, services: TimelineKeyframesBasicServices): BaseArgs | MotionDebugResult {
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

function execute<T extends LayerEdit>(input: BaseArgs & {
  command: MotionDebugCommand;
  receiptPrefix: string;
  receiptFileName: string;
  failureCode: string;
  services: TimelineKeyframesBasicServices;
  inputFacts: Record<string, unknown>;
  edit: (layer: MotionLayer) => T;
  outputFacts: (edit: T) => Record<string, unknown>;
  resultFacts?: (edit: T) => Record<string, unknown>;
  visibleFacts: (edit: T) => Record<string, unknown>;
}): Promise<MotionDebugResult> {
  return commitAtomicTimelineMutation<T & { motion: MotionDocument }>({
    packageRoot: input.packageRoot,
    outDir: input.outDir,
    ...(input.receiptsRoot ? { receiptsRoot: input.receiptsRoot } : {}),
    ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    command: input.command,
    receiptPrefix: input.receiptPrefix,
    receiptFileName: input.receiptFileName,
    failureCode: input.failureCode,
    services: input.services,
    invalidCode: "timeline_keyframe_invalid",
    mutate: (pkg) => mutateLayer(pkg, input.layerId, input.edit),
    outputFacts: (mutation) => input.outputFacts(mutation),
    resultFacts: (mutation) => input.resultFacts ? input.resultFacts(mutation) : layerEditFacts(mutation),
    visibleFacts: (mutation) => input.visibleFacts(mutation)
  });
}

function mutateLayer<T extends LayerEdit>(pkg: MotionPackage, layerId: string, edit: (layer: MotionLayer) => T): T & { motion: MotionDocument } {
  const layerIndex = pkg.motion.layers.findIndex((layer) => layer.id === layerId);
  if (layerIndex === -1) throw new Error(`Motion layer not found: ${layerId}.`);
  const layer = pkg.motion.layers[layerIndex];
  const lockedTrackId = timelineLayerLockedTrackId(pkg.motion, layer);
  if (lockedTrackId) throw new Error(`Cannot edit layer on locked track: ${lockedTrackId}.`);
  const edited = edit(layer);
  return {
    ...edited,
    motion: { ...pkg.motion, layers: pkg.motion.layers.map((candidate, index) => index === layerIndex ? edited.layer : candidate) }
  };
}

function layerEditFacts<T extends LayerEdit>(edit: T): Record<string, unknown> {
  const { ...facts } = edit;
  return facts;
}

function keyframeValueArg(args: unknown, key: string): string | number | false | null {
  const record = objectArg(args);
  if (!record || !Object.hasOwn(record, key)) return null;
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return false;
}

function isResult(value: BaseArgs | MotionDebugResult): value is MotionDebugResult {
  return "ok" in value;
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}
