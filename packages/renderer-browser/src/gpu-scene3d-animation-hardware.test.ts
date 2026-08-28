import { inspectPngFile, loadMotionPackage } from "@shellx-motion/core";
import { createHash } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderMotionGpuPreview } from "./gpu-points-preview";

const fixtureRoot = process.env.MOTION_GPU_O6_HARDWARE_PACKAGE_ROOT?.trim()
  || fileURLToPath(new URL("../../../fixtures/packages/gpu-scene3d-animation-preview", import.meta.url));
const outputRoot = process.env.MOTION_GPU_O6_HARDWARE_OUTPUT_ROOT?.trim()
  || fileURLToPath(new URL("../../../.scratch/gpu-scene3d-animation-hardware", import.meta.url));
const O6_OPERATION_TIMEOUT_MS = 30_000;
const O6_FIXTURE_TIMEOUT_MS = 240_000;

describe("O6 GPU scene3d animation hardware fixture", () => {
  it("keeps its Node 24 qualified Linux GPU-host runner budget above the bounded GPU operation", () => {
    expect(Number(process.versions.node.split(".")[0])).toBeGreaterThanOrEqual(24);
    expect(O6_FIXTURE_TIMEOUT_MS).toBeGreaterThan(O6_OPERATION_TIMEOUT_MS);
  });

  it.skipIf(process.env.MOTION_GPU_HARDWARE_FIXTURE !== "1")(
    "publishes two distinct persisted-animation samples and one-shot cleanup evidence on the admitted WebGPU host",
    async () => {
      const pkg = await loadMotionPackage(fixtureRoot);
      await mkdir(outputRoot, { recursive: true, mode: 0o700 });
      const samples = [] as { atMs: number; frameHash: string; fileHash: string }[];
      for (const atMs of [0, 500] as const) {
        const outputPath = join(outputRoot, `gpu-scene3d-animation-${atMs}.png`);
        await expect(access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
        const result = await renderMotionGpuPreview(pkg, { atMs, outDir: outputRoot, outputPath, timeoutMs: O6_OPERATION_TIMEOUT_MS });
        expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
        if (!result.ok) return;
        expect(result.frame).toMatchObject({
          width: 96, height: 64, atMs,
          gpu: { backend: "webgpu-browser", adapterFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) },
          resources: { lane: "gpu", operation: "gpu.preview", state: "passed" },
        });
        expect(result.receipt).toMatchObject({
          operation: "preview.gpu.frame", lane: "gpu", status: "passed",
          inputHashes: {
            "gpu-scene3d-animation-static-plan": expect.stringMatching(/^[a-f0-9]{64}$/),
            "gpu-scene3d-animation-frame-plan": expect.stringMatching(/^[a-f0-9]{64}$/),
          },
          output: { gpuScene3dAnimation: { atUs: atMs * 1_000, targetLayerIds: ["world"] }, sessionCleanup: { closed: true, runtimeResources: expect.anything() } },
        });
        const pixels = await inspectPngFile(result.frame.path);
        expect(pixels).toMatchObject({ ok: true, width: 96, height: 64, blank: false });
        if (!pixels.ok) return;
        expect(pixels.luma.range).toBeGreaterThan(2);
        expect(pixels.chroma.pixels).toBeGreaterThan(0);
        samples.push({ atMs, frameHash: result.frame.sha256, fileHash: createHash("sha256").update(await readFile(result.frame.path)).digest("hex") });
      }
      expect(samples).toHaveLength(2);
      expect(samples[0]?.frameHash).not.toBe(samples[1]?.frameHash);
      expect(samples[0]?.fileHash).not.toBe(samples[1]?.fileHash);
    },
    O6_FIXTURE_TIMEOUT_MS,
  );
});
