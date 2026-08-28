/** Read-only inspection and atomic COW receipts for fixed-topology gradient stop colors. */
import * as Core from "@shellx-motion/core";
import type {
  MotionDocument,
  MotionGradientColorKeyframe,
  MotionGradientColorKeyframeEvaluation,
  MotionGradientColorKeyframesInspection,
  MotionGradientColorKeyframesMutation,
} from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { assertConfiguredAuthoringInputRoot } from "./authoring-root-policy.js";
import {
  isTimelineGradientColorKeyframeCommand,
  readTimelineGradientColorKeyframeIntent,
  type TimelineGradientColorKeyframeIntent,
} from "./timeline-gradient-color-keyframes.js";
import {
  commitAtomicTimelineMutation,
  isTimelineCommonEditResult,
  readTimelineCommonEditArgs,
  timelineMutationFacts,
  type TimelinePackageEditServices,
} from "./timeline-package-edit.js";

/** Test seam; production obtains this exact Core family from its public barrel. */
export interface TimelineGradientColorKeyframeCore {
  inspectMotionGradientColorKeyframes(motion: MotionDocument, input: { layerId: string }): MotionGradientColorKeyframesInspection;
  upsertMotionGradientColorKeyframe(motion: MotionDocument, input: { layerId: string; snapshot: MotionGradientColorKeyframe }): MotionGradientColorKeyframesMutation;
  deleteMotionGradientColorKeyframe(motion: MotionDocument, input: { layerId: string; atUs: number }): MotionGradientColorKeyframesMutation;
  moveMotionGradientColorKeyframe(motion: MotionDocument, input: { layerId: string; fromAtUs: number; toAtUs: number }): MotionGradientColorKeyframesMutation;
}

export interface TimelineGradientColorKeyframeAuthoringServices extends TimelinePackageEditServices {
  gradientColorKeyframes?: TimelineGradientColorKeyframeCore;
}

export async function dispatchTimelineGradientColorKeyframeAuthoringCommand(
  command: string,
  args: unknown,
  services: TimelineGradientColorKeyframeAuthoringServices,
): Promise<MotionDebugResult | null> {
  if (!isTimelineGradientColorKeyframeCommand(command)) return null;
  const parsed = readTimelineGradientColorKeyframeIntent(command, args);
  if (!parsed) return null;
  if (!parsed.ok) return invalidArgs(parsed.problem);
  if (parsed.intent.kind === "inspect") return inspect(command, parsed.intent, args, services);
  const common = readTimelineCommonEditArgs(command as MotionDebugCommand, args, services);
  if (isTimelineCommonEditResult(common)) return common;
  return commitMutation(command, parsed.intent, common, services);
}

/** Exposed for focused leaf tests: every parsed mutation reaches one and only one Core operation. */
export function applyTimelineGradientColorKeyframeIntent(
  motion: MotionDocument,
  intent: Exclude<TimelineGradientColorKeyframeIntent, { kind: "inspect" }>,
  services: TimelineGradientColorKeyframeAuthoringServices,
): MotionGradientColorKeyframesMutation {
  const core = gradientCore(services);
  if (intent.kind === "upsert") return core.upsertMotionGradientColorKeyframe(motion, { layerId: intent.layerId, snapshot: intent.snapshot });
  if (intent.kind === "delete") return core.deleteMotionGradientColorKeyframe(motion, { layerId: intent.layerId, atUs: intent.atUs });
  return core.moveMotionGradientColorKeyframe(motion, { layerId: intent.layerId, fromAtUs: intent.fromAtUs, toAtUs: intent.toAtUs });
}

