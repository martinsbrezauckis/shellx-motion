/** Read-only relation-action inspection plus exact-base, one-receipt COW materialization. */
import * as Core from "@shellx-motion/core";
import type {
  MotionDocument,
  MotionPackage,
  MotionRelationActionApplyResult,
  MotionRelationActionDefinitionMutation,
  MotionRelationActionInspection,
} from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { assertConfiguredAuthoringInputRoot } from "./authoring-root-policy.js";
import {
  isTimelineRelationActionCommand,
  readTimelineRelationActionIntent,
  type TimelineRelationActionIntent,
} from "./timeline-relation-actions.js";
import {
  commitAtomicTimelineMutation,
  isTimelineCommonEditResult,
  readHostConfiguredTimelineCommonEditArgs,
  timelineMutationFacts,
  type TimelinePackageEditServices,
} from "./timeline-package-edit.js";

type RelationActionMutationEnvelope = (MotionRelationActionDefinitionMutation | MotionRelationActionApplyResult) & {
  sourceMotionSha256: string;
  outputMotionSha256: string;
  beforeStoreSha256: string | null;
  afterStoreSha256: string | null;
  beforeDefinitionSha256: string | null;
  afterDefinitionSha256: string | null;
  /** Apply-only outer package identity, deliberately outside the persisted Core request. */
  expectedPackage?: { id: string; manifestSha256: string };
};

/** Test seam; production resolves these public Core lifecycle exports only. */
export interface TimelineRelationActionCore {
  inspectMotionRelationActions(motion: MotionDocument): MotionRelationActionInspection;
  upsertMotionRelationActionDefinition(motion: MotionDocument, input: unknown): MotionRelationActionDefinitionMutation;
  removeMotionRelationActionDefinition(motion: MotionDocument, input: unknown): MotionRelationActionDefinitionMutation;
  applyMotionRelationAction(motion: MotionDocument, input: unknown): MotionRelationActionApplyResult;
}
export interface TimelineRelationActionAuthoringServices extends TimelinePackageEditServices { relationActions?: TimelineRelationActionCore; }

export async function dispatchTimelineRelationActionAuthoringCommand(
  command: string,
  args: unknown,
  services: TimelineRelationActionAuthoringServices,
): Promise<MotionDebugResult | null> {
  if (!isTimelineRelationActionCommand(command)) return null;
  const parsed = readTimelineRelationActionIntent(command, args);
  if (!parsed) return null;
  if (!parsed.ok) return invalidArgs(parsed.problem);
  if (parsed.intent.kind === "inspect") return inspect(command, parsed.intent.packageRoot, services);
  // Caller receipt locations were rejected by the closed parser. Only the trusted host service
  // decides whether this mutation gets a mirror beyond its package-local one receipt.
  const common = readHostConfiguredTimelineCommonEditArgs(command as MotionDebugCommand, parsed.intent.edit, services);
  if (isTimelineCommonEditResult(common)) return common;
  return commit(command, parsed.intent, common, services);
}

/** One Core lifecycle mutation plus one deterministic compositing lowering, before COW. */
export function applyTimelineRelationActionIntent(
  motion: MotionDocument,
  intent: Exclude<TimelineRelationActionIntent, { kind: "inspect" }>,
  services: TimelineRelationActionAuthoringServices,
): RelationActionMutationEnvelope {
  const core = relationActionCore(services);
  const sourceMotionSha256 = Core.canonicalJsonSha256(motion);
  const before = core.inspectMotionRelationActions(motion);
  const definitionId = intent.kind === "upsert" ? intent.definition.id : intent.kind === "remove" ? intent.definitionId : intent.request.definitionId;
  const beforeDefinitionSha256 = before.definitions.find((definition) => definition.id === definitionId)?.sha256 ?? null;
  const mutation = intent.kind === "upsert"
    ? core.upsertMotionRelationActionDefinition(motion, { definition: intent.definition })
    : intent.kind === "remove"
      ? core.removeMotionRelationActionDefinition(motion, { id: intent.definitionId })
      : core.applyMotionRelationAction(motion, intent.request);
  const persistedMotion = Core.compileMotionDocumentCompositing(mutation.motion);
  const after = core.inspectMotionRelationActions(persistedMotion);
  return Object.freeze({
    ...mutation,
    motion: persistedMotion,
    sourceMotionSha256,
    outputMotionSha256: Core.canonicalJsonSha256(persistedMotion),
    beforeStoreSha256: before.storeSha256,
    afterStoreSha256: after.storeSha256,
    beforeDefinitionSha256,
    afterDefinitionSha256: after.definitions.find((definition) => definition.id === definitionId)?.sha256 ?? null,
    ...(intent.kind === "apply" ? { expectedPackage: { id: intent.expectedPackageId, manifestSha256: intent.expectedPackageManifestSha256 } } : {}),
  });
}

