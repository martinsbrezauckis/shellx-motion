/**
 * Strict GPU admission for durable final segments.
 *
 * This is deliberately an internal, already-admitted host: it creates no
 * nested governor job and it never accepts a browser, proof, store path, or
 * producer from a CLI/Debug/SDK caller.  A short pre-store Chromium session
 * establishes the immutable host verdict, closes successfully, and every
 * later range rechecks that its own pre-contained session matches it.
 */
import { createHash } from "node:crypto";
import {
  canonicalJson,
  compileGpuSceneBehaviorStaticPlan,
  compileGpuHybridTextureRequests,
  compileGpuSceneStaticPlan,
  hashFile,
  motionBrowserExecutableVerificationProblem,
  resolveMotionBrowserExecutable,
  streamingFrameTimestampMs,
  type LocalMotionJobContext,
  type MotionPackage
} from "@shellx-motion/core";
import { fingerprintGpuStaticScene, GPU_PAGE_PIPELINE_CATALOG, gpuLoadedPackageInputHashes, prepareGpuSegmentedHybridAdmission, type GpuSegmentedHybridAdmission, type GpuStreamingStaticPlan } from "@shellx-motion/renderer-browser";
import {
  gpuVideoStagingEvidence,
  prepareAdmittedGpuDelivery,
  type PreparedAdmittedGpuDelivery
} from "./streaming-final-gpu.js";
import { bindGpuVideoAudioSnapshots } from "./streaming-final-gpu-audio.js";
import { fingerprintResolvedMotionPackageContent } from "./segmented-final-internal/package-content-fingerprint.js";
import type { FfmpegRunner } from "./index.js";
import type {
  RenderSegmentGpuHybridCapturePlan,
  RenderSegmentGpuHybridIdentity,
  RenderSegmentGpuStandardIdentity
} from "./segmented-final-internal/render-segment-store-types.js";
import type { RenderSegmentGpuBehaviorIdentity } from "./segmented-final-internal/render-segment-gpu-behavior-types.js";
import type { RenderSegmentGpuEffectModuleIdentity } from "./segmented-final-internal/render-segment-gpu-effect-module-types.js";
import { gpuHybridCapturePlanSha256 } from "./segmented-final-internal/render-segment-store-identity.js";
import type {
  RenderSegmentSpoolTimelineFacts
} from "./segmented-final-internal/render-segment-spool-types.js";
import { createGpuRangeProducerFactory } from "./segmented-final-gpu-host-range.js";
import { compileSegmentedGpuBehaviorSchedule } from "./segmented-final-gpu-behavior-schedule.js";
import type { PreparedSegmentedGpuHost, SegmentedGpuHostPolicy, SegmentedGpuStaticPreflight } from "./segmented-final-gpu-host-types.js";
import { assertResolvedSegmentedGpuBrowserIdentity, createClosedSegmentedGpuHostVerdict } from "./segmented-final-gpu-host-verdict.js";
export type { PreparedSegmentedGpuHost, SegmentedGpuHostPolicy } from "./segmented-final-gpu-host-types.js";

const GPU_SEGMENTED_IDENTITY_SCHEMA = "shellx-motion/gpu-segmented-identity@1" as const;
const SHA256 = /^[a-f0-9]{64}$/;

/**
 * Builds the one immutable GPU host identity inside the outer segmented
 * governor admission.  It intentionally creates and closes a zero-frame,
 * pre-contained Chromium session before the durable store is opened; this
 * prevents a resumed prefix from being bound to caller supplied or stale
 * adapter facts.  Range sessions revalidate against this closure.
 */
