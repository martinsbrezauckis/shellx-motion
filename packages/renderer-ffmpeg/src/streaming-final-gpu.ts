import { createHash, randomUUID } from "node:crypto";
import { readdir, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  canonicalJson,
  canonicalJsonSha256,
  compileGpuHybridTextureRequests,
  compileGpuSceneBehaviorStaticPlan,
  compileGpuSceneBehaviorFramePlan,
  compileGpuScene2dPlan,
  compileGpuSceneStaticPlan,
  createGpuHybridTextureResourceBinding,
  gpuVideoTimelineAtUs,
  OutputDirectoryReservation,
  type GpuHybridTextureSourceSnapshot,
  type GpuSceneBehaviorStaticPlan,
  type GpuSceneStaticPlan,
  type RetainedDirectoryAuthority
} from "@shellx-motion/core";
import {
  createGpuStreamingFrameProducer,
  prepareGpuSceneResources,
  GpuSceneResourceError,
  type GpuStreamingFrameProducer,
  type GpuStreamingStaticPlan,
  type PreparedGpuSceneResources
} from "@shellx-motion/renderer-browser";
import type {
  StreamingFfmpegAdmittedPreparationContext,
  StreamingFfmpegFinalInput
} from "./streaming-foundation-types.js";
import type { RenderStreamingFinalInput } from "./streaming-final-adapter-types.js";
import type { StreamingFinalGpuVideoStagingEvidence } from "./streaming-final-adapter-types.js";
import {
  prepareGpuVideoFrameStaging,
  requestedGpuVideoAudioAssetRefs,
  type GpuVideoStagingMedia,
  type PreparedGpuVideoFrameStaging
} from "./gpu-video-frame-staging.js";

export interface GpuDeliveryFailure {
  code: string;
  message: string;
  layerId?: string;
}

export interface PreparedAdmittedGpuDelivery {
  readonly staticPlan: GpuSceneStaticPlan;
  /** Parallel Core behavior identity; base `staticPlan` remains legacy resource topology. */
  readonly behaviorStaticPlan?: GpuSceneBehaviorStaticPlan;
  readonly resources: PreparedGpuSceneResources;
  readonly video?: PreparedGpuVideoFrameStaging;
  /** Exact private child created below the encoder's admitted scratch root, if video was present. */
  readonly stagingRoot?: string;
  /** Internal retained authority used for final-audio snapshots in the same aggregate child. */
  readonly stagingAuthority?: RetainedDirectoryAuthority;
  /** Releases exact staging files, then removes only the empty child we created. */
  release(): Promise<void>;
}

/**
 * Pre-store topology-only bridge for one Browser-frozen B2 source.  Its
 * synthetic decoded hash is used solely to prove Core lowering can consume the
 * exact request; it is never a captured pixel claim, persisted evidence, or
 * a runtime upload.
 */
export interface GpuHybridTopologyPreflight {
  readonly sourceSnapshot: GpuHybridTextureSourceSnapshot;
  readonly dynamicTexture: { readonly id: string; readonly width: number; readonly height: number; readonly sourceSha256: string };
}

/**
 * Compile only data topology before an outer job exists.  This intentionally opens no assets and
 * performs no FFmpeg work: the later admitted stage owns every resource read and video child.
 */
export function preflightGpuDelivery(
  input: RenderStreamingFinalInput,
  /** A trusted host may have already completed pure effect-module resolution. */
  resolvedStaticPlan?: GpuSceneStaticPlan,
  resolvedBehaviorStaticPlan?: GpuSceneBehaviorStaticPlan
): { ok: true; staticPlan: GpuSceneStaticPlan; behaviorStaticPlan?: GpuSceneBehaviorStaticPlan } | { ok: false; failure: GpuDeliveryFailure } {
  const behavior = resolvedBehaviorStaticPlan ? compileGpuSceneBehaviorStaticPlan(input.pkg.motion) : undefined;
  if (behavior && !behavior.ok) return { ok: false, failure: behavior.failure };
  const compiled = resolvedStaticPlan
    ? { ok: true as const, plan: resolvedStaticPlan }
    : compileGpuSceneStaticPlan(input.pkg.motion);
  if (!compiled.ok) return { ok: false, failure: compiled.failure };
  if (behavior?.ok && (canonicalJson(resolvedBehaviorStaticPlan) !== canonicalJson(behavior.plan) || canonicalJson(compiled.plan) !== canonicalJson(behavior.plan.basePlan))) {
    return { ok: false, failure: { code: "gpu_static_plan_invalid", message: "GPU behavior final delivery does not bind its exact retained Core behavior/base plans." } };
  }
  for (const resource of compiled.plan.resources) {
    if (!safeManifestAsset(input.pkg.manifest.assets, resource.assetRef)) {
      return {
        ok: false,
        failure: {
          code: "gpu_static_plan_resource_refused",
          message: `GPU static scene resource ${resource.assetRef} must be a declared safe package-relative asset.`
        }
      };
    }
  }
  return { ok: true, staticPlan: compiled.plan, ...(behavior?.ok ? { behaviorStaticPlan: behavior.plan } : {}) };
}

