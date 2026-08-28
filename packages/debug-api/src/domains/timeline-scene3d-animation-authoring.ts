/** Read-only inspection and host-receipted COW authoring for persisted scene3d animation tracks. */
import * as Core from "@shellx-motion/core";
import type { MotionDocument, MotionScene3DAnimationInspection, MotionScene3DAnimationMutation } from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { assertConfiguredAuthoringInputRoot } from "./authoring-root-policy.js";
import {
  isTimelineScene3DAnimationCommand,
  readTimelineScene3DAnimationIntent,
  type TimelineScene3DAnimationIntent,
} from "./timeline-scene3d-animation.js";
import {
  commitAtomicTimelineMutation,
  isTimelineCommonEditResult,
  readHostConfiguredTimelineCommonEditArgs,
  timelineMutationFacts,
  type TimelinePackageEditServices,
} from "./timeline-package-edit.js";

type Scene3DAnimationMutation = MotionScene3DAnimationMutation & {
  sourceMotionSha256: string;
  outputMotionSha256: string;
  persistedMotionSha256: string;
  compositingIdempotent: true;
};

/** Test seam; production resolves the six closed Core operations from the public barrel. */
export interface TimelineScene3DAnimationCore {
  inspectMotionScene3DAnimation(motion: MotionDocument): MotionScene3DAnimationInspection;
  upsertMotionScene3DAnimationTrack(motion: MotionDocument, input: unknown): MotionScene3DAnimationMutation;
  removeMotionScene3DAnimationTrack(motion: MotionDocument, input: unknown): MotionScene3DAnimationMutation;
  upsertMotionScene3DAnimationKeyframe(motion: MotionDocument, input: unknown): MotionScene3DAnimationMutation;
  deleteMotionScene3DAnimationKeyframe(motion: MotionDocument, input: unknown): MotionScene3DAnimationMutation;
  moveMotionScene3DAnimationKeyframe(motion: MotionDocument, input: unknown): MotionScene3DAnimationMutation;
}
export interface TimelineScene3DAnimationAuthoringServices extends TimelinePackageEditServices { scene3dAnimation?: TimelineScene3DAnimationCore; }

export async function dispatchTimelineScene3DAnimationAuthoringCommand(
  command: string,
  args: unknown,
  services: TimelineScene3DAnimationAuthoringServices,
): Promise<MotionDebugResult | null> {
  if (!isTimelineScene3DAnimationCommand(command)) return null;
  const parsed = readTimelineScene3DAnimationIntent(command, args);
  if (!parsed) return null;
  if (!parsed.ok) return invalidArgs(parsed.problem);
  if (parsed.intent.kind === "inspect") return inspect(command, parsed.intent, services);
  // Caller receipt paths are absent from this closed transport. The Debug host alone selects any
  // mirror and all mutations require it, while the package receipt remains COW-owned.
  const common = readHostConfiguredTimelineCommonEditArgs(command as MotionDebugCommand, parsed.intent.edit, services);
  if (isTimelineCommonEditResult(common)) return common;
  if (!services.receiptsRoot) return unavailable("Scene3d animation mutations require a host-configured receiptsRoot.");
  return commit(command, parsed.intent, { ...common, receiptsRoot: services.receiptsRoot }, services);
}

/** One Core mutation plus deterministic compositing-idempotent persistence before package COW. */
export function applyTimelineScene3DAnimationIntent(
  motion: MotionDocument,
  intent: Exclude<TimelineScene3DAnimationIntent, { kind: "inspect" }>,
  services: TimelineScene3DAnimationAuthoringServices,
): Scene3DAnimationMutation {
  const core = scene3dAnimationCore(services);
  const sourceMotionSha256 = Core.canonicalJsonSha256(motion);
  const mutation = intent.kind === "track.upsert"
    ? core.upsertMotionScene3DAnimationTrack(motion, { track: intent.track })
    : intent.kind === "track.remove"
      ? core.removeMotionScene3DAnimationTrack(motion, { trackId: intent.trackId })
      : intent.kind === "keyframe.upsert"
        ? core.upsertMotionScene3DAnimationKeyframe(motion, { trackId: intent.trackId, keyframe: intent.keyframe })
        : intent.kind === "keyframe.delete"
          ? core.deleteMotionScene3DAnimationKeyframe(motion, { trackId: intent.trackId, atUs: intent.atUs })
          : core.moveMotionScene3DAnimationKeyframe(motion, { trackId: intent.trackId, fromAtUs: intent.fromAtUs, toAtUs: intent.toAtUs });
  const persisted = Core.compileMotionDocumentCompositing(mutation.motion);
  const outputMotionSha256 = Core.canonicalJsonSha256(persisted);
  if (Core.canonicalJsonSha256(Core.compileMotionDocumentCompositing(persisted)) !== outputMotionSha256) {
    throw new Error("Scene3d animation compositing compilation is not idempotent before persistence.");
  }
  return Object.freeze({
    ...mutation,
    motion: persisted,
    sourceMotionSha256,
    outputMotionSha256,
    persistedMotionSha256: Core.hashBuffer(Buffer.from(`${JSON.stringify(persisted, null, 2)}\n`, "utf8")),
    compositingIdempotent: true as const,
  });
}