async function inspect(
  command: string,
  intent: Extract<TimelineGradientColorKeyframeIntent, { kind: "inspect" }>,
  args: unknown,
  services: TimelineGradientColorKeyframeAuthoringServices,
): Promise<MotionDebugResult> {
  const packageRoot = readPackageRoot(args);
  if (!packageRoot) return invalidArgs(`${command} requires packageRoot.`);
  if (!services.packageLoader) return capabilityUnavailable("Timeline gradient color keyframe inspection is unavailable.");
  try {
    await assertConfiguredAuthoringInputRoot(packageRoot, services.authoringInputRoots, `${command} packageRoot`);
    const pkg = await services.packageLoader(packageRoot);
    await assertConfiguredAuthoringInputRoot(pkg.root, services.authoringInputRoots, `${command} loaded package`);
    const inspection = gradientCore(services).inspectMotionGradientColorKeyframes(pkg.motion, { layerId: intent.layerId });
    return {
      ok: true,
      visibleState: { panel: "timeline", operation: command.slice("motion.".length), packageId: pkg.manifest.id, motionId: pkg.motion.id, inspection },
      result: { ok: true, packageId: pkg.manifest.id, motionId: pkg.motion.id, inspection },
      warnings: [],
    };
  } catch (error) {
    return commandFailure("timeline_gradient_color_keyframes_inspect_failed", error);
  }
}

function commitMutation(
  command: string,
  intent: Exclude<TimelineGradientColorKeyframeIntent, { kind: "inspect" }>,
  common: { packageRoot: string; outDir: string; receiptsRoot?: string; createdBy?: string },
  services: TimelineGradientColorKeyframeAuthoringServices,
): Promise<MotionDebugResult> {
  const stem = `timeline-gradient-color-keyframes-${intent.kind}`;
  return commitAtomicTimelineMutation<MotionGradientColorKeyframesMutation>({
    ...common,
    command: command as MotionDebugCommand,
    receiptPrefix: stem,
    receiptFileName: `${stem}.receipt.json`,
    invalidCode: "timeline_gradient_color_keyframes_invalid",
    failureCode: "timeline_gradient_color_keyframes_failed",
    services,
    mutate: (pkg) => applyTimelineGradientColorKeyframeIntent(pkg.motion, intent, services),
    outputFacts: gradientMutationFacts,
    resultFacts: gradientMutationFacts,
    visibleFacts: gradientMutationFacts,
  });
}

function gradientMutationFacts(mutation: MotionGradientColorKeyframesMutation): Record<string, unknown> {
  const evaluation = mutation.evaluation;
  return {
    ...timelineMutationFacts(mutation),
    ...(mutation.action === "moved" ? { orderSemantics: "Snapshots are sorted by ascending exact atUs after the timestamp move." } : {}),
    gradientColorKeyframes: evaluationFacts(evaluation),
  };
}

function evaluationFacts(evaluation: MotionGradientColorKeyframeEvaluation): Record<string, unknown> {
  return {
    schema: evaluation.schema,
    atUs: evaluation.atUs,
    fingerprint: evaluation.fingerprint,
    sourceSequenceSha256: evaluation.sourceSequenceSha256,
    topologySha256: evaluation.topologySha256,
    budget: evaluation.budget,
  };
}

function gradientCore(services: TimelineGradientColorKeyframeAuthoringServices): TimelineGradientColorKeyframeCore {
  const candidate = (services.gradientColorKeyframes ?? Core as unknown as TimelineGradientColorKeyframeCore);
  if (typeof candidate.inspectMotionGradientColorKeyframes !== "function") throw new Error("Core gradient color keyframe export inspectMotionGradientColorKeyframes is unavailable.");
  return candidate;
}

function readPackageRoot(args: unknown): string | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(args, "packageRoot");
  return descriptor && "value" in descriptor && typeof descriptor.value === "string" && descriptor.value.trim().length > 0 ? descriptor.value : null;
}
function invalidArgs(message: string): MotionDebugResult { return { ok: false, error: { code: "invalid_args", message }, warnings: [] }; }
function capabilityUnavailable(message: string): MotionDebugResult { return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure package loading and retry." }, warnings: [] }; }
function commandFailure(code: string, error: unknown): MotionDebugResult { return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) }, warnings: [] }; }
