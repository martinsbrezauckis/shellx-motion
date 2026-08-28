/** Layer transition mutations through the shared atomic package-edit executor. */
import {
  applyTransitionPresetToLayer,
  canonicalJsonSha256,
  compileTransitionPreset,
  deleteLayerTransition,
  getTransitionPreset,
  isSupportedEasing,
  listTransitionPresets,
  readSupportedTransitionType,
  timelineLayerLockedTrackId,
  upsertLayerTransition,
  type MotionDocument,
  type MotionLayer,
  type MotionPackage
} from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { unsupportedEnumValue } from "./enum-error.js";
import { nonNegativeNumberArg, positiveNumberArg, stringArg } from "./args.js";
import {
  commitAtomicTimelineMutation,
  isTimelineCommonEditResult,
  readTimelineCommonEditArgs,
  type TimelinePackageEditServices
} from "./timeline-package-edit.js";

export interface TimelineTransitionsServices extends TimelinePackageEditServices {}

export async function dispatchTimelineTransitionsCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: TimelineTransitionsServices
): Promise<MotionDebugResult | null> {
  if (command === "motion.timeline.transition.presets") return presets();
  if (command === "motion.timeline.transition.preset.apply") return applyPreset(args, services);
  if (command === "motion.timeline.transition.upsert") return upsert(args, services);
  if (command === "motion.timeline.transition.delete") return remove(args, services);
  return null;
}

function presets(): MotionDebugResult {
  const values = listTransitionPresets();
  return {
    ok: true,
    receiptId: `timeline-transition-presets-${canonicalJsonSha256(values).slice(0, 16)}`,
    visibleState: { panel: "timeline", operation: "timeline.transition.presets", presetCount: values.length },
    result: { ok: true, defaultPreset: "soft-fade", presets: values },
    warnings: []
  };
}

async function applyPreset(args: unknown, services: TimelineTransitionsServices): Promise<MotionDebugResult> {
  const common = readTimelineCommonEditArgs("motion.timeline.transition.preset.apply", args, services);
  if (isTimelineCommonEditResult(common)) return common;
  const layerId = stringArg(args, "layerId") ?? stringArg(args, "layer");
  const presetArg = stringArg(args, "preset");
  const durationMs = positiveNumberArg(args, "durationMs");
  const direction = stringArg(args, "direction") ?? undefined;
  const distance = nonNegativeNumberArg(args, "distance");
  const easing = stringArg(args, "easing") ?? undefined;
  if (!layerId) return invalidArgs("motion.timeline.transition.preset.apply requires layerId.");
  if (!presetArg) return invalidArgs("motion.timeline.transition.preset.apply requires preset.");
  if (!getTransitionPreset(presetArg)) return unsupportedEnumValue("transition preset", presetArg, "transitionPreset");
  if (durationMs === false) return invalidArgs("durationMs must be a positive number.");
  if (direction && !["left", "right", "up", "down"].includes(direction)) return unsupportedEnumValue("transition direction", direction, "transitionDirection");
  if (distance === false) return invalidArgs("distance must be a non-negative number.");
  if (easing && !isSupportedEasing(easing)) return unsupportedEnumValue("transition easing", easing, "easing", "cubic-bezier(...) and steps(...) strings are also accepted.");
  return commitAtomicTimelineMutation({
    ...common,
    command: "motion.timeline.transition.preset.apply",
    receiptPrefix: "timeline-transition-preset-apply",
    receiptFileName: "timeline-transition-preset-apply.receipt.json",
    invalidCode: "timeline_transition_preset_invalid",
    failureCode: "timeline_transition_preset_apply_failed",
    services,
    mutate: (pkg) => mutateLayer(pkg, layerId, (layer, layerIndex) => {
      const options = {
        ...(durationMs !== null ? { durationMs } : {}),
        ...(direction ? { direction: direction as "left" | "right" | "up" | "down" } : {}),
        ...(distance !== null ? { distance } : {}),
        ...(easing ? { easing } : {})
      };
      const compiled = compileTransitionPreset(presetArg, { ...options, totalDurationMs: layer.durationMs });
      const applied = applyTransitionPresetToLayer(layer, presetArg, options);
      if (!compiled.ok) throw new Error(compiled.error);
      if (!applied.ok) throw new Error(applied.error);
      const changedPaths = [`/layers/${layerIndex}/transitions`, ...Object.keys(compiled.keyframes).map((target) => `/layers/${layerIndex}/keyframes/${target}`), ...(compiled.effects ? [`/layers/${layerIndex}/effects`] : [])];
      return { layer: applied.layer, presetId: applied.presetId, changedPaths: [...new Set(changedPaths)], warnings: applied.warnings };
    }),
    outputFacts: (result) => ({ layerId, presetId: result.presetId, transitions: result.layer.transitions, changedPaths: result.changedPaths, presetWarnings: result.warnings }),
    resultFacts: (result) => ({ layerId, presetId: result.presetId, transitions: result.layer.transitions, changedPaths: result.changedPaths, presetWarnings: result.warnings, layer: result.layer }),
    visibleFacts: (result) => ({ layerId, presetId: result.presetId, changedPaths: result.changedPaths })
  });
}

