/** Read-only behavior inspection plus single-receipt atomic COW mutations. */
import * as Core from "@shellx-motion/core";
import type {
  MotionBehaviorInspection,
  MotionBehaviorMutation,
  MotionDocument,
} from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { assertConfiguredAuthoringInputRoot } from "./authoring-root-policy.js";
import {
  isTimelineBehaviorCommand,
  readTimelineBehaviorIntent,
  type TimelineBehaviorIntent,
} from "./timeline-behaviors.js";
import {
  commitAtomicTimelineMutation,
  isTimelineCommonEditResult,
  readHostConfiguredTimelineCommonEditArgs,
  timelineMutationFacts,
  type TimelinePackageEditServices,
} from "./timeline-package-edit.js";

type BehaviorMutationEnvelope = MotionBehaviorMutation & { beforeStaticPlan: MotionBehaviorInspection["staticPlan"] };

/** Test seam; production resolves the three public Core lifecycle exports. */
export interface TimelineBehaviorCore {
  inspectMotionBehaviors(motion: MotionDocument): MotionBehaviorInspection;
  upsertMotionBehavior(motion: MotionDocument, input: unknown): MotionBehaviorMutation;
  removeMotionBehavior(motion: MotionDocument, input: unknown): MotionBehaviorMutation;
}
export interface TimelineBehaviorAuthoringServices extends TimelinePackageEditServices { behaviors?: TimelineBehaviorCore; }

export async function dispatchTimelineBehaviorAuthoringCommand(
  command: string,
  args: unknown,
  services: TimelineBehaviorAuthoringServices,
): Promise<MotionDebugResult | null> {
  if (!isTimelineBehaviorCommand(command)) return null;
  const parsed = readTimelineBehaviorIntent(command, args);
  if (!parsed) return null;
  if (!parsed.ok) return invalidArgs(parsed.problem);
  if (parsed.intent.kind === "inspect") return inspect(command, parsed.intent.packageRoot, services);
  // The parser rejects caller receiptsRoot before this point. This helper selects receipt
  // persistence exclusively from the trusted service configuration.
  const common = readHostConfiguredTimelineCommonEditArgs(command as MotionDebugCommand, parsed.intent.edit, services);
  if (isTimelineCommonEditResult(common)) return common;
  return commit(command, parsed.intent, common, services);
}

/** Leaf test seam: strips the transport discriminator before exactly one Core mutation call. */
export function applyTimelineBehaviorIntent(
  motion: MotionDocument,
  intent: Exclude<TimelineBehaviorIntent, { kind: "inspect" }>,
  services: TimelineBehaviorAuthoringServices,
): BehaviorMutationEnvelope {
  const core = behaviorCore(services);
  const beforeStaticPlan = core.inspectMotionBehaviors(motion).staticPlan;
  const mutation = intent.kind === "upsert"
    ? core.upsertMotionBehavior(motion, { binding: intent.binding })
    : core.removeMotionBehavior(motion, { targetLayerId: intent.targetLayerId });
  return Object.freeze({ ...mutation, beforeStaticPlan });
}

async function inspect(command: string, packageRoot: string, services: TimelineBehaviorAuthoringServices): Promise<MotionDebugResult> {
  if (!services.packageLoader) return unavailable("Timeline behavior inspection is unavailable.");
  try {
    await assertConfiguredAuthoringInputRoot(packageRoot, services.authoringInputRoots, `${command} packageRoot`);
    const pkg = await services.packageLoader(packageRoot);
    await assertConfiguredAuthoringInputRoot(pkg.root, services.authoringInputRoots, `${command} loaded package`);
    const inspection = behaviorCore(services).inspectMotionBehaviors(pkg.motion);
    return {
      ok: true,
      visibleState: { panel: "timeline", operation: command.slice("motion.".length), packageId: pkg.manifest.id, motionId: pkg.motion.id, inspection },
      result: { ok: true, packageId: pkg.manifest.id, motionId: pkg.motion.id, inspection },
      warnings: [],
    };
  } catch (error) { return failure("timeline_behavior_inspect_failed", error); }
}

function commit(
  command: string,
  intent: Exclude<TimelineBehaviorIntent, { kind: "inspect" }>,
  common: { packageRoot: string; outDir: string; receiptsRoot?: string; createdBy?: string },
  services: TimelineBehaviorAuthoringServices,
): Promise<MotionDebugResult> {
  const stem = `timeline-behaviors-${intent.kind}`;
  return commitAtomicTimelineMutation<BehaviorMutationEnvelope>({
    ...common,
    command: command as MotionDebugCommand,
    receiptPrefix: stem,
    receiptFileName: `${stem}.receipt.json`,
    invalidCode: "timeline_behavior_invalid",
    failureCode: "timeline_behavior_failed",
    services,
    mutate: (pkg) => applyTimelineBehaviorIntent(pkg.motion, intent, services),
    outputFacts: behaviorMutationFacts,
    resultFacts: behaviorMutationFacts,
    visibleFacts: behaviorMutationFacts,
  });
}

/** Exact outer-result/receipt facts; all plan identities come from the Core inspection/mutation. */
export function behaviorMutationFacts(mutation: BehaviorMutationEnvelope): Record<string, unknown> {
  return {
    ...timelineMutationFacts(mutation),
    outputMotionSha256: Core.canonicalJsonSha256(mutation.motion),
    behaviors: {
      action: mutation.action,
      targetLayerId: mutation.targetLayerId,
      changedPaths: [...mutation.changedPaths],
      beforeSourceSha256: mutation.beforeSourceSha256,
      afterSourceSha256: mutation.afterSourceSha256,
      beforeStaticPlan: staticPlanFacts(mutation.beforeStaticPlan),
      afterStaticPlan: staticPlanFacts(mutation.staticPlan),
    },
  };
}

function staticPlanFacts(plan: MotionBehaviorInspection["staticPlan"]): Record<string, unknown> {
  return {
    schema: plan.schema,
    fingerprint: plan.fingerprint,
    behaviorSourceSha256: plan.behaviorSourceSha256,
    budget: { ...plan.budget },
  };
}

function behaviorCore(services: TimelineBehaviorAuthoringServices): TimelineBehaviorCore {
  const core = services.behaviors ?? Core as unknown as TimelineBehaviorCore;
  if (typeof core.inspectMotionBehaviors !== "function" || typeof core.upsertMotionBehavior !== "function" || typeof core.removeMotionBehavior !== "function") {
    throw new Error("Core behavior authoring lifecycle exports are unavailable.");
  }
  return core;
}
function invalidArgs(message: string): MotionDebugResult { return { ok: false, error: { code: "invalid_args", message }, warnings: [] }; }
function unavailable(message: string): MotionDebugResult { return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure package loading and retry." }, warnings: [] }; }
function failure(code: string, error: unknown): MotionDebugResult { return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) }, warnings: [] }; }