/**
 * Prepare resources and immutable GPU-video staging after the encoder's one outer governor job is
 * admitted, but before its process factory is allowed to start.  Production always uses the
 * supplied same-job runner; `testVideoStaging` can replace it only in unit fixtures and cannot
 * choose a root or authority.
 */
export async function prepareAdmittedGpuDelivery(
  input: RenderStreamingFinalInput,
  staticPlan: GpuSceneStaticPlan,
  context: StreamingFfmpegAdmittedPreparationContext & { readonly hybridTopologyPreflight?: GpuHybridTopologyPreflight },
  behaviorStaticPlan?: GpuSceneBehaviorStaticPlan
): Promise<{ ok: true; delivery: PreparedAdmittedGpuDelivery } | { ok: false; failure: GpuDeliveryFailure }> {
  let authority: RetainedDirectoryAuthority | undefined;
  let video: PreparedGpuVideoFrameStaging | undefined;
  try {
    const resources = await prepareGpuSceneResources(input.pkg, staticPlan.resources);
    const audioSourcePaths = gpuAudioSourcePaths(input);
    // Visual-frame staging follows the static GPU plan, while audio staging follows the already
    // resolved final mix. A hidden group/video therefore has no GPU frame schedule but still gets
    // its explicitly requested includeAudio source admitted as immutable PCM.
    if (staticPlan.maxima.maxVideoCount > 0 || requestedGpuVideoAudioAssetRefs(input.pkg, audioSourcePaths).length > 0) {
      const stagingRoot = join(context.job.scratchRoot, `gpu-video-${randomUUID()}`);
      authority = await OutputDirectoryReservation.acquire(stagingRoot, { requireAbsent: true });
      const test = input.toolPolicy?.gpu?.testVideoStaging;
      video = await prepareGpuVideoFrameStaging({
        pkg: input.pkg,
        runner: test?.runner ?? context.runner,
        signal: context.job.signal,
        audioSourcePaths,
        preflight: {
          stagingRoot,
          authority,
          ...(test?.maxBytes === undefined ? {} : { maxBytes: test.maxBytes }),
          ...(test?.media === undefined ? {} : { media: test.media })
        }
      });
      if (!video) throw new Error("GPU video staging completed without a prepared video provider.");
    }
    // A governed module's frame resources live behind the opaque begin-use
    // lease. Only the Browser producer can derive those private maps and
    // validate them before it opens Chromium. Recompiling here would either
    // leak that boundary or manufacture an untrusted substitute.
    if (!staticPlan.effectModules?.length) {
      for (const atMs of staticPlanValidationTimes(input)) {
        const hybrid = hybridTopologyResources(input.pkg.motion, atMs, context.hybridTopologyPreflight);
        const atUs = behaviorStaticPlan ? gpuVideoTimelineAtUs(atMs) : null;
        if (behaviorStaticPlan && atUs === null) {
          await video?.release();
          await removeOwnedEmptyStagingChild(authority);
          return { ok: false, failure: { code: "gpu_invalid_time", message: "GPU behavior final validation time cannot be represented as canonical integer microseconds." } };
        }
        const compiled = behaviorStaticPlan
          ? compileGpuSceneBehaviorFramePlan(input.pkg.motion, atUs!, {
            images: resources.images,
            ...(video ? { videos: video.videos } : {}),
            ...(hybrid ? { hybridTextureRequests: hybrid.requests, hybridTextures: hybrid.textures } : {}),
            fonts: resources.fonts
          })
          : compileGpuScene2dPlan(input.pkg.motion, atMs, {
          images: resources.images,
          ...(video ? { videos: video.videos } : {}),
          ...(hybrid ? { hybridTextureRequests: hybrid.requests, hybridTextures: hybrid.textures } : {}),
          fonts: resources.fonts
          });
        if (!compiled.ok) {
          await video?.release();
          await removeOwnedEmptyStagingChild(authority);
          return {
            ok: false,
            failure: compiled.failure
          };
        }
      }
    }
    const retainedVideo = video;
    const retainedAuthority = authority;
    return {
      ok: true,
      delivery: {
        staticPlan,
        ...(behaviorStaticPlan ? { behaviorStaticPlan } : {}),
        resources,
        ...(retainedVideo ? { video: retainedVideo } : {}),
        ...(retainedAuthority ? { stagingRoot: retainedAuthority.path } : {}),
        ...(retainedAuthority ? { stagingAuthority: retainedAuthority } : {}),
        release: async () => {
          await retainedVideo?.release();
          await removeOwnedEmptyStagingChild(retainedAuthority);
        }
      }
    };
  } catch (error) {
    await video?.release().catch(() => undefined);
    await removeOwnedEmptyStagingChild(authority).catch(() => undefined);
    return { ok: false, failure: gpuDeliveryFailure(error) };
  }
}

