/** Read-only inspection and atomic COW receipts for exact root fixed-adjustment authoring. */
import * as Core from "@shellx-motion/core";
import type {
  MotionDocument,
  MotionFixedAdjustmentDefinition,
  MotionFixedAdjustmentInspection,
  MotionFixedAdjustmentMutation,
} from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { assertConfiguredAuthoringInputRoot } from "./authoring-root-policy.js";
import {
  isTimelineFixedAdjustmentCommand,
  readTimelineFixedAdjustmentIntent,
  type TimelineFixedAdjustmentIntent,
} from "./timeline-adjustment-fixed.js";
import {
  commitAtomicTimelineMutation,
  isTimelineCommonEditResult,
  readHostConfiguredTimelineCommonEditArgs,
  timelineMutationFacts,
  type TimelinePackageEditServices,
} from "./timeline-package-edit.js";

/** Test seam; production resolves the closed lifecycle from the Core public barrel. */
export interface TimelineFixedAdjustmentCore {
  inspectMotionFixedAdjustment(motion: MotionDocument, input: { layerId: string }): MotionFixedAdjustmentInspection;
  createOrReplaceMotionFixedAdjustment(motion: MotionDocument, input: { adjustment: MotionFixedAdjustmentDefinition }): MotionFixedAdjustmentMutation;
  removeMotionFixedAdjustment(motion: MotionDocument, input: { layerId: string }): MotionFixedAdjustmentMutation;
}

export interface TimelineFixedAdjustmentAuthoringServices extends TimelinePackageEditServices {
  fixedAdjustments?: TimelineFixedAdjustmentCore;
}

export async function dispatchTimelineFixedAdjustmentAuthoringCommand(
  command: string,
  args: unknown,
  services: TimelineFixedAdjustmentAuthoringServices,
): Promise<MotionDebugResult | null> {
  if (!isTimelineFixedAdjustmentCommand(command)) return null;
  const parsed = readTimelineFixedAdjustmentIntent(command, args);
  if (!parsed) return null;
  if (!parsed.ok) return invalidArgs(parsed.problem);
  if (parsed.intent.kind === "inspect") return inspect(command, parsed.intent, args, services);
  // The strict parser has already refused caller receiptsRoot. This host-only
  // reader selects optional receipt persistence solely from service context.
  const common = readHostConfiguredTimelineCommonEditArgs(command as MotionDebugCommand, args, services);
  if (isTimelineCommonEditResult(common)) return common;
  return commitMutation(command, parsed.intent, common, services);
}

/** Exposed for focused tests: each exact mutation has one Core operation. */
export function applyTimelineFixedAdjustmentIntent(
  motion: MotionDocument,
  intent: Exclude<TimelineFixedAdjustmentIntent, { kind: "inspect" }>,
  services: TimelineFixedAdjustmentAuthoringServices,
): MotionFixedAdjustmentMutation {
  const core = fixedAdjustmentCore(services);
  return intent.kind === "set"
    ? core.createOrReplaceMotionFixedAdjustment(motion, { adjustment: intent.adjustment })
    : core.removeMotionFixedAdjustment(motion, { layerId: intent.layerId });
}

async function inspect(
  command: string,
  intent: Extract<TimelineFixedAdjustmentIntent, { kind: "inspect" }>,
  args: unknown,
  services: TimelineFixedAdjustmentAuthoringServices,
): Promise<MotionDebugResult> {
  const packageRoot = readPackageRoot(args);
  if (!packageRoot) return invalidArgs(`${command} requires packageRoot.`);
  if (!services.packageLoader) return capabilityUnavailable("Fixed adjustment inspection is unavailable.");
  try {
    await assertConfiguredAuthoringInputRoot(packageRoot, services.authoringInputRoots, `${command} packageRoot`);
    const pkg = await services.packageLoader(packageRoot);
    await assertConfiguredAuthoringInputRoot(pkg.root, services.authoringInputRoots, `${command} loaded package`);
    const inspection = fixedAdjustmentCore(services).inspectMotionFixedAdjustment(pkg.motion, { layerId: intent.layerId });
    return {
      ok: true,
      visibleState: { panel: "timeline", operation: command.slice("motion.".length), packageId: pkg.manifest.id, motionId: pkg.motion.id, inspection },
      result: { ok: true, packageId: pkg.manifest.id, motionId: pkg.motion.id, inspection },
      warnings: [],
    };
  } catch (error) {
    return commandFailure("timeline_fixed_adjustment_inspect_failed", error);
  }
}

