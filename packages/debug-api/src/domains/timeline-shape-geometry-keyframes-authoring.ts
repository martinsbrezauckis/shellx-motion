/** Read-only inspection and host-receipted COW authoring for exact shape geometry snapshots. */
import * as Core from "@shellx-motion/core";
import type {
  MotionDocument,
  MotionShapeGeometryKeyframe,
  MotionShapeGeometryKeyframesInspection,
  MotionShapeGeometryKeyframesMutation,
} from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { assertConfiguredAuthoringInputRoot } from "./authoring-root-policy.js";
import {
  isTimelineShapeGeometryKeyframeCommand,
  readTimelineShapeGeometryKeyframeIntent,
  type TimelineShapeGeometryKeyframeIntent,
} from "./timeline-shape-geometry-keyframes.js";
import {
  commitAtomicTimelineMutation,
  isTimelineCommonEditResult,
  readHostConfiguredTimelineCommonEditArgs,
  timelineMutationFacts,
  type TimelinePackageEditServices,
} from "./timeline-package-edit.js";

type GeometryKeyframeMutation = MotionShapeGeometryKeyframesMutation & { outputMotionSha256: string };

/** Test seam; production resolves this exact four-function family from the Core public barrel. */
export interface TimelineShapeGeometryKeyframeCore {
  inspectMotionShapeGeometryKeyframes(motion: MotionDocument, input: { layerId: string }): MotionShapeGeometryKeyframesInspection;
  upsertMotionShapeGeometryKeyframe(motion: MotionDocument, input: { layerId: string; snapshot: MotionShapeGeometryKeyframe }): MotionShapeGeometryKeyframesMutation;
  deleteMotionShapeGeometryKeyframe(motion: MotionDocument, input: { layerId: string; atUs: number }): MotionShapeGeometryKeyframesMutation;
  moveMotionShapeGeometryKeyframe(motion: MotionDocument, input: { layerId: string; fromAtUs: number; toAtUs: number }): MotionShapeGeometryKeyframesMutation;
}
export interface TimelineShapeGeometryKeyframeAuthoringServices extends TimelinePackageEditServices { shapeGeometryKeyframes?: TimelineShapeGeometryKeyframeCore; }

export async function dispatchTimelineShapeGeometryKeyframeAuthoringCommand(
  command: string,
  args: unknown,
  services: TimelineShapeGeometryKeyframeAuthoringServices,
): Promise<MotionDebugResult | null> {
  if (!isTimelineShapeGeometryKeyframeCommand(command)) return null;
  const parsed = readTimelineShapeGeometryKeyframeIntent(command, args);
  if (!parsed) return null;
  if (!parsed.ok) return invalidArgs(parsed.problem);
  if (parsed.intent.kind === "inspect") return inspect(command, parsed.intent, services);
  // The descriptor-first parser refuses caller receiptsRoot; this reads it only from the trusted host.
  const common = readHostConfiguredTimelineCommonEditArgs(command as MotionDebugCommand, parsed.intent.edit, services);
  if (isTimelineCommonEditResult(common)) return common;
  if (!services.receiptsRoot) return unavailable("Shape geometry keyframe mutations require a host-configured receiptsRoot.");
  return commit(command, parsed.intent, { ...common, receiptsRoot: services.receiptsRoot }, services);
}

/** Leaf seam proving these commands cannot route through generic property keyframes. */
export function applyTimelineShapeGeometryKeyframeIntent(
  motion: MotionDocument,
  intent: Exclude<TimelineShapeGeometryKeyframeIntent, { kind: "inspect" }>,
  services: TimelineShapeGeometryKeyframeAuthoringServices,
): GeometryKeyframeMutation {
  const core = geometryKeyframeCore(services);
  const mutation = intent.kind === "upsert"
    ? core.upsertMotionShapeGeometryKeyframe(motion, { layerId: intent.layerId, snapshot: intent.snapshot })
    : intent.kind === "delete"
      ? core.deleteMotionShapeGeometryKeyframe(motion, { layerId: intent.layerId, atUs: intent.atUs })
      : core.moveMotionShapeGeometryKeyframe(motion, { layerId: intent.layerId, fromAtUs: intent.fromAtUs, toAtUs: intent.toAtUs });
  const persistedMotion = Core.compileMotionDocumentCompositing(mutation.motion);
  return { ...mutation, motion: persistedMotion, outputMotionSha256: Core.canonicalJsonSha256(persistedMotion) };
}

