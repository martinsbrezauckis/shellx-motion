/** Debug COW dispatch and receipt facts for the persisted host-authorized C2 layout-gap store. */
import * as Core from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { assertConfiguredAuthoringInputRoot } from "./authoring-root-policy.js";
import { C2_LAYOUT_GAP_ANIMATION_CONTINUATION } from "./package-edit-transaction.js";
import {
  abortPreparedLayoutGapAuthorityPair,
  finalizePreparedLayoutGapAuthorityPair,
  prepareLayoutGapAnimationContinuationPair,
  prepareLayoutGapTeardownRestorationPair,
} from "./timeline-layout-gap-animation-authority.js";
import {
  applyTimelineLayoutGapAnimationIntent,
} from "./timeline-layout-gap-animation-authoring-mutation.js";
import type {
  LayoutGapAnimationMutation,
  TimelineLayoutGapAnimationAuthoringServices,
} from "./timeline-layout-gap-animation-authoring-types.js";
import {
  isTimelineLayoutGapAnimationCommand,
  readTimelineLayoutGapAnimationIntent,
  type TimelineLayoutGapAnimationIntent,
} from "./timeline-layout-gap-animation.js";
import {
  commitAtomicTimelineMutation,
  isTimelineCommonEditResult,
  readHostConfiguredTimelineCommonEditArgs,
  timelineMutationFacts,
} from "./timeline-package-edit.js";

export type {
  TimelineLayoutGapAnimationAuthoringServices,
  TimelineLayoutGapAnimationCore,
} from "./timeline-layout-gap-animation-authoring-types.js";
export { applyTimelineLayoutGapAnimationIntent } from "./timeline-layout-gap-animation-authoring-mutation.js";

export async function dispatchTimelineLayoutGapAnimationAuthoringCommand(
  command: string,
  args: unknown,
  services: TimelineLayoutGapAnimationAuthoringServices,
): Promise<MotionDebugResult | null> {
  if (!isTimelineLayoutGapAnimationCommand(command)) return null;

  const parsed = readTimelineLayoutGapAnimationIntent(command, args);
  if (!parsed) return null;
  if (!parsed.ok) return invalid(parsed.problem);

  if (parsed.intent.kind === "inspect") {
    return await inspect(command, parsed.intent, services);
  }
  const common = readHostConfiguredTimelineCommonEditArgs(
    command as MotionDebugCommand,
    parsed.intent.edit,
    services,
  );
  if (isTimelineCommonEditResult(common)) return common;
  if (!services.receiptsRoot) {
    return unavailable("Layout gap animation mutations require a host-configured receiptsRoot.");
  }
  return await commit(
    command,
    parsed.intent,
    { ...common, receiptsRoot: services.receiptsRoot },
    services,
  );
}

async function inspect(
  command: string,
  intent: Extract<TimelineLayoutGapAnimationIntent, { kind: "inspect" }>,
  services: TimelineLayoutGapAnimationAuthoringServices,
): Promise<MotionDebugResult> {
  if (!services.packageLoader) return unavailable("Layout gap animation inspection is unavailable.");

  try {
    await assertConfiguredAuthoringInputRoot(
      intent.packageRoot,
      services.authoringInputRoots,
      `${command} packageRoot`,
    );
    const pkg = await services.packageLoader(intent.packageRoot);
    await assertConfiguredAuthoringInputRoot(
      pkg.root,
      services.authoringInputRoots,
      `${command} loaded package`,
    );
    const inspection = services.layoutGapAnimation
      ?.inspectMotionLayoutGapAnimation(pkg.motion)
      ?? Core.inspectMotionLayoutGapAnimation(pkg.motion);
    const render = Core.unrenderablePackageRefusal(pkg.motion);
    return {
      ok: true,
      visibleState: {
        panel: "timeline",
        operation: command.slice("motion.".length),
        packageId: pkg.manifest.id,
        motionId: pkg.motion.id,
        inspection,
        render,
      },
      result: {
        ok: true,
        packageId: pkg.manifest.id,
        motionId: pkg.motion.id,
        inspection,
        render,
      },
      warnings: render ? [render.message] : [],
    };
  } catch (error) {
    return failure("timeline_layout_gap_animation_inspect_failed", error);
  }
}

