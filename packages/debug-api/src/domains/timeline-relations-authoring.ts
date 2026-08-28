/** Read-only inspection plus one-receipt COW lifecycle for document-root relations@1. */
import * as Core from "@shellx-motion/core";
import type {
  MotionDocument,
  MotionRelationBakeResult,
  MotionRelationFramePlan,
  MotionRelationInspection,
  MotionRelationMutation,
  MotionRelationStaticPlan,
} from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { assertConfiguredAuthoringInputRoot } from "./authoring-root-policy.js";
import {
  isTimelineRelationCommand,
  readTimelineRelationIntent,
  type TimelineRelationIntent,
} from "./timeline-relations.js";
import {
  commitAtomicTimelineMutation,
  isTimelineCommonEditResult,
  readHostConfiguredTimelineCommonEditArgs,
  timelineMutationFacts,
  type TimelinePackageEditServices,
} from "./timeline-package-edit.js";

type RelationMutationEnvelope = {
  action: MotionRelationMutation["action"] | "baked";
  relationId: string;
  motion: MotionDocument;
  /** SHA-256 of the exact compositing-compiled Motion object handed to the COW transaction. */
  outputMotionSha256: string;
  changedPaths: readonly string[];
  beforeSourceSha256: string | null;
  afterSourceSha256: string | null;
  beforeStaticPlan: MotionRelationStaticPlan;
  staticPlan: MotionRelationStaticPlan;
  bake?: Omit<MotionRelationBakeResult, "motion" | "changedPaths">;
};

/** Test seam; production uses only these public Core lifecycle exports. */
export interface TimelineRelationCore {
  inspectMotionRelations(motion: MotionDocument): MotionRelationInspection;
  compileMotionRelationAuthoringFramePlan(motion: MotionDocument, atUs: number): { ok: true; plan: MotionRelationFramePlan } | { ok: false; message: string };
  upsertMotionRelation(motion: MotionDocument, input: unknown): MotionRelationMutation;
  setMotionRelationEnabled(motion: MotionDocument, input: unknown): MotionRelationMutation;
  removeMotionRelation(motion: MotionDocument, input: unknown): MotionRelationMutation;
  detachMotionRelation(motion: MotionDocument, input: unknown): MotionRelationMutation;
  bakeMotionRelation(motion: MotionDocument, input: unknown): MotionRelationBakeResult;
}
export interface TimelineRelationAuthoringServices extends TimelinePackageEditServices { relations?: TimelineRelationCore; }

export async function dispatchTimelineRelationAuthoringCommand(
  command: string,
  args: unknown,
  services: TimelineRelationAuthoringServices,
): Promise<MotionDebugResult | null> {
  if (!isTimelineRelationCommand(command)) return null;
  const parsed = readTimelineRelationIntent(command, args);
  if (!parsed) return null;
  if (!parsed.ok) return invalidArgs(parsed.problem);
  if (parsed.intent.kind === "inspect") return inspect(command, parsed.intent, services);
  const common = readHostConfiguredTimelineCommonEditArgs(command as MotionDebugCommand, parsed.intent.edit, services);
  if (isTimelineCommonEditResult(common)) return common;
  return commit(command, parsed.intent, common, services);
}

/** Test seam: one Core mutation is selected only after strict transport parsing. */
export function applyTimelineRelationIntent(
  motion: MotionDocument,
  intent: Exclude<TimelineRelationIntent, { kind: "inspect" }>,
  services: TimelineRelationAuthoringServices,
): RelationMutationEnvelope {
  const core = relationCore(services);
  const beforeStaticPlan = core.inspectMotionRelations(motion).staticPlan;
  if (intent.kind === "bake") {
    const baked = core.bakeMotionRelation(motion, { id: intent.id, sampleEveryUs: intent.sampleEveryUs });
    const persistedMotion = compilePersistedMotion(baked.motion);
    const staticPlan = core.inspectMotionRelations(persistedMotion).staticPlan;
    return Object.freeze({
      action: "baked",
      relationId: baked.relationId,
      motion: persistedMotion,
      outputMotionSha256: Core.canonicalJsonSha256(persistedMotion),
      changedPaths: baked.changedPaths,
      beforeSourceSha256: beforeStaticPlan.relationSourceSha256,
      afterSourceSha256: staticPlan.relationSourceSha256,
      beforeStaticPlan,
      staticPlan,
      bake: withoutMotionAndPaths(baked),
    });
  }
  const mutation = intent.kind === "upsert"
    ? core.upsertMotionRelation(motion, { binding: intent.binding })
    : intent.kind === "enabled"
      ? core.setMotionRelationEnabled(motion, { id: intent.id, enabled: intent.enabled })
      : intent.kind === "remove"
        ? core.removeMotionRelation(motion, { id: intent.id })
        : core.detachMotionRelation(motion, { id: intent.id });
  const persistedMotion = compilePersistedMotion(mutation.motion);
  const staticPlan = core.inspectMotionRelations(persistedMotion).staticPlan;
  return Object.freeze({
    ...mutation,
    motion: persistedMotion,
    outputMotionSha256: Core.canonicalJsonSha256(persistedMotion),
    afterSourceSha256: staticPlan.relationSourceSha256,
    staticPlan,
    beforeStaticPlan,
  });
}

