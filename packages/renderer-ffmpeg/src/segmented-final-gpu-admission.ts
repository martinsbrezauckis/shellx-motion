/** GPU-only post-governor admission, including the disposable fresh module lease. */
import type { LocalMotionJobContext } from "@shellx-motion/core";
import { fingerprintResolvedMotionPackageContent } from "./segmented-final-internal/package-content-fingerprint.js";
import { SegmentedFinalStoreAuthority } from "./segmented-final-internal/segmented-final-store-authority.js";
import type { RenderSegmentedFinalInput } from "./segmented-final-internal/segmented-final-adapter-types.js";
import type { SegmentedFinalPaths } from "./segmented-final-internal/segmented-final-adapter-store.js";
import type { PreparedSegmentedGpuHost } from "./segmented-final-gpu-host.js";
import { prepareAdmittedSegmentedGpuHost } from "./segmented-final-gpu-host.js";
import { beginSegmentedGpuBootstrapLease, releaseSegmentedGpuBootstrapLease, segmentedGpuBootstrapCleanup } from "./segmented-final-gpu-effect-module-bootstrap.js";
import type { FfmpegRunner } from "./index.js";

export async function prepareAdmittedSegmentedGpuInput(input: {
  request: RenderSegmentedFinalInput;
  paths: SegmentedFinalPaths;
  authority: SegmentedFinalStoreAuthority | undefined;
  setAuthority: (authority: SegmentedFinalStoreAuthority) => void;
  job: LocalMotionJobContext;
  maxProcessTreeRssBytes: number;
  runner: FfmpegRunner;
}): Promise<{
  authority: SegmentedFinalStoreAuthority;
  gpuHost: PreparedSegmentedGpuHost;
  maxProcessTreeRssBytes: number;
  admittedInput: RenderSegmentedFinalInput;
}> {
  if (!input.request.gpuHost) throw new Error("GPU segmented delivery requires an internal admitted host request.");
  let authority = input.authority;
  let bootstrapLease = await beginSegmentedGpuBootstrapLease(input.request.gpuHost.preflight);
  let gpuHost: PreparedSegmentedGpuHost | undefined;
  try {
    const source = await fingerprintResolvedMotionPackageContent(input.request.package.rootPath, {
      ...(input.request.package.inputHashes ? { expectedFileHashes: input.request.package.inputHashes } : {})
    });
    let maxProcessTreeRssBytes = input.maxProcessTreeRssBytes;
    if (input.request.store.intent === "resume") {
      authority = await SegmentedFinalStoreAuthority.acquire(input.paths, "resume");
      input.setAuthority(authority);
      maxProcessTreeRssBytes = await authority.resumeGpuMaxProcessTreeRssBytes(maxProcessTreeRssBytes);
    }
    gpuHost = await prepareAdmittedSegmentedGpuHost({
      pkg: input.request.gpuHost.pkg,
      packageContentSha256: source.sha256,
      ...(input.request.package.inputHashes ? { packageContentExpectedFileHashes: input.request.package.inputHashes } : {}),
      timeline: input.request.timeline,
      job: input.job,
      maxProcessTreeRssBytes,
      runner: input.runner,
      policy: input.request.gpuHost.policy,
      ...(input.request.gpuHost.preflight ? { preflight: input.request.gpuHost.preflight } : {}),
      media: {
        ...(input.request.audioPath ? { audioPath: input.request.audioPath } : {}),
        ...(input.request.audio ? { audio: input.request.audio } : {}),
        ...(input.request.audioTracks ? { audioTracks: input.request.audioTracks } : {}),
        ...(input.request.inputRoots ? { inputRoots: input.request.inputRoots } : {})
      }
    });
    if (bootstrapLease) await releaseSegmentedGpuBootstrapLease(bootstrapLease);
    bootstrapLease = undefined;
    if (!authority) {
      authority = await SegmentedFinalStoreAuthority.acquire(input.paths, input.request.store.intent);
      input.setAuthority(authority);
    }
    return {
      authority,
      gpuHost,
      maxProcessTreeRssBytes,
      admittedInput: {
        ...input.request,
        package: { ...input.request.package, ...(gpuHost.packageContentExpectedFileHashes ? { inputHashes: gpuHost.packageContentExpectedFileHashes } : {}) },
        ...gpuHost.audio,
        producer: gpuHost.producer,
        createRangeProducer: gpuHost.createRangeProducer
      }
    };
  } catch (error) {
    const releases = segmentedGpuBootstrapCleanup({
      lease: bootstrapLease,
      releases: gpuHost ? [async () => await gpuHost!.release()] : []
    });
    const cleanup = await Promise.allSettled(releases);
    const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
    if (failures.length) throw new AggregateError([error, ...failures], "GPU segmented admission and ordered module lease cleanup both failed.");
    throw error;
  }
}
