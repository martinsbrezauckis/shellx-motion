/** Bounded point inspection plus atomic COW/receipt publication for point-cloud edits. */
import * as Core from "@shellx-motion/core";
import type { MotionDocument, MotionLayer } from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { assertConfiguredAuthoringInputRoot } from "./authoring-root-policy.js";
import { isTimelinePointCommand, readTimelinePointIntent, type TimelinePointIntent } from "./timeline-points.js";
import {
  commitAtomicTimelineMutation,
  isTimelineCommonEditResult,
  readTimelineCommonEditArgs,
  timelineMutationFacts,
  type TimelinePackageEditServices,
} from "./timeline-package-edit.js";

interface PointMutation {
  motion: MotionDocument;
  layerId: string;
  layer: MotionLayer;
  action: "inserted" | "replaced" | "moved" | "deleted";
  changedPaths: string[];
  index?: number;
  range?: { startIndex: number; endIndexExclusive: number };
}

export interface TimelinePointAuthoringServices extends TimelinePackageEditServices {}

export async function dispatchTimelinePointAuthoringCommand(
  command: string,
  args: unknown,
  services: TimelinePointAuthoringServices,
): Promise<MotionDebugResult | null> {
  if (!isTimelinePointCommand(command)) return null;
  const parsed = readTimelinePointIntent(command, args);
  if (!parsed) return null;
  if (!parsed.ok) return invalidArgs(parsed.problem);
  if (parsed.intent.kind === "range-inspect" || parsed.intent.kind === "trajectory-inspect") return inspect(command, parsed.intent, args, services);
  const common = readTimelineCommonEditArgs(command as MotionDebugCommand, args, services);
  if (isTimelineCommonEditResult(common)) return common;
  return commitMutation(command, parsed.intent, common, services);
}

async function inspect(
  command: string,
  intent: Extract<TimelinePointIntent, { kind: "range-inspect" | "trajectory-inspect" }>,
  args: unknown,
  services: TimelinePointAuthoringServices,
): Promise<MotionDebugResult> {
  const packageRoot = readPackageRoot(args);
  if (!packageRoot) return invalidArgs(`${command} requires packageRoot.`);
  if (!services.packageLoader) return capabilityUnavailable("Timeline point inspection is unavailable.");
  try {
    await assertConfiguredAuthoringInputRoot(packageRoot, services.authoringInputRoots, `${command} packageRoot`);
    const pkg = await services.packageLoader(packageRoot);
    await assertConfiguredAuthoringInputRoot(pkg.root, services.authoringInputRoots, `${command} loaded package`);
    const inspection = intent.kind === "range-inspect"
      ? Core.inspectMotionPointRange(pkg.motion, { layerId: intent.layerId, startIndex: intent.startIndex, endIndexExclusive: intent.endIndexExclusive })
      : Core.inspectMotionPointTrajectory(pkg.motion, { layerId: intent.layerId, index: intent.index });
    return {
      ok: true,
      visibleState: { panel: "timeline", operation: command.slice("motion.".length), packageId: pkg.manifest.id, motionId: pkg.motion.id, inspection },
      result: { ok: true, packageId: pkg.manifest.id, motionId: pkg.motion.id, inspection },
      warnings: [],
    };
  } catch (error) {
    return commandFailure("timeline_point_inspect_failed", error);
  }
}

function commitMutation(
  command: string,
  intent: Exclude<TimelinePointIntent, { kind: "range-inspect" | "trajectory-inspect" }>,
  common: { packageRoot: string; outDir: string; receiptsRoot?: string; createdBy?: string },
  services: TimelinePointAuthoringServices,
): Promise<MotionDebugResult> {
  const receiptStem = `timeline-points-${intent.kind}`;
  return commitAtomicTimelineMutation<PointMutation>({
    ...common,
    command: command as MotionDebugCommand,
    receiptPrefix: receiptStem,
    receiptFileName: `${receiptStem}.receipt.json`,
    invalidCode: "timeline_points_invalid",
    failureCode: "timeline_points_failed",
    services,
    mutate: (pkg) => mutatePoints(pkg.motion, intent),
    outputFacts: mutationFacts,
    resultFacts: mutationFacts,
    visibleFacts: (mutation) => ({
      layerId: mutation.layerId,
      action: mutation.action,
      changedPaths: mutation.changedPaths,
      ...(mutation.index === undefined ? {} : { index: mutation.index }),
      ...(mutation.range ? { range: mutation.range, rangeSemantics: "[startIndex, endIndexExclusive)" } : {}),
    }),
  });
}

function mutatePoints(
  motion: MotionDocument,
  intent: Exclude<TimelinePointIntent, { kind: "range-inspect" | "trajectory-inspect" }>,
): PointMutation {
  if (intent.kind === "upsert") { const { kind: _kind, ...input } = intent; return Core.upsertMotionPoint(motion, input); }
  if (intent.kind === "move") { const { kind: _kind, ...input } = intent; return Core.moveMotionPoint(motion, input); }
  if (intent.kind === "delete") { const { kind: _kind, ...input } = intent; return Core.deleteMotionPoint(motion, input); }
  const { kind: _kind, ...input } = intent;
  return Core.deleteMotionPointRange(motion, input);
}

function mutationFacts(mutation: PointMutation): Record<string, unknown> {
  return { ...timelineMutationFacts(mutation), ...(mutation.range ? { rangeSemantics: "[startIndex, endIndexExclusive)" } : {}) };
}

function readPackageRoot(args: unknown): string | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(args, "packageRoot");
  return descriptor && "value" in descriptor && typeof descriptor.value === "string" && descriptor.value.trim().length > 0 ? descriptor.value : null;
}

function invalidArgs(message: string): MotionDebugResult { return { ok: false, error: { code: "invalid_args", message }, warnings: [] }; }
function capabilityUnavailable(message: string): MotionDebugResult { return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure package loading and retry." }, warnings: [] }; }
function commandFailure(code: string, error: unknown): MotionDebugResult { return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) }, warnings: [] }; }
