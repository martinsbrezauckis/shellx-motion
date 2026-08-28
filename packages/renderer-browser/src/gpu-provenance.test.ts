import { describe, expect, it } from "vitest";
import type { GpuFrameBudget, MotionDocument } from "@shellx-motion/core";
import {
  createGpuResourceBudgetAccumulator,
  fingerprintGpuPipelineCatalog,
  fingerprintGpuStaticScene
} from "./gpu-provenance";
import { GPU_PAGE_PIPELINE_CATALOG } from "./gpu-page-pipeline-catalog";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("GPU provenance helpers", () => {
  it("fingerprints exact pipeline implementations independent of catalog ordering", () => {
    const alpha = () => "alpha";
    const beta = () => "beta";
    const first = fingerprintGpuPipelineCatalog([{ id: "beta", implementation: beta }, { id: "alpha", implementation: alpha }]);
    const second = fingerprintGpuPipelineCatalog([{ id: "alpha", implementation: alpha }, { id: "beta", implementation: beta }]);
    const changed = fingerprintGpuPipelineCatalog([{ id: "alpha", implementation: () => "changed" }, { id: "beta", implementation: beta }]);
    expect(first).toEqual(second);
    expect(changed.sha256).not.toBe(first.sha256);
    expect(() => fingerprintGpuPipelineCatalog([{ id: "alpha", implementation: alpha }, { id: "alpha", implementation: beta }])).toThrow("unique");
  });

  it("binds fixed page-owned pipelines into the catalog", () => {
    // C2 effects have a separate catalog; changing this would change every
    // module-free receipt that was admitted under the C1 browser contract.
    expect(GPU_PAGE_PIPELINE_CATALOG.sha256).toBe("0c96fc421c065c6cafae7232d9c1b2a911e2994a118e9dda01126f0f7bf33d3a");
    expect(GPU_PAGE_PIPELINE_CATALOG.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "page.chroma-matte-cleanup", implementationSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ id: "page.environment", implementationSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ id: "page.particle-compute", implementationSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ id: "page.resource-metrics", implementationSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ id: "page.serialization-runtime", implementationSha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
    ]));
  });

  it("binds document, exact resource hashes and pipeline digest", () => {
    const motion = document();
    const catalog = fingerprintGpuPipelineCatalog([{ id: "material", implementation: () => "wgsl" }]);
    const first = fingerprintGpuStaticScene({ motion, loadedInputHashes: { "motion.json": HASH_A }, resourceInputHashes: { "assets/font.woff2": HASH_B }, pipelineCatalogSha256: catalog.sha256 });
    const reordered = fingerprintGpuStaticScene({ motion, loadedInputHashes: { "assets/font.woff2": HASH_B, "motion.json": HASH_A }, resourceInputHashes: {}, pipelineCatalogSha256: catalog.sha256 });
    const changed = fingerprintGpuStaticScene({ motion: { ...motion, durationMs: 2_000 }, loadedInputHashes: { "motion.json": HASH_A }, resourceInputHashes: { "assets/font.woff2": HASH_B }, pipelineCatalogSha256: catalog.sha256 });
    expect(first).toEqual(reordered);
    expect(changed.sha256).not.toBe(first.sha256);
    expect(() => fingerprintGpuStaticScene({ motion, loadedInputHashes: { "motion.json": HASH_A }, resourceInputHashes: { "motion.json": HASH_B }, pipelineCatalogSha256: catalog.sha256 })).toThrow("conflicts");
  });

  it("orders catalog and input keys by code units instead of the host locale", () => {
    const upper = () => "upper";
    const lower = () => "lower";
    const catalog = fingerprintGpuPipelineCatalog([{ id: "zeta", implementation: lower }, { id: "alpha", implementation: upper }]);
    expect(catalog.entries.map((entry) => entry.id)).toEqual(["alpha", "zeta"]);
    const fingerprint = fingerprintGpuStaticScene({
      motion: document(),
      loadedInputHashes: { "z/input": HASH_A, "A/input": HASH_B },
      resourceInputHashes: {},
      pipelineCatalogSha256: catalog.sha256
    });
    const reordered = fingerprintGpuStaticScene({
      motion: document(),
      loadedInputHashes: { "A/input": HASH_B, "z/input": HASH_A },
      resourceInputHashes: {},
      pipelineCatalogSha256: catalog.sha256
    });
    expect(fingerprint).toEqual(reordered);
  });

  it("records exact canonical coverage and per-field high-water decisions", () => {
    const accumulator = createGpuResourceBudgetAccumulator(2);
    accumulator.observe(budget({ pointCount: 4, computeParticleFieldCount: 1, computeParticleCount: 100_000, computeParticleBufferBytes: 6_400_000, chromaKeyCount: 1, chromaKeyUniformBytes: 48, chromaMatteCleanupCount: 1, chromaMatteCleanupPassCount: 9, chromaMatteCleanupUniformBytes: 288, chromaMatteCleanupIntermediateTextureBytes: 96, estimatedPlanBytes: 80 }));
    accumulator.observe(budget({ pointCount: 2, materialCount: 1, estimatedPlanBytes: 120 }));
    const evidence = accumulator.finish();
    expect(evidence).toMatchObject({ expectedFrames: 2, observedFrames: 2, maxima: { pointCount: 4, computeParticleFieldCount: 1, computeParticleCount: 100_000, computeParticleBufferBytes: 6_400_000, chromaKeyCount: 1, chromaKeyUniformBytes: 48, chromaMatteCleanupCount: 1, chromaMatteCleanupPassCount: 9, chromaMatteCleanupUniformBytes: 288, chromaMatteCleanupIntermediateTextureBytes: 96, materialCount: 1, estimatedPlanBytes: 120 } });
    expect(evidence.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => accumulator.finish()).toThrow("already finalized");
  });

  it("preserves the no-module maxima shape but records exactly one bounded module budget when present", () => {
    const noModule = createGpuResourceBudgetAccumulator(1);
    noModule.observe(budget());
    const noModuleEvidence = noModule.finish();
    expect(noModuleEvidence.maxima).not.toHaveProperty("effectModuleCount");
    expect(noModuleEvidence.maxima).not.toHaveProperty("effectModuleUniformBytes");

    const withModule = createGpuResourceBudgetAccumulator(2);
    withModule.observe(budget());
    withModule.observe(budget({ effectModuleCount: 1, effectModuleUniformBytes: 160, effectModuleTextureLoadCount: 5, effectModulePassCount: 1 }));
    expect(withModule.finish().maxima).toMatchObject({ effectModuleCount: 1, effectModuleUniformBytes: 160, effectModuleTextureLoadCount: 5, effectModulePassCount: 1 });

    const partial = createGpuResourceBudgetAccumulator(1);
    expect(() => partial.observe(budget({ effectModuleCount: 1 }))).toThrow("shape");
    const forged = createGpuResourceBudgetAccumulator(1);
    expect(() => forged.observe(budget({ effectModuleCount: 1, effectModuleUniformBytes: 160, effectModuleTextureLoadCount: 6, effectModulePassCount: 1 }))).toThrow("effect-module");
  });

  it("refuses missing, extra, negative and unsafe budget evidence", () => {
    const missing = createGpuResourceBudgetAccumulator(2);
    missing.observe(budget());
    expect(() => missing.finish()).toThrow("does not cover");
    const negative = createGpuResourceBudgetAccumulator(1);
    expect(() => negative.observe(budget({ pointCount: -1 }))).toThrow("pointCount");
    const extra = createGpuResourceBudgetAccumulator(1);
    expect(() => extra.observe({ ...budget(), unexpected: 1 } as GpuFrameBudget)).toThrow("shape");
    expect(() => createGpuResourceBudgetAccumulator(216_001)).toThrow("216000");
  });
});

