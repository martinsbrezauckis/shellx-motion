import { inspectPngFile, loadMotionPackage } from "@shellx-motion/core";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderMotionGpuPreview } from "./gpu-points-preview";

const fixtureRoot = process.env.MOTION_GPU_HARDWARE_PACKAGE_ROOT?.trim()
  || fileURLToPath(new URL("../../../fixtures/packages/gpu-g9-particle-cathedral", import.meta.url));
const outputRoot = process.env.MOTION_GPU_HARDWARE_OUTPUT_ROOT?.trim()
  || fileURLToPath(new URL("../../../.scratch/gpu-particle-cathedral-hardware", import.meta.url));
const GPU_PARTICLE_CATHEDRAL_OPERATION_TIMEOUT_MS = 60_000;
const GPU_PARTICLE_CATHEDRAL_FIXTURE_TIMEOUT_MS = 300_000;

describe("GPU Particle Cathedral hardware fixture", () => {
  it("keeps its runner budget above the bounded full-HD render operation", () => {
    expect(GPU_PARTICLE_CATHEDRAL_FIXTURE_TIMEOUT_MS).toBeGreaterThan(GPU_PARTICLE_CATHEDRAL_OPERATION_TIMEOUT_MS);
  });

  it.skipIf(process.env.MOTION_GPU_HARDWARE_FIXTURE !== "1")("renders the fixed 100,000-particle product film as a nonblank full-HD PNG", async () => {
    const pkg = await loadMotionPackage(fixtureRoot);
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    const result = await renderMotionGpuPreview(pkg, {
      atMs: 2_400,
      outDir: outputRoot,
      outputPath: join(outputRoot, "gpu-particle-cathedral-hardware.png"),
      timeoutMs: GPU_PARTICLE_CATHEDRAL_OPERATION_TIMEOUT_MS
    });
    expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
    if (!result.ok) return;
    expect(result.frame).toMatchObject({
      width: 1_920,
      height: 1_080,
      atMs: 2_400,
      gpu: { backend: "webgpu-browser", adapterFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) },
      resources: { lane: "gpu", operation: "gpu.preview", state: "passed" }
    });
    expect(result.receipt).toMatchObject({
      operation: "preview.gpu.frame",
      lane: "gpu",
      status: "passed",
      inputHashes: { "gpu-frame-plan": expect.stringMatching(/^[a-f0-9]{64}$/) },
      output: { framePlanFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) }
    });
    const quality = await inspectPngFile(result.frame.path);
    expect(quality).toMatchObject({ ok: true, width: 1_920, height: 1_080, blank: false });
    if (!quality.ok) return;
    expect(quality.luma.range).toBeGreaterThan(2);
    expect(quality.chroma.pixels).toBeGreaterThan(0);
  }, GPU_PARTICLE_CATHEDRAL_FIXTURE_TIMEOUT_MS);
});