export async function prepareAdmittedSegmentedGpuHost(input: {
  pkg: MotionPackage;
  packageContentSha256: string;
  packageContentExpectedFileHashes?: Readonly<Record<string, string>>;
  timeline: RenderSegmentSpoolTimelineFacts;
  job: LocalMotionJobContext;
  maxProcessTreeRssBytes: number;
  runner: FfmpegRunner;
  policy?: SegmentedGpuHostPolicy;
  /** Already-pure static resolution; it deliberately holds no live lease. */
  preflight?: SegmentedGpuStaticPreflight;
  media?: Pick<
    import("./segmented-final-internal/segmented-final-adapter-types.js").RenderSegmentedFinalInput,
    "audioPath" | "audio" | "audioTracks" | "inputRoots"
  >;
  /** Internal test hook for the frozen-source/package-content swap regression. */
  testAfterHybridSourceFreeze?: () => void | Promise<void>;
}): Promise<PreparedSegmentedGpuHost> {
  if (!SHA256.test(input.packageContentSha256)) {
    throw new Error("GPU segmented delivery requires the current complete package content hash inside its admitted job.");
  }
  const behaviorCompiled = input.pkg.motion.behaviors === undefined ? undefined : compileGpuSceneBehaviorStaticPlan(input.pkg.motion);
  if (behaviorCompiled && !behaviorCompiled.ok) throw new Error(behaviorCompiled.failure.message);
  if (input.preflight && behaviorCompiled && (!input.preflight.behaviorStaticPlan || canonicalJson(input.preflight.behaviorStaticPlan) !== canonicalJson(behaviorCompiled.plan) || canonicalJson(input.preflight.staticPlan) !== canonicalJson(behaviorCompiled.plan.basePlan))) {
    throw new Error("GPU segmented behavior host does not bind its exact retained Core behavior/base plans.");
  }
  const behaviorStaticPlan = input.preflight?.behaviorStaticPlan ?? (behaviorCompiled?.ok ? behaviorCompiled.plan : undefined);
  const staticCompiled = input.preflight
    ? { ok: true as const, plan: input.preflight.staticPlan }
    : input.pkg.motion.behaviors === undefined
      ? compileGpuSceneStaticPlan(input.pkg.motion)
      : behaviorCompiled!.ok ? { ok: true as const, plan: behaviorCompiled!.plan.basePlan } : behaviorCompiled!;
  if (!staticCompiled.ok) throw new Error(staticCompiled.failure.message);
  const staticPlan = staticCompiled.plan as GpuStreamingStaticPlan;
  const hasEffectModules = (staticPlan.effectModules?.length ?? 0) > 0;
  if (hasEffectModules && !input.preflight?.effectModuleUse) {
    throw new Error("GPU segmented effect modules require a trusted pure host resolution before admitted runtime setup.");
  }
  if (!hasEffectModules && input.preflight?.effectModuleUse) {
    throw new Error("GPU segmented effect-module host received an unused opaque resolution.");
  }
  if (hasEffectModules && (staticPlan.hybridTextures?.length ?? 0) > 0) {
    throw new Error("GPU segmented delivery does not combine governed effect modules with B2 hybrid surfaces.");
  }
  const provisionalInput = {
    pkg: input.pkg,
    frameLane: "gpu" as const,
    outputPath: ".segmented-gpu-host-unused",
    ...input.media,
    toolPolicy: { ...(input.policy ? { gpu: input.policy } : {}) }
  };
  let admitted: Awaited<ReturnType<typeof prepareAdmittedGpuDelivery>> | undefined;
  try {
    const location = resolveMotionBrowserExecutable();
    const executableProblem = motionBrowserExecutableVerificationProblem(location);
    if (executableProblem) throw new Error("GPU segmented delivery could not verify its trusted Chromium executable.");
    const executableSha256 = await hashFile(location.executable);
    const hybridPreparation = staticCompiled.plan.hybridTextures?.length
      ? await prepareGpuSegmentedHybridAdmission({
        pkg: input.pkg,
        staticPlan: staticCompiled.plan,
        browser: {
          name: "chromium",
          executableSha256,
          runtimePolicy: "borrowed-precontained-chromium-data-only-no-network"
        }
      })
      : undefined;
    const sourceAssetRef = hybridPreparation?.identity.sourceSnapshot.assetRef;
    const sourceSnapshotSha256 = hybridPreparation?.identity.sourceSnapshot.sourceSnapshotSha256;
    await input.testAfterHybridSourceFreeze?.();
    const loaderHash = sourceAssetRef ? input.packageContentExpectedFileHashes?.[sourceAssetRef] : undefined;
    if (loaderHash !== undefined && loaderHash !== sourceSnapshotSha256) {
      throw new Error("GPU segmented hybrid Browser snapshot conflicts with the loader-owned source hash.");
    }
    const packageContentExpectedFileHashes = hybridPreparation && sourceAssetRef && sourceSnapshotSha256
      ? Object.freeze({ ...input.packageContentExpectedFileHashes, [sourceAssetRef]: sourceSnapshotSha256 })
      : input.packageContentExpectedFileHashes;
    if (hybridPreparation) {
      const rechecked = await fingerprintResolvedMotionPackageContent(input.pkg.root, {
        ...(packageContentExpectedFileHashes ? { expectedFileHashes: packageContentExpectedFileHashes } : {})
      });
      if (rechecked.sha256 !== input.packageContentSha256) {
        throw new Error("GPU segmented hybrid source changed while Browser admission froze its immutable snapshot.");
      }
    }
    admitted = await prepareAdmittedGpuDelivery(
      provisionalInput,
      staticCompiled.plan,
      {
        job: {
          admission: "pre-acquired",
          jobId: input.job.jobId,
          scratchRoot: input.job.scratchRoot,
          maxProcessTreeRssBytes: input.maxProcessTreeRssBytes,
          signal: input.job.signal,
          watchProcess: input.job.watchProcess,
          reportSandbox: input.job.reportSandbox
        },
        runner: input.runner,
        ...(hybridPreparation ? {
          hybridTopologyPreflight: {
            sourceSnapshot: hybridPreparation.identity.sourceSnapshot,
            dynamicTexture: hybridPreparation.dynamicTexture
          }
        } : {})
      },
      behaviorStaticPlan
    );
    if (!admitted.ok) throw new Error(admitted.failure.message);
    const behaviorSchedule = behaviorStaticPlan
      ? compileSegmentedGpuBehaviorSchedule({ motion: input.pkg.motion, timeline: input.timeline, resources: admitted.delivery.resources })
      : undefined;
    const resourceInputHashes = Object.freeze({
      ...admitted.delivery.resources.inputHashes,
      ...admitted.delivery.video?.inputHashes
    });
    const staticScene = fingerprintGpuStaticScene({
      motion: input.pkg.motion,
      loadedInputHashes: gpuLoadedPackageInputHashes(input.pkg),
      resourceInputHashes,
      pipelineCatalogSha256: GPU_PAGE_PIPELINE_CATALOG.sha256
    });
    const hostIdentity = await createClosedSegmentedGpuHostVerdict({
      resources: admitted.delivery,
      location,
      executableSha256,
      job: input.job,
      maxProcessTreeRssBytes: input.maxProcessTreeRssBytes,
      policy: input.policy,
      hybridPreparation
    });
    const verdict = hostIdentity.verdict;
    // The zero-frame verdict has closed successfully. Re-hash before the store
    // can exist, so its immutable executable identity covers the full verdict.
    await assertResolvedSegmentedGpuBrowserIdentity(location, executableSha256);
    const hybridCapturePlan = hostIdentity.hybridAdmission
      ? compileHybridCapturePlan(input.pkg, input.timeline, hostIdentity.hybridAdmission)
      : undefined;
    const commonIdentity = {
      packageContentSha256: input.packageContentSha256,
      pipelineCatalogSha256: GPU_PAGE_PIPELINE_CATALOG.sha256,
      staticPlan: Object.freeze({
        fingerprint: staticPlan.fingerprint,
        documentFingerprint: staticPlan.documentFingerprint,
        resourceReferencesSha256: sha256Canonical(staticPlan.resources),
        canonicalFrameCount: staticPlan.canonicalFrameCount,
        maxEnvironmentCount: staticPlan.maxima.maxEnvironmentCount
      }),
      staticScene: Object.freeze({ sha256: staticScene.sha256, inputHashesSha256: staticScene.inputHashesSha256 }),
      hostVerdict: verdict,
      ...(admitted.delivery.video ? {
        videoStaging: Object.freeze({
          ledgerSha256: sha256Canonical(gpuVideoStagingEvidence(admitted.delivery.video).ledger),
          pcmSha256: gpuVideoStagingEvidence(admitted.delivery.video).pcmSha256
        })
      } : {})
    };
    const identity: RenderSegmentGpuStandardIdentity | RenderSegmentGpuHybridIdentity | RenderSegmentGpuEffectModuleIdentity | RenderSegmentGpuBehaviorIdentity = behaviorStaticPlan
      ? Object.freeze({
        ...commonIdentity,
        schema: "shellx-motion/gpu-behavior-segmented-identity@1" as const,
        behaviors: Object.freeze({
          staticFingerprint: behaviorStaticPlan.fingerprint,
          baseStaticFingerprint: behaviorStaticPlan.baseStaticFingerprint,
          behaviorStaticFingerprint: behaviorStaticPlan.behaviorStaticFingerprint,
          behaviorSourceSha256: behaviorStaticPlan.behaviorSourceSha256,
          targetLayerIds: Object.freeze([...behaviorStaticPlan.targetLayerIds]),
          staticBudget: Object.freeze({ ...behaviorStaticPlan.budget }),
          frames: behaviorSchedule!.frames,
          framePlanSequenceSha256: behaviorSchedule!.framePlanSequenceSha256,
          frameBudgetSequenceSha256: behaviorSchedule!.frameBudgetSequenceSha256
        })
      })
      : hasEffectModules
      ? Object.freeze({
        ...commonIdentity,
        schema: "shellx-motion/gpu-effect-module-segmented-identity@1" as const,
        effectModules: Object.freeze({
          schema: "shellx-motion/gpu-segmented-effect-module-descriptors@1" as const,
          descriptors: Object.freeze([...(staticPlan.effectModules ?? [])]),
          descriptorSequenceSha256: sha256Canonical(staticPlan.effectModules!)
        })
      })
      : hostIdentity.hybridAdmission && hybridCapturePlan
      ? Object.freeze({
        ...commonIdentity,
        schema: "shellx-motion/gpu-hybrid-segmented-identity@1" as const,
        hybrid: Object.freeze({
          admission: hostIdentity.hybridAdmission.identity,
          capturePlan: hybridCapturePlan
        })
      })
      : Object.freeze({ ...commonIdentity, schema: GPU_SEGMENTED_IDENTITY_SCHEMA });
    const audio = admitted.delivery.video
      ? bindGpuVideoAudioSnapshots(provisionalInput, admitted.delivery.video.audioSnapshots)
      : {};
    const createRangeProducer = createGpuRangeProducerFactory({
      pkg: input.pkg,
      timeline: input.timeline,
      staticPlan,
      ...(behaviorStaticPlan ? { behaviorStaticPlan } : {}),
      delivery: admitted.delivery,
      identity,
      location,
      executableSha256,
      policy: input.policy,
      ...(input.preflight?.effectModuleUse ? { effectModuleUse: input.preflight.effectModuleUse } : {}),
      ...(hostIdentity.hybridAdmission && hybridCapturePlan ? {
        hybrid: { admission: hostIdentity.hybridAdmission, capturePlan: hybridCapturePlan }
      } : {})
    });
    return {
      producer: Object.freeze({ frameLane: "gpu", identity }),
      createRangeProducer,
      audio,
      ...(packageContentExpectedFileHashes ? { packageContentExpectedFileHashes } : {}),
      ...(admitted.delivery.stagingRoot && admitted.delivery.stagingAuthority ? {
        finalAudioSnapshotStaging: {
          stagingRoot: admitted.delivery.stagingRoot,
          authority: admitted.delivery.stagingAuthority
        }
      } : {}),
      release: admitted.delivery.release
    };
  } catch (error) {
    if (!admitted?.ok) throw error;
    try {
      await admitted.delivery.release();
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        "GPU segmented host admission failed and its admitted delivery cleanup also failed."
      );
    }
    throw error;
  }
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Core remains the sole exact-time authority for the frozen source snapshot. */
function compileHybridCapturePlan(
  pkg: MotionPackage,
  timeline: RenderSegmentSpoolTimelineFacts,
  admission: GpuSegmentedHybridAdmission
): RenderSegmentGpuHybridCapturePlan {
  const snapshots = new Map([[admission.identity.sourceSnapshot.layerId, admission.identity.sourceSnapshot]]);
  const entries: Array<RenderSegmentGpuHybridCapturePlan["entries"][number]> = [];
  for (let index = 0; index < timeline.frameCount; index += 1) {
    const atMs = streamingFrameTimestampMs(index, timeline.fps, timeline.durationMs);
    // The Core compiler itself decides whether the frozen texture is active at
    // this exact scalar timestamp. It requires an empty snapshot map when no
    // texture is active, rather than accepting an unused source by accident.
    const inactive = compileGpuHybridTextureRequests({ motion: pkg.motion, atUs: Math.round(atMs * 1_000), snapshots: new Map() });
    if (inactive.ok) {
      if (inactive.requests.length !== 0) {
        throw new Error(`GPU segmented hybrid capture-plan admission unexpectedly resolved a texture without its frozen snapshot at canonical frame ${index}.`);
      }
      continue;
    }
    const compiled = compileGpuHybridTextureRequests({ motion: pkg.motion, atUs: Math.round(atMs * 1_000), snapshots });
    if (!compiled.ok || compiled.requests.length > 1) {
      throw new Error(`GPU segmented hybrid capture-plan admission failed at canonical frame ${index}${compiled.ok ? "." : `: ${compiled.failure.message}`}`);
    }
    const request = compiled.requests[0];
    if (request) entries.push(Object.freeze({ index, atMs, atUs: request.atUs, requestFingerprint: request.requestFingerprint }));
  }
  if (entries.length === 0) throw new Error("GPU segmented hybrid admission found no active exact Core texture request.");
  const plan: RenderSegmentGpuHybridCapturePlan = Object.freeze({
    schema: "shellx-motion/gpu-hybrid-capture-plan@1",
    entries: Object.freeze(entries),
    sha256: gpuHybridCapturePlanSha256(entries)
  });
  const bootstrap = admission.identity.bootstrap;
  const first = entries[0];
  if (!first || bootstrap.index !== first.index || bootstrap.atMs !== first.atMs || bootstrap.atUs !== first.atUs
    || bootstrap.requestFingerprint !== first.requestFingerprint) {
    throw new Error("GPU segmented hybrid bootstrap does not match the first frozen Core capture-plan request.");
  }
  return plan;
}