async function inspect(
  command: string,
  intent: Extract<TimelineShapeGeometryKeyframeIntent, { kind: "inspect" }>,
  services: TimelineShapeGeometryKeyframeAuthoringServices,
): Promise<MotionDebugResult> {
  if (!services.packageLoader) return unavailable("Shape geometry keyframe inspection is unavailable.");
  try {
    await assertConfiguredAuthoringInputRoot(intent.packageRoot, services.authoringInputRoots, `${command} packageRoot`);
    const pkg = await services.packageLoader(intent.packageRoot);
    await assertConfiguredAuthoringInputRoot(pkg.root, services.authoringInputRoots, `${command} loaded package`);
    const inspection = geometryKeyframeCore(services).inspectMotionShapeGeometryKeyframes(pkg.motion, { layerId: intent.layerId });
    const layer = pkg.motion.layers.find((item) => item.id === inspection.layerId);
    if (!layer?.geometry) throw new Error("Shape geometry keyframe inspection has no static v1 geometry.");
    const result = { ...inspection, staticGeometrySha256: Core.canonicalJsonSha256(layer.geometry) };
    return {
      ok: true,
      visibleState: { panel: "timeline", operation: command.slice("motion.".length), packageId: pkg.manifest.id, motionId: pkg.motion.id, inspection: result },
      result: { ok: true, packageId: pkg.manifest.id, motionId: pkg.motion.id, inspection: result }, warnings: [],
    };
  } catch (error) { return failure("timeline_shape_geometry_keyframes_inspect_failed", error); }
}

function commit(
  command: string,
  intent: Exclude<TimelineShapeGeometryKeyframeIntent, { kind: "inspect" }>,
  common: { packageRoot: string; outDir: string; receiptsRoot?: string; createdBy?: string },
  services: TimelineShapeGeometryKeyframeAuthoringServices,
): Promise<MotionDebugResult> {
  const stem = `timeline-shape-geometry-keyframes-${intent.kind}`;
  return commitAtomicTimelineMutation<GeometryKeyframeMutation>({
    ...common, command: command as MotionDebugCommand, receiptPrefix: stem, receiptFileName: `${stem}.receipt.json`,
    invalidCode: "timeline_shape_geometry_keyframes_invalid", failureCode: "timeline_shape_geometry_keyframes_failed", services,
    mutate: (pkg) => applyTimelineShapeGeometryKeyframeIntent(pkg.motion, intent, services),
    outputFacts: geometryKeyframeFacts, resultFacts: geometryKeyframeFacts, visibleFacts: geometryKeyframeFacts,
  });
}

function geometryKeyframeFacts(mutation: GeometryKeyframeMutation): Record<string, unknown> {
  if (!mutation.layer.geometry) throw new Error("Shape geometry keyframe mutation has no static v1 geometry.");
  return {
    ...timelineMutationFacts(mutation),
    outputMotionSha256: mutation.outputMotionSha256,
    geometryKeyframes: {
      schema: mutation.evaluation.schema,
      atUs: mutation.evaluation.atUs,
      action: mutation.action,
      staticGeometrySha256: Core.canonicalJsonSha256(mutation.layer.geometry),
      sourceSequenceSha256: mutation.evaluation.sourceSequenceSha256,
      geometryFingerprint: mutation.evaluation.geometryFingerprint,
      fingerprint: mutation.evaluation.fingerprint,
      budget: mutation.evaluation.budget,
    },
  };
}

function geometryKeyframeCore(services: TimelineShapeGeometryKeyframeAuthoringServices): TimelineShapeGeometryKeyframeCore {
  const core = services.shapeGeometryKeyframes ?? Core as unknown as TimelineShapeGeometryKeyframeCore;
  if (typeof core.inspectMotionShapeGeometryKeyframes !== "function" || typeof core.upsertMotionShapeGeometryKeyframe !== "function" || typeof core.deleteMotionShapeGeometryKeyframe !== "function" || typeof core.moveMotionShapeGeometryKeyframe !== "function") throw new Error("Core shape geometry keyframe lifecycle exports are unavailable.");
  return core;
}
function invalidArgs(message: string): MotionDebugResult { return { ok: false, error: { code: "invalid_args", message }, warnings: [] }; }
function unavailable(message: string): MotionDebugResult { return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure package loading and retry." }, warnings: [] }; }
function failure(code: string, error: unknown): MotionDebugResult { return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) }, warnings: [] }; }