function commitMutation(
  command: string,
  intent: Exclude<TimelineFixedAdjustmentIntent, { kind: "inspect" }>,
  common: { packageRoot: string; outDir: string; receiptsRoot?: string; createdBy?: string },
  services: TimelineFixedAdjustmentAuthoringServices,
): Promise<MotionDebugResult> {
  const stem = `timeline-adjustment-fixed-${intent.kind}`;
  return commitAtomicTimelineMutation<MotionFixedAdjustmentMutation>({
    ...common,
    command: command as MotionDebugCommand,
    receiptPrefix: stem,
    receiptFileName: `${stem}.receipt.json`,
    invalidCode: "timeline_fixed_adjustment_invalid",
    failureCode: "timeline_fixed_adjustment_failed",
    services,
    mutate: (pkg) => applyTimelineFixedAdjustmentIntent(pkg.motion, intent, services),
    outputFacts: fixedAdjustmentMutationFacts,
    resultFacts: fixedAdjustmentMutationFacts,
    visibleFacts: fixedAdjustmentMutationFacts,
  });
}

function fixedAdjustmentMutationFacts(mutation: MotionFixedAdjustmentMutation): Record<string, unknown> {
  const effects = mutation.layer?.effects;
  const families = ["vignette", "filmGrain"].filter((name) => Object.hasOwn(effects ?? {}, name));
  return {
    ...timelineMutationFacts(mutation),
    beforeMotionSha256: mutation.inputFingerprint,
    afterMotionSha256: mutation.outputFingerprint,
    fixedAdjustment: {
      ...(mutation.adjustmentFingerprint ? { fingerprint: mutation.adjustmentFingerprint } : {}),
      effectFamilies: families,
      effectCount: families.length,
      canonicalEffectOrder: ["vignette", "filmGrain"],
      rootAdjustmentOrder: rootAdjustmentOrder(mutation.motion),
    },
  };
}

function rootAdjustmentOrder(motion: MotionDocument): string[] {
  const owned = new Set(motion.layers.filter((layer) => layer.type === "group").flatMap((layer) => layer.childLayerIds ?? []));
  return motion.layers.filter((layer) => layer.type === "adjustment" && !owned.has(layer.id)).map((layer) => layer.id);
}

function fixedAdjustmentCore(services: TimelineFixedAdjustmentAuthoringServices): TimelineFixedAdjustmentCore {
  const candidate = (services.fixedAdjustments ?? Core as unknown as TimelineFixedAdjustmentCore);
  if (typeof candidate.inspectMotionFixedAdjustment !== "function" || typeof candidate.createOrReplaceMotionFixedAdjustment !== "function" || typeof candidate.removeMotionFixedAdjustment !== "function") {
    throw new Error("Core fixed adjustment lifecycle exports are unavailable.");
  }
  return candidate;
}

function readPackageRoot(args: unknown): string | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(args, "packageRoot");
  return descriptor && "value" in descriptor && typeof descriptor.value === "string" && descriptor.value.trim() ? descriptor.value : null;
}
function invalidArgs(message: string): MotionDebugResult { return { ok: false, error: { code: "invalid_args", message }, warnings: [] }; }
function capabilityUnavailable(message: string): MotionDebugResult { return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure package loading and retry." }, warnings: [] }; }
function commandFailure(code: string, error: unknown): MotionDebugResult { return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) }, warnings: [] }; }
