import { createGpuScene3dGltfPbrStreamingProducer, type GpuScene3dGltfPbrFinalRouteResolution } from "@shellx-motion/renderer-browser/internal/scene3d-gltf-pbr-final";
import { normalizeMotionAudioMaster } from "@shellx-motion/core";
import type { StreamingFfmpegAdmittedPreparationContext, StreamingFrameSink, StreamingProducerJobContext } from "./streaming-foundation-types.js";
import type { RenderStreamingFinalInput, StreamingFinalProducerEvidence } from "./streaming-final-adapter-types.js";

/** PBR has no generic static plan or resource bridge: it owns its isolated page/session end-to-end. */
export function admittedScene3dGltfPbrPreflight(
  input: RenderStreamingFinalInput,
  resolved: Extract<GpuScene3dGltfPbrFinalRouteResolution, { kind: "present" }>,
  observe: (evidence: StreamingFinalProducerEvidence) => void,
  failed: (error: unknown) => void,
) {
  return async (context: StreamingFfmpegAdmittedPreparationContext) => {
    const route = resolved.route;
    const producer = createGpuScene3dGltfPbrStreamingProducer(route, input.pkg.motion);
    return {
      input: {
        fps: input.pkg.motion.fps,
        width: 1280,
        height: 720,
        durationMs: input.pkg.motion.durationMs,
        frameFormat: "rgba" as const,
        outputPath: input.outputPath,
        ...(input.preset ? { preset: input.preset } : {}),
        ...(input.audioPath ? { audioPath: input.audioPath } : {}),
        ...(input.audio ? { audio: input.audio } : {}),
        ...(input.audioTracks ? { audioTracks: input.audioTracks } : {}),
        ...(normalizeMotionAudioMaster(input.audioMaster) ? { audioMaster: normalizeMotionAudioMaster(input.audioMaster)! } : {}),
        ...(input.inputRoots ? { inputRoots: input.inputRoots } : {}),
        ...(input.outputRoots ? { outputRoots: input.outputRoots } : {}),
        ...(input.quality ? { quality: input.quality } : {}),
        ...(input.qualityManifest ? { qualityManifest: input.qualityManifest } : {}),
        ...(input.toolPolicy?.cache ? { cache: input.toolPolicy.cache } : {}),
        ...(input.toolPolicy?.ffmpegVersion !== undefined ? { ffmpegVersion: input.toolPolicy.ffmpegVersion } : {}),
        ...(input.toolPolicy?.ffprobeVersion !== undefined ? { ffprobeVersion: input.toolPolicy.ffprobeVersion } : {}),
        ...(input.toolPolicy?.forceSoftwareEncode !== undefined ? { forceSoftwareEncode: input.toolPolicy.forceSoftwareEncode } : {}),
        ...(input.toolPolicy?.verifyDeliveredColor !== undefined ? { verifyDeliveredColor: input.toolPolicy.verifyDeliveredColor } : {}),
      },
      produce: async (sink: StreamingFrameSink, producerContext: { runAdmitted<T>(operation: (job: StreamingProducerJobContext) => Promise<T>): Promise<T> }) => await producerContext.runAdmitted(async (job: StreamingProducerJobContext) => {
        job.reportSandbox({ schema: "shellx-motion/runtime-sandbox@1", provider: "chromium", status: "requested", scope: "browser-process" });
        try {
          const maxProcessTreeRssBytes = job.maxProcessTreeRssBytes;
          if (typeof maxProcessTreeRssBytes !== "number" || !Number.isSafeInteger(maxProcessTreeRssBytes) || maxProcessTreeRssBytes < 64 * 1024 * 1024) {
            throw new Error("The fixed glTF PBR final route requires an admitted process-tree memory limit before Browser launch.");
          }
          await producer.produce(sink, {
            admission: "pre-acquired",
            signal: job.signal,
            scratchRoot: job.scratchRoot,
            maxProcessTreeRssBytes,
            watchProcess: job.watchProcess,
          });
        } catch (error) { failed(error); throw error; }
        finally { observe({ frameLane: "gpu-pbr", evidence: producer.evidence }); }
      }),
      release: async () => undefined,
    };
  };
}