function hybridTopologyResources(
  motion: import("@shellx-motion/core").MotionDocument,
  atMs: number,
  preflight: GpuHybridTopologyPreflight | undefined
): { requests: ReadonlyMap<string, import("@shellx-motion/core").GpuHybridTextureRequest>; textures: ReadonlyMap<string, import("@shellx-motion/core").GpuHybridTextureResourceBinding> } | undefined {
  if (!preflight) return undefined;
  const atUs = Math.round(atMs * 1_000);
  const inactive = compileGpuHybridTextureRequests({ motion, atUs, snapshots: new Map() });
  if (inactive.ok) {
    if (inactive.requests.length !== 0) throw new Error("GPU hybrid topology preflight accepted an active source without its frozen snapshot.");
    return { requests: new Map(), textures: new Map() };
  }
  const planned = compileGpuHybridTextureRequests({
    motion,
    atUs,
    snapshots: new Map([[preflight.sourceSnapshot.layerId, preflight.sourceSnapshot]])
  });
  if (!planned.ok || planned.requests.length !== 1) {
    throw new Error(`GPU hybrid topology preflight could not mint its one exact Core request${planned.ok ? "." : `: ${planned.failure.message}`}`);
  }
  const request = planned.requests[0]!;
  if (request.width !== preflight.dynamicTexture.width || request.height !== preflight.dynamicTexture.height) {
    throw new Error("GPU hybrid topology preflight dynamic texture dimensions conflict with its frozen Core request.");
  }
  const topologyOnlyHash = canonicalJsonSha256({
    schema: "shellx-motion/gpu-hybrid-topology-preflight@1",
    requestFingerprint: request.requestFingerprint,
    dynamicTexture: preflight.dynamicTexture,
    disposition: "no-pixels-captured-or-claimed"
  });
  const resource = createGpuHybridTextureResourceBinding({
    request,
    resourceId: preflight.dynamicTexture.id,
    decodedRgbaSha256: topologyOnlyHash
  });
  return {
    requests: new Map([[request.layerId, request]]),
    textures: new Map([[request.layerId, resource]])
  };
}

