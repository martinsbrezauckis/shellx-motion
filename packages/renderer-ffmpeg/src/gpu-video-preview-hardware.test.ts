import { inspectPngFile, loadMotionPackage, type OperationReceipt } from "@shellx-motion/core";
import { createGpuPreviewSession, type GpuPreviewResult, type GpuPreviewSessionCleanupEvidence } from "@shellx-motion/renderer-browser";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createGovernedFfmpegRunner } from "./index";
import { createGpuPreviewVideoFrameProvider } from "./gpu-video-preview-provider";

const fixtureRoot = process.env.MOTION_GPU_VIDEO_PREVIEW_PACKAGE_ROOT?.trim()
  || fileURLToPath(new URL("../../../fixtures/packages/gpu-v25b1-scrub-signal", import.meta.url));
const outputRoot = process.env.MOTION_GPU_VIDEO_PREVIEW_OUTPUT_ROOT?.trim()
  || fileURLToPath(new URL("../../../.scratch/gpu-v25b1-video-preview-hardware", import.meta.url));
const playheads = [480, 960, 1_560, 2_040, 2_373, 2_891, 1_560] as const;
const sourceTimesUs = [720_000, 1_320_000, 1_170_000, 870_000, 1_286_250, 1_033_750, 1_170_000] as const;

describe("GPU exact-time active-video preview hardware fixture", () => {
  it.skipIf(process.env.MOTION_GPU_HARDWARE_FIXTURE !== "1")("scrubs one retained provider and texture forward, backward, randomly, and repeatably", async () => {
    const pkg = await loadMotionPackage(fixtureRoot);
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    const session = createGpuPreviewSession(pkg, {
      openVideoProvider: async ({ pkg: providerPackage }) => createGpuPreviewVideoFrameProvider({
        pkg: providerPackage,
        scratchRoot: outputRoot,
        runner: async (command, signal) => await createGovernedFfmpegRunner({
          scratchRoot: outputRoot,
          operation: "test.gpu-preview-video-hardware",
          callerId: "shellx-motion:v25b1-native-qualification",
          signal
        })(command)
      })
    });
    const results: Array<Extract<GpuPreviewResult, { ok: true }>> = [];
    let cleanup: GpuPreviewSessionCleanupEvidence | undefined;
    try {
      for (const [index, atMs] of playheads.entries()) {
        const result = await session.renderFrame({
          atMs,
          outDir: outputRoot,
          outputPath: join(outputRoot, `scrub-${index}-${atMs}.png`),
          timeoutMs: 60_000,
          callerId: "shellx-motion:v25b1-native-qualification"
        });
        expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
        if (!result.ok) continue;
        results.push(result);
        const quality = await inspectPngFile(result.frame.path);
        expect(quality).toMatchObject({ ok: true, width: 1_920, height: 1_080, blank: false });
        if (quality.ok) {
          expect(quality.luma.range).toBeGreaterThan(5);
          expect(quality.chroma.pixels).toBeGreaterThan(0);
        }
      }
    } finally {
      cleanup = await session.close();
    }

    expect(results).toHaveLength(playheads.length);
    expect(new Set(results.slice(0, -1).map((result) => result.frame.sha256)).size).toBe(playheads.length - 1);
    expect(results.at(-1)?.frame.sha256).toBe(results[2]?.frame.sha256);
    const evidence = results.map((result) => videoEvidence(result.receipt));
    expect(evidence.map((entry) => entry.frames[0]?.sourceAtUs)).toEqual(sourceTimesUs);
    expect(evidence.map((entry) => entry.texture.dynamicImageTextureWrites)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(evidence.every((entry) => entry.texture.dynamicImageTextureSlots === 1
      && entry.texture.dynamicImageTextureHighWaterSlots === 1
      && entry.texture.dynamicImageTextureBytes === 1_177_600
      && entry.texture.dynamicImageTextureHighWaterBytes === 1_177_600
      && entry.texture.dynamicImageTextureLateRefusals === 0)).toBe(true);
    expect(evidence.at(-1)?.provider).toMatchObject({
      sourceCount: 1,
      decodedFrameCount: 7,
      cache: { hits: 1, misses: 6, entries: 6, highWaterEntries: 6, inFlightBytes: 0 }
    });
    expect(cleanup).toMatchObject({
      closed: true,
      runtimeResources: {
        framesRendered: 7,
        frameArenaReconfigurations: 1,
        dynamicImageTextureSlots: 1,
        dynamicImageTextureWrites: 7,
        dynamicImageTextureLateRefusals: 0,
        dynamicImageTextureDestructions: 1
      },
      provider: { closed: true, releasedFrames: 6, releasedSources: 1, privateScratchReleased: true }
    });
    await writeFile(join(outputRoot, "qualification.json"), `${JSON.stringify({
      schema: "shellx-motion/gpu-video-preview-native-qualification@1",
      sourceCommit: process.env.MOTION_GPU_VIDEO_PREVIEW_SOURCE_COMMIT ?? null,
      playheads,
      sourceTimesUs,
      frameSha256: results.map((result) => result.frame.sha256),
      receipts: results.map((result) => result.receipt),
      cleanup
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }, 300_000);
});

function videoEvidence(receipt: OperationReceipt): {
  frames: Array<{ sourceAtUs: number }>;
  provider: { sourceCount: number; decodedFrameCount: number; cache: Record<string, number> };
  texture: { dynamicImageTextureWrites: number; dynamicImageTextureSlots: number; dynamicImageTextureHighWaterSlots: number; dynamicImageTextureBytes: number; dynamicImageTextureHighWaterBytes: number; dynamicImageTextureLateRefusals: number };
} {
  const output = receipt.output as Record<string, unknown>;
  return output.gpuVideoPreview as ReturnType<typeof videoEvidence>;
}