async function inspect(command: string, packageRoot: string, services: TimelineRelationActionAuthoringServices): Promise<MotionDebugResult> {
  if (!services.packageLoader) return unavailable("Relation-action inspection is unavailable.");
  try {
    await assertConfiguredAuthoringInputRoot(packageRoot, services.authoringInputRoots, `${command} packageRoot`);
    const pkg = await services.packageLoader(packageRoot);
    await assertConfiguredAuthoringInputRoot(pkg.root, services.authoringInputRoots, `${command} loaded package`);
    const inspection = relationActionCore(services).inspectMotionRelationActions(pkg.motion);
    const render = renderTruth(pkg.motion);
    const result = { packageId: pkg.manifest.id, motionId: pkg.motion.id, inspection, render };
    return { ok: true, visibleState: { panel: "timeline", operation: command.slice("motion.".length), ...result }, result: { ok: true, ...result }, warnings: [] };
  } catch (error) { return failure("timeline_relation_action_inspect_failed", error); }
}

function commit(
  command: string,
  intent: Exclude<TimelineRelationActionIntent, { kind: "inspect" }>,
  common: { packageRoot: string; outDir: string; receiptsRoot?: string; createdBy?: string },
  services: TimelineRelationActionAuthoringServices,
): Promise<MotionDebugResult> {
  const stem = `timeline-relation-actions-${intent.kind}`;
  return commitAtomicTimelineMutation<RelationActionMutationEnvelope>({
    ...common,
    command: command as MotionDebugCommand,
    receiptPrefix: stem,
    receiptFileName: `${stem}.receipt.json`,
    invalidCode: "timeline_relation_action_invalid",
    failureCode: "timeline_relation_action_failed",
    services,
    mutate: async (pkg) => {
      if (intent.kind === "apply") await assertExactPackageBase(pkg, intent);
      return applyTimelineRelationActionIntent(pkg.motion, intent, services);
    },
    outputFacts: relationActionMutationFacts,
    resultFacts: relationActionMutationFacts,
    visibleFacts: relationActionMutationFacts,
  });
}

/** Exact receipt/result facts from Core plus the renderer truth of the persisted ordinary output. */
export function relationActionMutationFacts(mutation: RelationActionMutationEnvelope): Record<string, unknown> {
  const render = renderTruth(mutation.motion);
  const common = {
    action: mutation.action,
    definitionId: mutation.definitionId,
    sourceMotionSha256: mutation.sourceMotionSha256,
    outputMotionSha256: mutation.outputMotionSha256,
    changedPaths: [...mutation.changedPaths],
  };
  if (mutation.action === "applied") {
    return {
      ...timelineMutationFacts(mutation), outputMotionSha256: mutation.outputMotionSha256,
      relationActions: {
        ...common,
        expectedPackage: mutation.expectedPackage,
        beforeStoreSha256: mutation.beforeStoreSha256, afterStoreSha256: mutation.afterStoreSha256,
        beforeDefinitionSha256: mutation.beforeDefinitionSha256, afterDefinitionSha256: mutation.afterDefinitionSha256,
        requestSha256: mutation.plan.requestSha256,
        planFingerprint: mutation.plan.fingerprint,
        counts: { ...mutation.plan.counts },
        createdLayerIds: [...mutation.createdObjectIds], relationIds: [...mutation.relationIds],
        beforeRelationStaticFingerprint: mutation.beforeRelationStaticFingerprint,
        afterRelationStaticFingerprint: mutation.afterRelationStaticFingerprint,
        render,
      },
    };
  }
  return {
    ...timelineMutationFacts(mutation), outputMotionSha256: mutation.outputMotionSha256,
    relationActions: {
      ...common,
      beforeStoreSha256: mutation.beforeStoreSha256, afterStoreSha256: mutation.afterStoreSha256,
      beforeDefinitionSha256: mutation.beforeDefinitionSha256, afterDefinitionSha256: mutation.afterDefinitionSha256,
      render,
    },
  };
}

async function assertExactPackageBase(
  pkg: MotionPackage,
  intent: Extract<TimelineRelationActionIntent, { kind: "apply" }>,
): Promise<void> {
  if (pkg.manifest.id !== intent.expectedPackageId) throw new Error("Relation action apply has stale expectedPackageId.");
  const manifestSha256 = await Core.hashPackageFile(Core.resolvePackageAsset(pkg, "manifest.json"));
  if (manifestSha256 !== intent.expectedPackageManifestSha256) throw new Error("Relation action apply has stale expectedPackageManifestSha256.");
}
function renderTruth(motion: MotionDocument) {
  return { renderLanesFor: Core.renderLanesFor(motion), unrenderablePackageRefusal: Core.unrenderablePackageRefusal(motion) };
}
function relationActionCore(services: TimelineRelationActionAuthoringServices): TimelineRelationActionCore {
  const core = services.relationActions ?? Core as unknown as TimelineRelationActionCore;
  if (typeof core.inspectMotionRelationActions !== "function"
    || typeof core.upsertMotionRelationActionDefinition !== "function"
    || typeof core.removeMotionRelationActionDefinition !== "function"
    || typeof core.applyMotionRelationAction !== "function") {
    throw new Error("Core relation-action lifecycle exports are unavailable.");
  }
  return core;
}
function invalidArgs(message: string): MotionDebugResult { return { ok: false, error: { code: "invalid_args", message }, warnings: [] }; }
function unavailable(message: string): MotionDebugResult { return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure package loading and retry." }, warnings: [] }; }
function failure(code: string, error: unknown): MotionDebugResult { return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) }, warnings: [] }; }
