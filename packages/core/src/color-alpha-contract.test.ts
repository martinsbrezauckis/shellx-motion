import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { listRendererCapabilityCards } from "./capabilities";
import { CURRENT_COLOR_ALPHA_CONTRACT, currentColorAlphaContract } from "./color-alpha-contract";
import { isSupportedMotionColorString, MAX_MOTION_COLOR_STRING_LENGTH } from "./color";
import { buildMotionPublicSchema } from "./motion-public-schema";
import { loadSchema, validateDocument } from "./validate";

interface ColorAlphaFixture {
  schema: "shellx-motion/color-alpha-conformance@1";
  contract: "shellx-motion/color-alpha@1";
  authoredColorInputs: Array<{ label: string; value: string; accepted: boolean }>;
  lanes: Record<string, Record<string, unknown>>;
}

async function readFixture(): Promise<ColorAlphaFixture> {
  return JSON.parse(await readFile(new URL("../../../fixtures/color-alpha/current-sdr-contract.json", import.meta.url), "utf8")) as ColorAlphaFixture;
}

function motionWithColorKeyframe(value: string) {
  return {
    schema: "shellx-motion/motion@1",
    id: "motion_color_alpha_contract",
    name: "Colour alpha contract",
    durationMs: 1000,
    fps: 30,
    width: 64,
    height: 64,
    layers: [{
      id: "panel",
      type: "shape",
      shape: "rect",
      startMs: 0,
      durationMs: 1000,
      keyframes: { fill: [{ atMs: 0, value }] }
    }],
    assets: [],
    provenance: { sourceApp: "shellx-motion", createdBy: "color-alpha-contract.test" }
  };
}

describe("current colour and alpha contract", () => {
  it("pins the current observable boundary to the conformance fixture, not ADR-0204's target", async () => {
    const fixture = await readFixture();

    expect(fixture.schema).toBe("shellx-motion/color-alpha-conformance@1");
    expect(CURRENT_COLOR_ALPHA_CONTRACT).toMatchObject({
      schema: fixture.contract,
      status: "current-observable",
      authoredColors: {
        encoding: "sdr-srgb-encoded",
        syntax: "motion-css-subset",
        unsupportedSyntax: "wide-gamut-and-hdr-color-functions-refused"
      },
      unprofiledRaster: {
        assumption: "sdr-srgb-encoded",
        embeddedProfiles: "unsupported-undefined"
      },
      unsupported: ["hdr", "wide-gamut", "icc-profile-conversion", "ocio", "user-selectable-working-space"]
    });
    for (const [lane, expected] of Object.entries(fixture.lanes)) {
      expect(CURRENT_COLOR_ALPHA_CONTRACT.lanes[lane as keyof typeof CURRENT_COLOR_ALPHA_CONTRACT.lanes]).toMatchObject(expected);
    }
  });

  it("accepts only the current authored SDR syntax and refuses wide-gamut/HDR colour functions through the validator", async () => {
    const fixture = await readFixture();
    const motionSchema = await loadSchema("motion");

    for (const vector of fixture.authoredColorInputs) {
      expect(isSupportedMotionColorString(vector.value), vector.label).toBe(vector.accepted);
      const result = await validateDocument(motionSchema, motionWithColorKeyframe(vector.value));
      expect(result.ok, vector.label).toBe(vector.accepted);
      if (!vector.accepted && !result.ok) {
        expect(result.errors).toContainEqual({
          path: "/layers/0/keyframes/fill/0/value",
          message: "must be a supported color string"
        });
      }
    }
  });

  it("publishes the shared color bound for fixed GPU material arrays", async () => {
    const motionSchema = buildMotionPublicSchema() as Record<string, any>;
    expect(motionSchema.$defs.shader.properties.gpuMaterial.properties.colors.items.maxLength).toBe(MAX_MOTION_COLOR_STRING_LENGTH);
  });

  it("clones lane colour/alpha evidence for callers and the local SDK boundary", () => {
    const firstNative = listRendererCapabilityCards().find((card) => card.lane === "native");
    expect(firstNative?.colorAlpha).toMatchObject({
      alphaBoundary: "straight-rgba-png",
      filterDomain: "temporary-premultiplied-encoded-srgb",
      blendDomain: "encoded-srgb",
      crossRendererConformance: false
    });
    const mutableUnsupported = firstNative?.colorAlpha?.unsupported as string[] | undefined;
    mutableUnsupported?.push("not-a-real-contract-feature");
    expect(listRendererCapabilityCards().find((card) => card.lane === "native")?.colorAlpha?.unsupported)
      .not.toContain("not-a-real-contract-feature");

    const sdkContract = currentColorAlphaContract();
    (sdkContract.lanes.native.unsupported as string[]).push("not-a-real-contract-feature");
    expect(currentColorAlphaContract().lanes.native.unsupported).not.toContain("not-a-real-contract-feature");
  });

  it("describes the GPU-to-FFmpeg boundary as a raw RGBA stream rather than PNG transport", () => {
    expect(CURRENT_COLOR_ALPHA_CONTRACT.lanes.gpu.alphaBoundary).toBe("straight-rgba-stream");
    expect(CURRENT_COLOR_ALPHA_CONTRACT.lanes.ffmpeg.alphaBoundary).toBe("png-or-raw-rgba-frame-input");
  });
});