function document(): MotionDocument {
  return {
    schema: "shellx-motion/motion@1",
    id: "motion_gpu_provenance",
    name: "GPU provenance",
    durationMs: 1_000,
    fps: 30,
    width: 64,
    height: 36,
    layers: [],
    assets: [],
    provenance: { sourceApp: "test", createdBy: "test" }
  };
}

function budget(overrides: Partial<GpuFrameBudget> = {}): GpuFrameBudget {
  return {
    rectangleCount: 0, pointCount: 0, computeParticleFieldCount: 0, computeParticleCount: 0, triangleVertexCount: 0, imageCount: 0, chromaKeyCount: 0, chromaMatteCleanupCount: 0, chromaMatteCleanupPassCount: 0, textCount: 0,
    textUtf8Bytes: 0, textSurfacePixels: 0, scene3dCount: 0, scene3dObjectCount: 0,
    scene3dVertexCount: 0, scene3dIndexCount: 0, environmentCount: 0, materialCount: 0,
    gradientStopCount: 0, pointBufferBytes: 0, computeParticleBufferBytes: 0, computeParticleComputeDispatchCount: 0, computeParticleRasterPassCount: 0, triangleBufferBytes: 0, imageVertexBufferBytes: 0, chromaKeyUniformBytes: 0, chromaMatteCleanupUniformBytes: 0,
    textVertexBufferBytes: 0, scene3dVertexBufferBytes: 0, scene3dIndexBufferBytes: 0,
    scene3dUniformBytes: 0, environmentUniformBytes: 0, materialUniformBytes: 0,
    gradientUniformBytes: 0, styledRectangleUniformBytes: 0, blendModeCount: 0, colorEffectCount: 0,
    blurEffectCount: 0, glowEffectCount: 0, maskCount: 0, blurPassCount: 0, adjustmentCount: 0,
    motionBlurGroupCount: 0, motionBlurSampleCount: 0, groupCount: 0, groupMaxDepth: 0,
    compositeCount: 0, compositeUniformBytes: 0, blurUniformBytes: 0, glowUniformBytes: 0,
    maskUniformBytes: 0, adjustmentUniformBytes: 0, chromaMatteCleanupIntermediateTextureBytes: 0, compositeIntermediateTextureBytes: 0,
    estimatedPlanBytes: 0,
    ...overrides
  };
}