async function inspect(
  command: string,
  intent: Extract<TimelineRelationIntent, { kind: "inspect" }>,
  services: TimelineRelationAuthoringServices,
): Promise<MotionDebugResult> {
  if (!services.packageLoader) return unavailable("Relation inspection is unavailable.");
  try {
    await assertConfiguredAuthoringInputRoot(intent.packageRoot, services.authoringInputRoots, `${command} packageRoot`);
    const pkg = await services.packageLoader(intent.packageRoot);
    await assertConfiguredAuthoringInputRoot(pkg.root, services.authoringInputRoots, `${command} loaded package`);
    const inspection = relationCore(services).inspectMotionRelations(pkg.motion);
    const frame = intent.atUs === undefined ? undefined : requiredFrame(relationCore(services), pkg.motion, intent.atUs);
    const laneTruth = relationLaneTruth(pkg.motion);
    const result = {
      packageId: pkg.manifest.id,
      motionId: pkg.motion.id,
      inspection,
      ...(frame ? { frame } : {}),
      laneTruth,
    };
    return {
      ok: true,
      visibleState: { panel: "timeline", operation: command.slice("motion.".length), ...result },
      result: { ok: true, ...result },
      warnings: relationLaneWarning(laneTruth),
    };
  } catch (error) { return failure("timeline_relation_inspect_failed", error); }
}

function commit(
  command: string,
  intent: Exclude<TimelineRelationIntent, { kind: "inspect" }>,
  common: { packageRoot: string; outDir: string; receiptsRoot?: string; createdBy?: string },
  services: TimelineRelationAuthoringServices,
): Promise<MotionDebugResult> {
  const stem = `timeline-relations-${intent.kind.replace(".", "-")}`;
  return commitAtomicTimelineMutation<RelationMutationEnvelope>({
    ...common,
    command: command as MotionDebugCommand,
    receiptPrefix: stem,
    receiptFileName: `${stem}.receipt.json`,
    invalidCode: "timeline_relation_invalid",
    failureCode: "timeline_relation_failed",
    services,
    mutate: (pkg) => applyTimelineRelationIntent(pkg.motion, intent, services),
    outputFacts: relationMutationFacts,
    resultFacts: relationMutationFacts,
    visibleFacts: relationMutationFacts,
    receiptWarnings: (mutation) => relationLaneWarning(relationLaneTruth(mutation.motion)),
  });
}

/** Exact receipt/result facts: source identities, COW output identity, static plans, and lane truth. */
export function relationMutationFacts(mutation: RelationMutationEnvelope): Record<string, unknown> {
  const laneTruth = relationLaneTruth(mutation.motion);
  return {
    ...timelineMutationFacts(mutation),
    outputMotionSha256: mutation.outputMotionSha256,
    relations: {
      action: mutation.action,
      relationId: mutation.relationId,
      changedPaths: [...mutation.changedPaths],
      beforeSourceSha256: mutation.beforeSourceSha256,
      afterSourceSha256: mutation.afterSourceSha256,
      beforeStaticPlan: staticPlanFacts(mutation.beforeStaticPlan),
      afterStaticPlan: staticPlanFacts(mutation.staticPlan),
      ...(mutation.bake ? { bake: mutation.bake } : {}),
      laneTruth,
    },
  };
}

function staticPlanFacts(plan: MotionRelationStaticPlan): Record<string, unknown> {
  return {
    schema: plan.schema,
    fingerprint: plan.fingerprint,
    relationSourceSha256: plan.relationSourceSha256,
    budget: { ...plan.budget },
  };
}
function relationLaneTruth(motion: MotionDocument) {
  const refusal = Core.motionRelationPackageRefusal(motion);
  return refusal
    ? { state: "relation_store_refused" as const, refusal }
    : { state: "relation_store_absent" as const, unrenderable: Core.unrenderablePackageRefusal(motion) };
}
function relationLaneWarning(laneTruth: ReturnType<typeof relationLaneTruth>): string[] {
  return laneTruth.state === "relation_store_refused" ? [laneTruth.refusal.message] : [];
}
function requiredFrame(core: TimelineRelationCore, motion: MotionDocument, atUs: number): MotionRelationFramePlan {
  const frame = core.compileMotionRelationAuthoringFramePlan(motion, atUs);
  if (!frame.ok) throw new Error(frame.message);
  return frame.plan;
}
function withoutMotionAndPaths(result: MotionRelationBakeResult): Omit<MotionRelationBakeResult, "motion" | "changedPaths"> {
  const { motion: _motion, changedPaths: _paths, ...facts } = result;
  return facts;
}
/** The generic transaction repeats this compiler and refuses non-idempotence before persistence. */
function compilePersistedMotion(motion: MotionDocument): MotionDocument {
  return Core.compileMotionDocumentCompositing(motion);
}
function relationCore(services: TimelineRelationAuthoringServices): TimelineRelationCore {
  const core = services.relations ?? Core as unknown as TimelineRelationCore;
  if (typeof core.inspectMotionRelations !== "function"
    || typeof core.compileMotionRelationAuthoringFramePlan !== "function"
    || typeof core.upsertMotionRelation !== "function"
    || typeof core.setMotionRelationEnabled !== "function"
    || typeof core.removeMotionRelation !== "function"
    || typeof core.detachMotionRelation !== "function"
    || typeof core.bakeMotionRelation !== "function") {
    throw new Error("Core relation authoring lifecycle exports are unavailable.");
  }
  return core;
}
function invalidArgs(message: string): MotionDebugResult { return { ok: false, error: { code: "invalid_args", message }, warnings: [] }; }
function unavailable(message: string): MotionDebugResult { return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure package loading and retry." }, warnings: [] }; }
function failure(code: string, error: unknown): MotionDebugResult { return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) }, warnings: [] }; }
