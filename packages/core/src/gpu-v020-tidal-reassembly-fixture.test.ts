import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GPU_CAPABILITY, matchRendererCapability } from "./capabilities";
import { compileGpuScene2dPlan } from "./gpu-scene-2d-plan";
import { compileGpuSceneStaticPlan } from "./gpu-scene-static-plan";
import { validateMotionDocumentInStages } from "./motion-validation";
import type { MotionPackage } from "./types";
import { loadSchema, validateDocument } from "./validate";

const ROOT = fileURLToPath(new URL("../../../fixtures/packages/gpu-v020-tidal-reassembly", import.meta.url));
const TIMES = [0, 1_200, 3_000, 4_200, 6_000, 7_800] as const;

describe("Tidal Reassembly v0.2 particle fixture", () => {
  it("is a source-valid, asset-free GPU final package with a bounded v2 retained plan", async () => {
    const pkg = await readFixture();
    expect(await validateDocument(await loadSchema("packageManifest"), pkg.manifest)).toEqual({ ok: true });
    expect(await validateMotionDocumentInStages(pkg.motion)).toMatchObject({ ok: true });
    expect(pkg.manifest.compatibility.lanes).toEqual(["gpu", "ffmpeg"]);
    expect(pkg.manifest.assets).toEqual([]);
    expect(pkg.motion.assets).toEqual([]);
    expect(matchRendererCapability(pkg.motion, GPU_CAPABILITY)).toEqual({ ok: true, lane: "gpu", unsupported: [] });
    expect(compileGpuSceneStaticPlan(pkg.motion)).toMatchObject({
      ok: true,
      plan: {
        canonicalFrameCount: 240,
        resources: [],
        maxima: {
          maxComputeParticleFieldCount: 1,
          maxComputeParticleCount: 100_000,
          maxComputeParticleInstanceBytes: 64,
          maxComputeParticleRetainedMemoryBytes: 12_800_000,
          maxComputeParticleComputeDispatchCount: 1,
          maxComputeParticleRasterPassCount: 2
        }
      }
    });
  });

  it("lowers three organic streams, four fixed sources, analytic trails, and shading deterministically", async () => {
    const pkg = await readFixture();
    const fingerprints = new Set<string>();
    let replayFingerprint = "";
    for (const atMs of TIMES) {
      const result = compileGpuScene2dPlan(pkg.motion, atMs, { images: new Map(), fonts: new Map() });
      expect(result, `Tidal Reassembly at ${atMs}ms`).toMatchObject({ ok: true });
      if (!result.ok) continue;
      fingerprints.add(result.plan.frame.fingerprint);
      if (atMs === 4_200) replayFingerprint = result.plan.frame.fingerprint;
      expect(result.plan).toMatchObject({ particleCount: 100_000, pointCount: 0, maskCount: 0, matteCount: 0 });
      expect(result.plan.frame.budget).toMatchObject({
        computeParticleFieldCount: 1,
        computeParticleCount: 100_000,
        computeParticleBufferBytes: 12_800_000,
        computeParticleComputeDispatchCount: 1,
        computeParticleRasterPassCount: 2,
        maskCount: 0
      });
      expect(result.plan.frame.draws).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "particleCompute",
          id: "tide-field",
          schema: "shellx-motion/gpu-compute-particle-field@2",
          count: 100_000,
          atMs,
          sources: expect.arrayContaining([
            expect.objectContaining({ kind: "flow" }),
            expect.objectContaining({ kind: "turbulence" }),
            expect.objectContaining({ kind: "collision" }),
            expect.objectContaining({ kind: "impact" })
          ]),
          origins: expect.arrayContaining([
            expect.objectContaining({ weight: 0.36 }),
            expect.objectContaining({ weight: 0.36 }),
            expect.objectContaining({ weight: 0.28 })
          ]),
          trail: { durationMs: 36, samples: 2, opacity: 0.07 },
          shading: { mode: "glow", sizeJitter: 0.22, opacityJitter: 0.2, glow: 0.12 }
        })
      ]));
      expect(result.plan.frame.draws.some((draw) => draw.kind === "groupStart")).toBe(false);
      expect(result.plan.frame.draws.find((draw) => draw.id === "tide-field")).not.toHaveProperty("mask");
    }
    expect(fingerprints.size).toBe(TIMES.length);
    const replay = compileGpuScene2dPlan(pkg.motion, 4_200, { images: new Map(), fonts: new Map() });
    expect(replay).toMatchObject({ ok: true, plan: { frame: { fingerprint: replayFingerprint } } });
  });
});

async function readFixture(): Promise<MotionPackage> {
  const [manifest, motion] = await Promise.all([
    readFile(join(ROOT, "manifest.json"), "utf8"),
    readFile(join(ROOT, "motion.json"), "utf8")
  ]);
  return { root: ROOT, manifest: JSON.parse(manifest), motion: JSON.parse(motion) } as MotionPackage;
}
