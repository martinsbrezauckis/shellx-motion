import { describe, expect, it } from "vitest";
import type { MotionPackage } from "@shellx-motion/core";
import { browserTypographyAttestationRefusal } from "./typography-attestation";

describe("browser typography attestation preflight", () => {
  it("refuses a font-fallback attestation for active browser HTML without guessing whether it draws text", () => {
    const refusal = browserTypographyAttestationRefusal(packageWith({
      layers: [{ id: "interactive", type: "web", source: "card.html", startMs: 0, durationMs: 1_000 }]
    }));

    expect(refusal).toEqual({
      code: "browser_html_typography_unverified",
      message: expect.stringContaining("arbitrary text, canvas text, host fonts"),
      detail: { attestation: "font-fallback", scope: "html-web-canvas", layerIds: ["interactive"] }
    });
  });

  it("accepts generated MotionIR only when every requested family is manifest-bound", () => {
    const verified = packageWith({
      assets: [{ id: "brand", type: "font", family: "Brand", source: { path: "assets/brand.woff2", mimeType: "font/woff2" } }],
      layers: [{ id: "title", type: "text", text: "Brand", startMs: 0, durationMs: 1_000, style: { fontFamily: "Brand" } }]
    }, ["assets/brand.woff2"]);
    const unverified = packageWith({
      layers: [{ id: "title", type: "text", text: "Host font", startMs: 0, durationMs: 1_000, style: { fontFamily: "Inter, sans-serif" } }]
    });

    expect(browserTypographyAttestationRefusal(verified)).toBeNull();
    expect(browserTypographyAttestationRefusal(unverified)).toEqual({
      code: "browser_motion_typography_unverified",
      message: expect.stringContaining("manifest-declared package font asset"),
      detail: { attestation: "font-fallback", scope: "motion-ir", layerIds: ["title"] }
    });
  });

  it("resolves a MotionIR font-family design token before testing manifest provenance", () => {
    const pkg = packageWith({
      assets: [{ id: "brand", type: "font", family: "Brand", source: { path: "assets/brand.woff2", mimeType: "font/woff2" } }],
      layers: [{ id: "title", type: "text", text: "Brand", startMs: 0, durationMs: 1_000, style: { fontFamily: "{typography.brand}" } }]
    }, ["assets/brand.woff2"]);
    pkg.motion.designTokens = { typography: { brand: "Brand" } };

    expect(browserTypographyAttestationRefusal(pkg)).toBeNull();
  });
});

function packageWith(
  motion: Pick<MotionPackage["motion"], "layers"> & Partial<Pick<MotionPackage["motion"], "assets">>,
  manifestAssets: string[] = []
): MotionPackage {
  return {
    root: "/package",
    manifest: {
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_typography",
      name: "Typography",
      motion: "motion.json",
      assets: manifestAssets,
      sourceApp: "test",
      compatibility: { lanes: ["browser"], hosts: ["motion"] },
      quality: { maxFontFallbacks: 0 }
    },
    motion: {
      schema: "shellx-motion/motion@1",
      id: "motion_typography",
      name: "Typography",
      width: 320,
      height: 180,
      fps: 30,
      durationMs: 1_000,
      layers: motion.layers as MotionPackage["motion"]["layers"],
      assets: motion.assets ?? [],
      provenance: { sourceApp: "test", createdBy: "test" }
    }
  };
}