async function upsert(args: unknown, services: TimelineTransitionsServices): Promise<MotionDebugResult> {
  const common = readTimelineCommonEditArgs("motion.timeline.transition.upsert", args, services);
  if (isTimelineCommonEditResult(common)) return common;
  const layerId = stringArg(args, "layerId") ?? stringArg(args, "layer");
  const edge = edgeArg(args);
  const typeArg = stringArg(args, "type");
  const durationMs = positiveNumberArg(args, "durationMs");
  const easing = stringArg(args, "easing") ?? undefined;
  const direction = stringArg(args, "direction") ?? undefined;
  const distance = nonNegativeNumberArg(args, "distance");
  if (!layerId) return invalidArgs("motion.timeline.transition.upsert requires layerId.");
  if (!edge) return unsupportedEnumValue("edge", stringArg(args, "edge") ?? "(missing)", "transitionEdge");
  if (!typeArg) return invalidArgs("motion.timeline.transition.upsert requires type.");
  const type = readSupportedTransitionType(typeArg);
  if (!type) return unsupportedEnumValue("transition type", typeArg, "transitionType");
  if (durationMs === null || durationMs === false) return invalidArgs("durationMs must be a positive number.");
  if (easing && !isSupportedEasing(easing)) return unsupportedEnumValue("transition easing", easing, "easing", "cubic-bezier(...) and steps(...) strings are also accepted.");
  if (distance === false) return invalidArgs("distance must be a non-negative number.");
  return commitAtomicTimelineMutation({
    ...common,
    command: "motion.timeline.transition.upsert",
    receiptPrefix: "timeline-transition-upsert",
    receiptFileName: "timeline-transition-upsert.receipt.json",
    invalidCode: "timeline_transition_invalid",
    failureCode: "timeline_transition_upsert_failed",
    services,
    mutate: (pkg) => mutateLayer(pkg, layerId, (layer) => upsertLayerTransition(layer, {
      edge, type, durationMs,
      ...(easing ? { easing } : {}), ...(direction ? { direction } : {}),
      ...(distance !== null ? { distance } : {})
    })),
    outputFacts: (result) => ({
      layerId, edge, type: result.transition.type, durationMs: result.transition.durationMs,
      ...(result.transition.easing ? { easing: result.transition.easing } : {}),
      ...(result.transition.direction ? { direction: result.transition.direction } : {}),
      ...(typeof result.transition.distance === "number" ? { distance: result.transition.distance } : {}),
      changedPath: result.changedPath, action: result.action, transition: result.transition,
      ...(result.previousTransition ? { previousTransition: result.previousTransition } : {})
    }),
    resultFacts: (result) => ({
      changedPath: result.changedPath, action: result.action, transition: result.transition,
      ...(result.previousTransition ? { previousTransition: result.previousTransition } : {}), layer: result.layer
    }),
    visibleFacts: (result) => ({ layerId, edge, type: result.transition.type, action: result.action, changedPath: result.changedPath })
  });
}

async function remove(args: unknown, services: TimelineTransitionsServices): Promise<MotionDebugResult> {
  const common = readTimelineCommonEditArgs("motion.timeline.transition.delete", args, services);
  if (isTimelineCommonEditResult(common)) return common;
  const layerId = stringArg(args, "layerId") ?? stringArg(args, "layer");
  const edge = edgeArg(args);
  if (!layerId) return invalidArgs("motion.timeline.transition.delete requires layerId.");
  if (!edge) return unsupportedEnumValue("edge", stringArg(args, "edge") ?? "(missing)", "transitionEdge");
  return commitAtomicTimelineMutation({
    ...common,
    command: "motion.timeline.transition.delete",
    receiptPrefix: "timeline-transition-delete",
    receiptFileName: "timeline-transition-delete.receipt.json",
    invalidCode: "timeline_transition_invalid",
    failureCode: "timeline_transition_delete_failed",
    services,
    mutate: (pkg) => mutateLayer(pkg, layerId, (layer) => deleteLayerTransition(layer, { edge })),
    outputFacts: (result) => ({ layerId, edge, changedPath: result.changedPath, action: result.action, removed: result.removed, remainingEdges: result.remainingEdges }),
    resultFacts: (result) => ({ changedPath: result.changedPath, action: result.action, removed: result.removed, remainingEdges: result.remainingEdges, layer: result.layer }),
    visibleFacts: (result) => ({ layerId, edge, action: result.action, changedPath: result.changedPath })
  });
}

function mutateLayer<T extends { layer: MotionLayer }>(pkg: MotionPackage, layerId: string, mutate: (layer: MotionLayer, index: number) => T): T & { motion: MotionDocument } {
  const index = pkg.motion.layers.findIndex((layer) => layer.id === layerId);
  if (index === -1) throw new Error(`Motion layer not found: ${layerId}.`);
  const layer = pkg.motion.layers[index];
  const lockedTrackId = timelineLayerLockedTrackId(pkg.motion, layer);
  if (lockedTrackId) throw new Error(`Cannot edit layer on locked track: ${lockedTrackId}.`);
  const result = mutate(layer, index);
  return { ...result, motion: { ...pkg.motion, layers: pkg.motion.layers.map((candidate, candidateIndex) => candidateIndex === index ? result.layer : candidate) } };
}

function edgeArg(args: unknown): "in" | "out" | null {
  const value = stringArg(args, "edge");
  return value === "in" || value === "out" ? value : null;
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}