async function inspect(
  command: string,
  intent: Extract<TimelineScene3DAnimationIntent, { kind: "inspect" }>,
  services: TimelineScene3DAnimationAuthoringServices,
): Promise<MotionDebugResult> {
  if (!services.packageLoader) return unavailable("Scene3d animation inspection is unavailable.");
  try {
    await assertConfiguredAuthoringInputRoot(intent.packageRoot, services.authoringInputRoots, `${command} packageRoot`);
    const pkg = await services.packageLoader(intent.packageRoot);
    await assertConfiguredAuthoringInputRoot(pkg.root, services.authoringInputRoots, `${command} loaded package`);
    const inspection = scene3dAnimationCore(services).inspectMotionScene3DAnimation(pkg.motion);
    const render = renderTruth(pkg.motion);
    const result = {
      packageId: pkg.manifest.id,
      motionId: pkg.motion.id,
      motionSha256: Core.canonicalJsonSha256(pkg.motion),
      inspection,
      render,
    };
    return {
      ok: true,
      visibleState: { panel: "timeline", operation: command.slice("motion.".length), ...result },
      result: { ok: true, ...result },
      warnings: renderWarnings(render),
    };
  } catch (error) { return failure("timeline_scene3d_animation_inspect_failed", error); }
}

function commit(
  command: string,
  intent: Exclude<TimelineScene3DAnimationIntent, { kind: "inspect" }>,
  common: { packageRoot: string; outDir: string; receiptsRoot?: string; createdBy?: string },
  services: TimelineScene3DAnimationAuthoringServices,
): Promise<MotionDebugResult> {
  const stem = `timeline-scene3d-animation-${intent.kind.replaceAll(".", "-")}`;
  return commitAtomicTimelineMutation<Scene3DAnimationMutation>({
    ...common,
    command: command as MotionDebugCommand,
    receiptPrefix: stem,
    receiptFileName: `${stem}.receipt.json`,
    invalidCode: "timeline_scene3d_animation_invalid",
    failureCode: "timeline_scene3d_animation_failed",
    services,
    mutate: (pkg) => applyTimelineScene3DAnimationIntent(pkg.motion, intent, services),
    outputFacts: scene3dAnimationFacts,
    resultFacts: scene3dAnimationFacts,
    visibleFacts: scene3dAnimationFacts,
    // O6 made one direct renderer-browser PNG route renderable, but this generic Debug surface
    // remains refused. Keep the COW receipt warning (and therefore its warning status) tied to
    // that actual caller limitation rather than incorrectly calling the package unrenderable.
    receiptWarnings: (mutation) => renderWarnings(renderTruth(mutation.motion)),
  });
}

/** Exact durable facts: source/output identities, mutation identity, static scene locator, COW, and route-specific render truth. */
export function scene3dAnimationFacts(mutation: Scene3DAnimationMutation): Record<string, unknown> {
  const render = renderTruth(mutation.motion);
  return {
    ...timelineMutationFacts(mutation),
    scene3dAnimation: {
      schema: "shellx-motion/scene3d-animation@1",
      action: mutation.action,
      request: mutation.request,
      requestSha256: mutation.requestSha256,
      track: {
        id: mutation.trackId,
        locator: mutation.locator,
        beforeSha256: mutation.beforeTrackSha256,
        afterSha256: mutation.afterTrackSha256,
      },
      keyframe: {
        beforeSha256: mutation.beforeKeyframeSha256,
        afterSha256: mutation.afterKeyframeSha256,
        index: mutation.index,
        ...(mutation.previousIndex === undefined ? {} : { previousIndex: mutation.previousIndex }),
      },
      store: { beforeSha256: mutation.beforeStoreSha256, afterSha256: mutation.afterStoreSha256 },
      staticScene: { locator: mutation.locator, topology: "unchanged", assets: "unchanged" },
    },
    motionIdentity: {
      sourceCanonicalSha256: mutation.sourceMotionSha256,
      outputCanonicalSha256: mutation.outputMotionSha256,
      outputPersistedPrettyJsonSha256: mutation.persistedMotionSha256,
    },
    cow: { source: "unchanged", output: "one-atomic-revision", compositingIdempotent: mutation.compositingIdempotent, canonicalReopen: "staged-package" },
    render,
  };
}

function renderTruth(motion: MotionDocument) {
  return {
    renderLanesFor: Core.renderLanesFor(motion),
    unrenderablePackageRefusal: Core.unrenderablePackageRefusal(motion),
    // `renderLanesFor` includes O6's sole direct renderer-browser PNG route. It is deliberately
    // separate from this generic Debug preview, which still uses the legacy GPU static planner.
    genericDebugGpuPreviewRefusal: Core.motionScene3DAnimationLaneRefusal(motion, "gpu-static") ?? null,
  };
}

function renderWarnings(render: ReturnType<typeof renderTruth>): string[] {
  return render.genericDebugGpuPreviewRefusal
    ? ["Debug GPU preview does not admit document scene3dAnimation@1; the strict O6 lowerer is available only through the direct @shellx-motion/renderer-browser renderMotionGpuPreview API."]
    : render.unrenderablePackageRefusal ? [render.unrenderablePackageRefusal.message]
      : [];
}
function scene3dAnimationCore(services: TimelineScene3DAnimationAuthoringServices): TimelineScene3DAnimationCore {
  const core = services.scene3dAnimation ?? Core as unknown as TimelineScene3DAnimationCore;
  if (typeof core.inspectMotionScene3DAnimation !== "function"
    || typeof core.upsertMotionScene3DAnimationTrack !== "function"
    || typeof core.removeMotionScene3DAnimationTrack !== "function"
    || typeof core.upsertMotionScene3DAnimationKeyframe !== "function"
    || typeof core.deleteMotionScene3DAnimationKeyframe !== "function"
    || typeof core.moveMotionScene3DAnimationKeyframe !== "function") {
    throw new Error("Core scene3d animation lifecycle exports are unavailable.");
  }
  return core;
}
function invalidArgs(message: string): MotionDebugResult { return { ok: false, error: { code: "invalid_args", message }, warnings: [] }; }
function unavailable(message: string): MotionDebugResult { return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure the required host capability and retry." }, warnings: [] }; }
function failure(code: string, error: unknown): MotionDebugResult { return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) }, warnings: [] }; }
