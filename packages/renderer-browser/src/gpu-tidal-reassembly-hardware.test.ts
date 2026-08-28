import { comparePngFiles, inspectPngFile, loadMotionPackage, type MotionPackage } from "@shellx-motion/core";
import { mkdir, mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGpuPreviewSession } from "./gpu-points-preview";

const fixtureRoot = process.env.MOTION_GPU_TIDAL_PACKAGE_ROOT?.trim()
  || fileURLToPath(new URL("../../../fixtures/packages/gpu-v020-tidal-reassembly", import.meta.url));
const outputRoot = process.env.MOTION_GPU_TIDAL_OUTPUT_ROOT?.trim()
  || fileURLToPath(new URL("../../../.scratch/gpu-tidal-reassembly-hardware", import.meta.url));
const FRAME_TIMEOUT_MS = 60_000;
const FIXTURE_TIMEOUT_MS = 300_000;

describe("GPU Tidal Reassembly hardware fixture", () => {
  it("keeps its runner budget above three bounded full-HD render operations", () => {
    expect(FIXTURE_TIMEOUT_MS).toBeGreaterThan(FRAME_TIMEOUT_MS * 3);
  });

  it.skipIf(process.env.MOTION_GPU_TIDAL_HARDWARE_FIXTURE !== "1")(
    "replays the v2 100,000-particle hero frame deterministically in one retained session",
    async () => {
      const pkg = await loadMotionPackage(fixtureRoot);
      await mkdir(outputRoot, { recursive: true, mode: 0o700 });
      const runRoot = await mkdtemp(join(outputRoot, "run-"));
      const session = createGpuPreviewSession(pkg);
      try {
        const first = await session.renderFrame({
          atMs: 4_200,
          outDir: runRoot,
          outputPath: join(runRoot, "tidal-reassembly-4200-a.png"),
          timeoutMs: FRAME_TIMEOUT_MS
        });
        expect(first.ok, first.ok ? undefined : first.error.message).toBe(true);
        if (!first.ok) return;
        const replay = await session.renderFrame({
          atMs: 4_200,
          outDir: runRoot,
          outputPath: join(runRoot, "tidal-reassembly-4200-b.png"),
          timeoutMs: FRAME_TIMEOUT_MS
        });
        expect(replay.ok, replay.ok ? undefined : replay.error.message).toBe(true);
        if (!replay.ok) return;

        expect(first.frame).toMatchObject({
          width: 1_920,
          height: 1_080,
          atMs: 4_200,
          gpu: { backend: "webgpu-browser", adapterFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) },
          resources: { lane: "gpu", operation: "gpu.preview", state: "passed" }
        });
        expect(replay.frame.sha256).toBe(first.frame.sha256);
        expect(replay.receipt.inputHashes["gpu-frame-plan"]).toBe(first.receipt.inputHashes["gpu-frame-plan"]);
        expect(first.receipt.inputHashes["gpu-frame-plan"]).toMatch(/^[a-f0-9]{64}$/);

        const quality = await inspectPngFile(first.frame.path);
        expect(quality).toMatchObject({ ok: true, width: 1_920, height: 1_080, blank: false });
        if (!quality.ok) return;
        expect(quality.luma.range).toBeGreaterThanOrEqual(40);
        expect(quality.chroma.pixels).toBeGreaterThanOrEqual(20_736);

        const baselineSession = createGpuPreviewSession(featureOffBaseline(pkg));
        try {
          const baseline = await baselineSession.renderFrame({
            atMs: 4_200,
            outDir: runRoot,
            outputPath: join(runRoot, "tidal-reassembly-4200-feature-off-baseline.png"),
            timeoutMs: FRAME_TIMEOUT_MS
          });
          expect(baseline.ok, baseline.ok ? undefined : baseline.error.message).toBe(true);
          if (!baseline.ok) return;
          const difference = await comparePngFiles(first.frame.path, baseline.frame.path);
          expect(difference).toMatchObject({ ok: true, width: 1_920, height: 1_080 });
          if (difference.ok) expect(difference.changedRatio).toBeGreaterThanOrEqual(0.06);
        } finally {
          await baselineSession.close();
        }
      } finally {
        await session.close();
      }
    },
    FIXTURE_TIMEOUT_MS
  );
});

/** Same motion/field/palette with the v2 visual-quality controls disabled for native review. */
function featureOffBaseline(pkg: MotionPackage): MotionPackage {
  const baseline = structuredClone(pkg);
  baseline.motion.id = `${pkg.motion.id}_feature_off_baseline`;
  baseline.motion.name = `${pkg.motion.name} — feature-off baseline`;
  for (const layer of baseline.motion.layers) {
    if (layer.id === "reassembly-window") delete layer.mask;
    if (layer.id === "specimen-iris") layer.visible = false;
    if (layer.id !== "tide-field" || !layer.emitter) continue;
    delete layer.matte;
    delete layer.emitter.trail;
    layer.emitter.shading = { mode: "flat", sizeJitter: 0, opacityJitter: 0, glow: 0 };
  }
  return baseline;
}
