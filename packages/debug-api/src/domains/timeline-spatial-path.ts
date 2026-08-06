/** Atomic two-lane position edits for the spatial path editor. */
import {
  deleteLayerSpatialPosition,
  isSupportedEasing,
  moveLayerSpatialPosition,
  timelineLayerLockedTrackId,
  upsertLayerSpatialPosition,
  type MotionDocument,
  type MotionLayer,
  type MotionPackage,
  type MotionSpatialInterpolation,
  type MotionSpatialTangentMode,
} from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { finiteNumberArg, nonNegativeNumberArg, objectArg, stringArg } from "./args.js";
import {
  commitAtomicTimelineMutation,
  isTimelineCommonEditResult,
  readTimelineCommonEditArgs,
  timelineMutationFacts,
  type TimelinePackageEditServices,
} from "./timeline-package-edit.js";

export interface TimelineSpatialPathServices extends TimelinePackageEditServices {}

type SpatialMutation = ReturnType<typeof upsertLayerSpatialPosition> & { motion: MotionDocument };

export async function dispatchTimelineSpatialPathCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: TimelineSpatialPathServices,
): Promise<MotionDebugResult | null> {
  if (command === "motion.timeline.spatial.position.upsert") return upsert(args, services);
  if (command === "motion.timeline.spatial.position.move") return move(args, services);
  if (command === "motion.timeline.spatial.position.delete") return remove(args, services);
  return null;
}

async function upsert(args: unknown, services: TimelineSpatialPathServices): Promise<MotionDebugResult> {
  const base = baseArgs("motion.timeline.spatial.position.upsert", args, services);
  if (isResult(base)) return base;
  const atMs = nonNegativeNumberArg(args, "atMs");
  const x = finiteNumberArg(args, "x"); const y = finiteNumberArg(args, "y");
  const easing = stringArg(args, "easing") ?? undefined;
  if (atMs === null || atMs === false) return invalid("atMs must be a non-negative number.");
  if (x === null || x === false || y === null || y === false) return invalid("x and y must be finite numbers.");
  if (easing && !isSupportedEasing(easing)) return invalid(`Unsupported keyframe easing: ${easing}.`);
  const spatial = readSpatial(args);
  if (spatial === false) return invalid("spatial must contain a supported mode and finite in/out handles.");
  const facts = { layerId: base.layerId, atMs, x, y, ...(easing ? { easing } : {}), ...(spatial ? { spatial } : {}) };
  return execute({
    ...base,
    command: "motion.timeline.spatial.position.upsert",
    receiptPrefix: "timeline-spatial-position-upsert",
    receiptFileName: "timeline-spatial-position-upsert.receipt.json",
    failureCode: "timeline_spatial_position_upsert_failed",
    services,
    facts,
    edit: (layer) => upsertLayerSpatialPosition(layer, { atMs, x, y, ...(easing ? { easing } : {}), ...(spatial ? { spatial } : {}) }),
  });
}

async function move(args: unknown, services: TimelineSpatialPathServices): Promise<MotionDebugResult> {
  const base = baseArgs("motion.timeline.spatial.position.move", args, services);
  if (isResult(base)) return base;
  const fromMs = nonNegativeNumberArg(args, "fromMs"); const toMs = nonNegativeNumberArg(args, "toMs");
  if (fromMs === null || fromMs === false || toMs === null || toMs === false) return invalid("fromMs and toMs must be non-negative numbers.");
  const facts = { layerId: base.layerId, fromMs, toMs };
  return execute({
    ...base,
    command: "motion.timeline.spatial.position.move",
    receiptPrefix: "timeline-spatial-position-move",
    receiptFileName: "timeline-spatial-position-move.receipt.json",
    failureCode: "timeline_spatial_position_move_failed",
    services,
    facts,
    edit: (layer) => moveLayerSpatialPosition(layer, { fromMs, toMs }),
  });
}

