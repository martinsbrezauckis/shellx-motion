import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  COLOR_PIPELINE_SCHEMA,
  GPU_CAPABILITY,
  colorPipelineRenderPlan,
  colorPipelineValidationReceiptEvidence,
  currentColorAlphaContract,
  listRendererCapabilityCards,
  matchRendererCapability,
  matchRendererCapabilityCards,
  resolveMotionColorPipeline,
  type MotionDocument,
} from "./index";
import { loadSchema, validateDocument } from "./validate";

interface F0Fixture {
  schema: "shellx-motion/color-pipeline-conformance@1";
  legacy: { omitted: true; intent: "legacy-encoded-sdr@0.2.65"; working: "legacy-encoded-renderer-defined"; admission: "legacy-compatible" };
  strict: {
    declaration: { schema: "shellx-motion/color-pipeline@1"; intent: "linear-srgb-sdr@1" };
    working: "premultiplied-linear-srgb";
    delivery: "sdr-bt709-limited";
    admission: "strict-route-available";
    requiredRoute: { frameLane: "gpu"; finalLane: "ffmpeg"; output: "mp4-h264"; target: "final" };
  };
}

async function fixture(): Promise<F0Fixture> {
  return JSON.parse(await readFile(new URL("../../../fixtures/color-pipeline/f0-contract.json", import.meta.url), "utf8")) as F0Fixture;
}

function motion(overrides: Partial<MotionDocument> = {}): MotionDocument {
  return {
    schema: "shellx-motion/motion@1",
    id: "f0-colour-pipeline",
    name: "F0 colour pipeline",
    durationMs: 1000,
    fps: 30,
    width: 64,
    height: 64,
    background: "#000000",
    layers: [{ id: "rect", type: "shape", shape: "rect", startMs: 0, durationMs: 1000 }],
    assets: [],
    provenance: { sourceApp: "shellx-motion", createdBy: "color-pipeline.test" },
    ...overrides,
  };
}