function commit(
  command: string,
  intent: Exclude<TimelineLayoutGapAnimationIntent, { kind: "inspect" }>,
  common: {
    packageRoot: string;
    outDir: string;
    receiptsRoot: string;
    createdBy?: string;
  },
  services: TimelineLayoutGapAnimationAuthoringServices,
): Promise<MotionDebugResult> {
  const stem = `timeline-layout-gap-animation-${intent.kind.replaceAll(".", "-")}`;
  return commitAtomicTimelineMutation<LayoutGapAnimationMutation>({
    ...common,
    command: command as MotionDebugCommand,
    receiptPrefix: stem,
    receiptFileName: `${stem}.receipt.json`,
    invalidCode: "timeline_layout_gap_animation_invalid",
    failureCode: "timeline_layout_gap_animation_failed",
    services,
    mutate: async (pkg) => await applyTimelineLayoutGapAnimationIntent(
      pkg,
      intent,
      common.receiptsRoot,
      services,
    ),
    layoutGapAnimationContinuation: C2_LAYOUT_GAP_ANIMATION_CONTINUATION,
    hostAuthorityPair: ({ pkg, mutation, receipt }) => ({
      prepare: async (preparation) => {
      const pairHooks = services.layoutGapAuthorityPairHooks;
      if (mutation.action === "track_removed" && mutation.afterStoreSha256 === null) {
        return await prepareLayoutGapTeardownRestorationPair({
          continuation: mutation.continuation,
          stagedPackageRoot: preparation.stagedPackageRoot,
          expectedPackageRoot: preparation.expectedPackageRoot,
          stagedManifestPath: preparation.manifestPath,
          stagedMotionPath: preparation.motionPath,
          persistedMotionSha256: preparation.persistedMotionSha256,
          receiptsRoot: preparation.receiptsRoot,
          packageId: pkg.manifest.id,
          receipt,
          ...(pairHooks ? { pairHooks } : {}),
        });
      }
      return await prepareLayoutGapAnimationContinuationPair({
        continuation: mutation.continuation,
        stagedPackageRoot: preparation.stagedPackageRoot,
        expectedPackageRoot: preparation.expectedPackageRoot,
        stagedManifestPath: preparation.manifestPath,
        stagedMotionPath: preparation.motionPath,
        persistedMotionSha256: preparation.persistedMotionSha256,
        receiptsRoot: preparation.receiptsRoot,
        packageId: pkg.manifest.id,
        receipt,
        ...(pairHooks ? { pairHooks } : {}),
      });
      },
      finalize: async (prepared, hostCommit) => await finalizePreparedLayoutGapAuthorityPair({
        prepared,
        commit: hostCommit,
        packageId: pkg.manifest.id,
      }),
      abort: async (prepared) => await abortPreparedLayoutGapAuthorityPair(prepared),
    }),
    outputFacts: facts,
    resultFacts: facts,
    visibleFacts: facts,
    receiptWarnings: (mutation) => {
      const render = renderTruth(mutation);
      return render ? [render.message] : [];
    },
  });
}

function facts(mutation: LayoutGapAnimationMutation): Record<string, unknown> {
  const render = renderTruth(mutation);
  return {
    ...timelineMutationFacts(mutation),
    layoutGapAnimation: {
      schema: "shellx-motion/layout-gap-animation@1",
      action: mutation.action,
      request: mutation.request,
      requestSha256: mutation.requestSha256,
      application: mutation.application,
      track: {
        id: mutation.trackId,
        beforeSha256: mutation.beforeTrackSha256,
        afterSha256: mutation.afterTrackSha256,
      },
      keyframe: {
        beforeSha256: mutation.beforeKeyframeSha256,
        afterSha256: mutation.afterKeyframeSha256,
        index: mutation.index,
        ...(mutation.previousIndex === undefined
          ? {}
          : { previousIndex: mutation.previousIndex }),
      },
      store: {
        beforeSha256: mutation.beforeStoreSha256,
        afterSha256: mutation.afterStoreSha256,
      },
      changedPaths: mutation.changedPaths,
      teardown: mutation.action === "track_removed" && mutation.afterStoreSha256 === null
        ? "restores-static-layout-remove-authority"
        : "successor-authority-persisted",
    },
    motionIdentity: {
      sourceCanonicalSha256: mutation.sourceMotionSha256,
      outputCanonicalSha256: mutation.outputMotionSha256,
      outputPersistedPrettyJsonSha256: mutation.persistedMotionSha256,
    },
    cow: {
      source: "unchanged",
      output: "one-atomic-revision",
      compositingIdempotent: mutation.compositingIdempotent,
      canonicalReopen: "staged-package",
    },
    render,
  };
}

function renderTruth(mutation: LayoutGapAnimationMutation) {
  const render = Core.unrenderablePackageRefusal(mutation.motion);
  if (mutation.afterStoreSha256 !== null && !render) {
    throw new Error("Active layout gap animation unexpectedly became renderable.");
  }
  return render;
}

function invalid(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

function unavailable(message: string): MotionDebugResult {
  return {
    ok: false,
    error: {
      code: "capability_unavailable",
      message,
      suggestedAction: "Configure the required host capability and retry.",
    },
    warnings: [],
  };
}

function failure(code: string, error: unknown): MotionDebugResult {
  return {
    ok: false,
    error: { code, message: error instanceof Error ? error.message : String(error) },
    warnings: [],
  };
}