export function gpuStreamingProducer(
  input: RenderStreamingFinalInput,
  observe: (evidence: GpuStreamingFrameProducer["evidence"]) => void,
  failed: (error: unknown) => void,
  staticPlan: GpuStreamingStaticPlan,
  resources: PreparedGpuSceneResources,
  video?: PreparedGpuVideoFrameStaging,
  effectModuleLease?: import("@shellx-motion/renderer-browser").GpuEffectModuleBeginUseLease,
  behaviorStaticPlan?: GpuSceneBehaviorStaticPlan
): NonNullable<StreamingFfmpegFinalInput["produce"]> {
  const producer = createGpuStreamingFrameProducer({
    pkg: input.pkg,
    staticPlan,
    ...(behaviorStaticPlan ? { behaviorStaticPlan } : {}),
    resources,
    ...(effectModuleLease ? { effectModuleLease } : {}),
    ...(video ? { openVideoProvider: video.openProvider } : {}),
    ...(input.toolPolicy?.gpu?.openRuntime ? { openRuntime: input.toolPolicy.gpu.openRuntime } : {}),
    ...(input.toolPolicy?.gpu?.frameTimeoutMs !== undefined ? { frameTimeoutMs: input.toolPolicy.gpu.frameTimeoutMs } : {})
  });
  return async (sink, context) => await context.runAdmitted(async (job) => {
    job.reportSandbox({
      schema: "shellx-motion/runtime-sandbox@1",
      provider: "chromium",
      status: "requested",
      scope: "browser-process"
    });
    try {
      const maxProcessTreeRssBytes = job.maxProcessTreeRssBytes;
      if (typeof maxProcessTreeRssBytes !== "number" || !Number.isSafeInteger(maxProcessTreeRssBytes)) {
        throw new Error("GPU final rendering requires an admitted outer process-tree memory limit.");
      }
      await producer.produce(sink, {
        admission: "pre-acquired",
        signal: job.signal,
        scratchRoot: job.scratchRoot,
        maxProcessTreeRssBytes,
        watchProcess: job.watchProcess
      });
    } catch (error) {
      failed(error);
      throw error;
    } finally {
      observe(producer.evidence);
    }
  });
}

/** Publish only bounded hashes and the checked aggregate ledger; private paths stay in staging. */
export function gpuVideoStagingEvidence(video: PreparedGpuVideoFrameStaging): StreamingFinalGpuVideoStagingEvidence {
  const pcmHashes = [...video.audioSnapshots.values()].map((snapshot) => snapshot.sha256).sort();
  return {
    ledger: { ...video.ledger },
    pcmSha256: createHash("sha256").update(canonicalJson(pcmHashes)).digest("hex")
  };
}

function staticPlanValidationTimes(input: RenderStreamingFinalInput): readonly number[] {
  const times = new Set([0]);
  for (const layer of input.pkg.motion.layers) {
    if (layer.visible !== false && layer.startMs < input.pkg.motion.durationMs) times.add(Math.max(0, layer.startMs));
  }
  return [...times].sort((left, right) => left - right);
}

function gpuAudioSourcePaths(input: RenderStreamingFinalInput): string[] {
  return [...new Set([
    input.audioPath,
    input.audio?.path,
    ...(input.audioTracks?.map((audio) => audio.path) ?? [])
  ].filter((path): path is string => typeof path === "string" && path.length > 0).map((path) => resolve(path)))];
}

function gpuDeliveryFailure(error: unknown): GpuDeliveryFailure {
  if (error instanceof GpuSceneResourceError) {
    return { code: error.code, message: error.message, ...(error.layerId ? { layerId: error.layerId } : {}) };
  }
  return {
    code: "gpu_video_resource_refused",
    message: error instanceof Error ? error.message : "GPU video frames could not be staged."
  };
}

/** The reservation is caller-owned, so success must leave it empty before removing exactly it. */
async function removeOwnedEmptyStagingChild(authority: RetainedDirectoryAuthority | undefined): Promise<void> {
  if (!authority) return;
  await authority.assertCurrent();
  if ((await readdir(authority.path)).length !== 0) {
    throw new Error("GPU video staging child still contains unreleased files; Motion will not remove it recursively.");
  }
  await rmdir(authority.path);
}

function safeManifestAsset(assets: readonly string[], assetRef: string): boolean {
  return assets.includes(assetRef) && assetRef.length > 0 && assetRef.length <= 512 && !assetRef.startsWith("/") && !assetRef.includes("\\") && !assetRef.includes("\0") && assetRef.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

/** Kept exported so adapter test policy can describe only facts, never authority. */
export type GpuVideoStagingTestFacts = {
  maxBytes?: number;
  media?: readonly GpuVideoStagingMedia[];
  runner?: import("./index.js").FfmpegRunner;
};