async function remove(args: unknown, services: TimelineSpatialPathServices): Promise<MotionDebugResult> {
  const base = baseArgs("motion.timeline.spatial.position.delete", args, services);
  if (isResult(base)) return base;
  const atMs = nonNegativeNumberArg(args, "atMs");
  if (atMs === null || atMs === false) return invalid("atMs must be a non-negative number.");
  const facts = { layerId: base.layerId, atMs };
  return execute({
    ...base,
    command: "motion.timeline.spatial.position.delete",
    receiptPrefix: "timeline-spatial-position-delete",
    receiptFileName: "timeline-spatial-position-delete.receipt.json",
    failureCode: "timeline_spatial_position_delete_failed",
    services,
    facts,
    edit: (layer) => deleteLayerSpatialPosition(layer, { atMs }),
  });
}

interface BaseArgs {
  packageRoot: string;
  outDir: string;
  receiptsRoot?: string;
  createdBy?: string;
  layerId: string;
}

function baseArgs(command: MotionDebugCommand, args: unknown, services: TimelineSpatialPathServices): BaseArgs | MotionDebugResult {
  const common = readTimelineCommonEditArgs(command, args, services);
  if (isTimelineCommonEditResult(common)) return common;
  const layerId = stringArg(args, "layerId") ?? stringArg(args, "layer");
  return layerId ? { ...common, layerId } : invalid(`${command} requires layerId.`);
}

function execute(input: BaseArgs & {
  command: MotionDebugCommand;
  receiptPrefix: string;
  receiptFileName: string;
  failureCode: string;
  services: TimelineSpatialPathServices;
  facts: Record<string, unknown>;
  edit: (layer: MotionLayer) => Omit<SpatialMutation, "motion">;
}): Promise<MotionDebugResult> {
  return commitAtomicTimelineMutation<SpatialMutation>({
    ...input,
    invalidCode: "timeline_spatial_position_invalid",
    mutate: (pkg) => mutateLayer(pkg, input.layerId, input.edit),
    outputFacts: (mutation) => ({ ...input.facts, ...timelineMutationFacts(mutation) }),
    resultFacts: timelineMutationFacts,
    visibleFacts: (mutation) => ({ ...input.facts, action: mutation.action, changedPaths: mutation.changedPaths }),
  });
}

function mutateLayer(pkg: MotionPackage, layerId: string, edit: (layer: MotionLayer) => Omit<SpatialMutation, "motion">): SpatialMutation {
  const index = pkg.motion.layers.findIndex((layer) => layer.id === layerId);
  if (index < 0) throw new Error(`Motion layer not found: ${layerId}.`);
  const layer = pkg.motion.layers[index];
  const lockedTrackId = timelineLayerLockedTrackId(pkg.motion, layer);
  if (lockedTrackId) throw new Error(`Cannot edit layer on locked track: ${lockedTrackId}.`);
  const mutation = edit(layer);
  return { ...mutation, motion: { ...pkg.motion, layers: pkg.motion.layers.map((candidate, at) => at === index ? mutation.layer : candidate) } };
}

function readSpatial(args: unknown): MotionSpatialInterpolation | null | false {
  const source = objectArg(args); if (!source || !("spatial" in source)) return null;
  const spatial = objectArg(source.spatial); const incoming = objectArg(spatial?.in); const outgoing = objectArg(spatial?.out);
  const mode = spatial?.mode;
  if ((mode !== "linear" && mode !== "smooth" && mode !== "broken" && mode !== "auto") || !incoming || !outgoing) return false;
  const values = [incoming.x, incoming.y, outgoing.x, outgoing.y];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) return false;
  return { mode: mode as MotionSpatialTangentMode, in: { x: incoming.x as number, y: incoming.y as number }, out: { x: outgoing.x as number, y: outgoing.y as number } };
}

function isResult(value: BaseArgs | MotionDebugResult): value is MotionDebugResult { return "ok" in value; }
function invalid(message: string): MotionDebugResult { return { ok: false, error: { code: "invalid_args", message }, warnings: [] }; }