describe("color-pipeline@1 F0 contract", () => {
  it("resolves omission to an explicit legacy identity without changing the observable color-alpha boundary", async () => {
    const vectors = await fixture();
    const legacy = resolveMotionColorPipeline(motion());
    const plan = colorPipelineRenderPlan(motion());

    expect(vectors.schema).toBe("shellx-motion/color-pipeline-conformance@1");
    expect(legacy).toMatchObject({
      schema: COLOR_PIPELINE_SCHEMA,
      intent: vectors.legacy.intent,
      package: { working: vectors.legacy.working },
    });
    expect(plan.admission).toBe(vectors.legacy.admission);
    expect(currentColorAlphaContract().lanes.gpu.blendDomain).toBe("premultiplied-encoded-srgb");
    await expect(validateDocument(await loadSchema("motion"), motion())).resolves.toEqual({ ok: true });
  });

  it("accepts only the closed strict declaration and projects its exact future render route", async () => {
    const vectors = await fixture();
    const strict = motion({ colorPipeline: vectors.strict.declaration });
    const plan = colorPipelineRenderPlan(strict);

    await expect(validateDocument(await loadSchema("motion"), strict)).resolves.toEqual({ ok: true });
    expect(plan).toMatchObject({
      admission: vectors.strict.admission,
      contract: {
        intent: vectors.strict.declaration.intent,
        package: { working: vectors.strict.working },
        render: { delivery: vectors.strict.delivery },
      },
      strictRequirements: vectors.strict.requiredRoute,
    });

    const invalid = motion({ colorPipeline: { ...vectors.strict.declaration, colorSpace: "display-p3" } as never });
    await expect(validateDocument(await loadSchema("motion"), invalid)).resolves.toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        { path: "/colorPipeline/colorSpace", message: "is not allowed by the closed color-pipeline@1 contract" }
      ])
    });
  });

  it("refuses a strict declaration whose scene is outside the bounded final-route subset", async () => {
    const vectors = await fixture();
    const strict = motion({ colorPipeline: vectors.strict.declaration });
    const result = matchRendererCapabilityCards(strict, {
      output: vectors.strict.requiredRoute.output,
      target: vectors.strict.requiredRoute.target,
      preferLane: vectors.strict.requiredRoute.frameLane,
    });

    expect(result.recommendedLane).toBeNull();
    expect(result.colorPipelinePlan).toMatchObject({ admission: "strict-route-available", strictRequirements: vectors.strict.requiredRoute });
    for (const match of result.matches) {
      expect(match.ok, match.lane).toBe(false);
      expect(match.unsupported).toContainEqual(expect.objectContaining({
        layerId: "__color_pipeline__",
        feature: "color-pipeline:linear-srgb-sdr@1",
      }));
    }
    expect(matchRendererCapability(strict, GPU_CAPABILITY)).toMatchObject({
      ok: false,
      unsupported: [expect.objectContaining({ feature: "color-pipeline:linear-srgb-sdr@1" })]
    });
  });

  it("discovers only the exact bounded GPU to FFmpeg strict final pipeline while direct GPU remains closed", async () => {
    const strict = motion({
      colorPipeline: { schema: COLOR_PIPELINE_SCHEMA, intent: "linear-srgb-sdr@1" },
      layers: [{
        id: "rect", type: "shape", shape: "rect", startMs: 0, durationMs: 1000,
        fill: "#ff0040", opacity: 0.5, transform: { x: 0, y: 0, width: 32, height: 32 },
      }],
    });
    const result = matchRendererCapabilityCards(strict, { output: "mp4-h264", target: "final", preferLane: "gpu" });
    expect(result.recommendedLane).toBe("ffmpeg");
    expect(result.recommendedPipeline).toMatchObject({ lanes: ["gpu", "ffmpeg"], frameLane: "gpu", finalLane: "ffmpeg" });
    expect(result.matches.find((match) => match.lane === "gpu")?.ok).toBe(true);
    expect(result.matches.find((match) => match.lane === "ffmpeg")?.ok).toBe(true);
    expect(result.matches.find((match) => match.lane === "browser")?.ok).toBe(false);
    expect(matchRendererCapability(strict, GPU_CAPABILITY)).toMatchObject({
      ok: false,
      unsupported: [expect.objectContaining({ feature: "color-pipeline:linear-srgb-sdr@1" })],
    });
  });

  it("projects the same closed contract into cloned capability cards and validation receipt evidence", () => {
    const strict = motion({ colorPipeline: { schema: COLOR_PIPELINE_SCHEMA, intent: "linear-srgb-sdr@1" } });
    const gpu = listRendererCapabilityCards().find((card) => card.lane === "gpu");
    expect(gpu?.colorPipeline).toMatchObject({
      schema: "shellx-motion/color-pipeline-capability@1",
      admittedPackageIntents: ["legacy-encoded-sdr@0.2.65", "linear-srgb-sdr@1"],
      strictLinearSrgbSdr: { status: "conditional-route", route: { frameLane: "gpu", finalLane: "ffmpeg", output: "mp4-h264", target: "final" } }
    });
    (gpu?.colorPipeline?.admittedPackageIntents as string[] | undefined)?.push("not-real");
    expect(listRendererCapabilityCards().find((card) => card.lane === "gpu")?.colorPipeline?.admittedPackageIntents).toEqual(["legacy-encoded-sdr@0.2.65", "linear-srgb-sdr@1"]);
    expect(listRendererCapabilityCards().find((card) => card.lane === "browser")?.colorPipeline?.strictLinearSrgbSdr.status).toBe("unsupported");

    expect(colorPipelineValidationReceiptEvidence(strict)).toMatchObject({
      requested: { intent: "linear-srgb-sdr@1" },
      actual: {
        status: "not-executed",
        laneImplementation: "not-observed",
        decodedPixels: "not-observed",
        artifactHashes: "package-input-hashes-bound"
      }
    });
  });
});
