import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { hashBuffer, type OperationReceipt } from "@shellx-motion/core";
import type {
  RenderStreamingFinalInput,
  StreamingFinalFrameTransportEvidence
} from "@shellx-motion/renderer-ffmpeg";

export function fakeMp4Bytes(label: string): Buffer {
  return Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from("ftypisom", "ascii"),
    Buffer.from(label)
  ]);
}

export function createDebugConnectorStreamedReceipt(
  input: RenderStreamingFinalInput,
  bytes: Buffer,
  frameTransport: StreamingFinalFrameTransportEvidence
): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: `debug-connector-streamed-${hashBuffer(bytes).slice(0, 16)}`,
    operation: "render.final",
    status: "passed",
    packageId: input.pkg.manifest.id,
    inputHashes: { motion: hashBuffer(Buffer.from(JSON.stringify(input.pkg.motion), "utf8")) },
    createdAt: input.now?.() ?? "2026-08-08T00:00:00.000Z",
    lane: "ffmpeg",
    output: {
      path: input.outputPath,
      sha256: hashBuffer(bytes),
      frameTransport
    },
    artifacts: [{ role: "rendered_media", path: input.outputPath, status: "available" }],
    warnings: []
  };
}

export function createDebugConnectorStreamedTransport(
  frameLane: "browser" | "native",
  durationMs: number,
  fps: number
): StreamingFinalFrameTransportEvidence {
  const frameCount = Math.ceil((durationMs / 1_000) * fps);
  return {
    delivery: "streamed",
    frameLane,
    frameCount,
    retainedFrameCount: 0,
    producer: frameLane === "browser"
      ? browserProducerEvidence()
      : nativeProducerEvidence(frameCount),
    encoderHandoff: {
      delivery: "streamed",
      maxConcurrentProducerWrites: 1,
      observedMaxConcurrentProducerWrites: 1,
      maxBufferedInputBytes: 16_384,
      inputHighWaterMarkBytes: 16_384,
      maxPngBytesPerFrame: 16_384,
      backpressure: { writes: frameCount, drainWaits: 0 },
      encoderHandoffSourceFramesRetained: 0,
      qualityPlaneSetCapacity: 2,
      uniqueHashCapacity: 2,
      attempts: [{ source: "software", encoder: "libx264", outcome: "succeeded" }],
      quality: {
        warnings: [],
        frameCount,
        blankFrames: 0,
        uniqueFrameHashes: Math.min(frameCount, 2),
        uniqueFrameHashesExact: true
      }
    }
  };
}

export async function expectDebugConnectorStreamedReceipt(
  receiptPath: string,
  outDir: string,
  quality?: { minUniqueFrameHashes: number }
): Promise<void> {
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, any>;
  expect(receipt).toMatchObject({
    operation: "render.final",
    status: "passed",
    lane: "ffmpeg",
    output: {
      frameTransport: {
        delivery: "streamed",
        frameLane: "browser",
        retainedFrameCount: 0,
        encoderHandoff: {
          delivery: "streamed",
          encoderHandoffSourceFramesRetained: 0,
          quality: quality
            ? expect.objectContaining({
                uniqueFrameHashes: quality.minUniqueFrameHashes,
                uniqueFrameHashesExact: true
              })
            : expect.any(Object)
        }
      }
    }
  });
  expect(receipt.output.frameTransportPlan).toBeUndefined();
  expect(receipt.output.frameReceipt).toBeUndefined();
  expect(receipt.output.frames).toBeUndefined();
  await expect(readdir(join(outDir, "frames"))).rejects.toMatchObject({ code: "ENOENT" });
}

function browserProducerEvidence(): StreamingFinalFrameTransportEvidence["producer"] {
  return {
    frameLane: "browser",
    evidence: {
      schema: "shellx-motion/browser-streaming-producer@1",
      warningUnion: [],
      warningsOmitted: 0,
      stableInputHashUnion: {},
      stableInputHashKeysOmitted: 0,
      stableInputHashConflictKeys: [],
      stableInputHashConflictKeysOmitted: 0,
      processMonitoring: {
        mode: "cooperative-browser-session",
        chromiumPid: "unavailable",
        watchedRoot: "host-node-process",
        rssScope: "host-node-process-tree",
        measurement: "conservative-fallback-not-exact-per-job",
        encoderRssOverlap: "possible",
        encoderContainmentCoversChromium: false,
        reasonCode: "worker_process_unavailable"
      },
      session: { state: "closed", cleanup: "complete" }
    }
  };
}

function nativeProducerEvidence(frameCount: number): StreamingFinalFrameTransportEvidence["producer"] {
  return {
    frameLane: "native",
    evidence: {
      schema: "shellx-motion/native-frame-producer-evidence@1",
      producer: {
        frameCacheEntries: 0,
        emittedFrameCount: frameCount,
        inFlightPngHandoffs: 0,
        peakInFlightPngHandoffs: 1
      },
      session: {
        cleanupState: "closed",
        frameCacheEntries: 0,
        assetCache: {
          scope: "native-render-session-decoded-assets",
          includedInFrameRetention: false
        }
      },
      terminal: {
        lastFrameReceipt: null,
        laneWarnings: [],
        warningsOmitted: 0,
        downstreamAudioHandoffLayers: [],
        audioHandoffLayersOmitted: 0
      }
    }
  };
}
