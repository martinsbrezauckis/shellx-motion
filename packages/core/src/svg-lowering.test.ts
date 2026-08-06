import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSchema, validateDocument } from "./validate";
import { lowerStaticSvgToMotion } from "./svg-lowering";

describe("static SVG lowering", () => {
  it("lowers a fully consumed static path fixture into a validated source-bound Motion document", async () => {
    const sourcePath = resolve("../../fixtures/imports/svg-static-path/input.svg");
    const sourceText = await readFile(sourcePath, "utf8");

    const lowered = lowerStaticSvgToMotion({
      adapterId: "adapter.svg",
      sourcePath,
      sourceText,
      normalizedPackagePath: "pkg_svg_static_path",
      createdBy: "svg-test",
      createdAt: "2026-07-12T03:40:00.000Z"
    });

    expect(await validateDocument(await loadSchema("motion"), lowered.motion)).toEqual({ ok: true });
    expect(lowered.motion).toMatchObject({
      id: expect.stringMatching(/^motion_svg_[a-f0-9]{16}$/),
      name: "Static SVG Path",
      width: 640,
      height: 360,
      provenance: { sourceApp: "svg", createdBy: "svg-test", sourceSchema: "svg-static-path" }
    });
    expect(lowered.motion.layers).toEqual([
      expect.objectContaining({
        id: "accent-curve",
        type: "shape",
        shape: "path",
        "x-path-viewBox": "0 0 640 360",
        transform: expect.objectContaining({ opacity: 0.9 }),
        style: { fill: "transparent", stroke: "#00d4ff", strokeWidth: 14, strokeLinecap: "round" }
      }),
      expect.objectContaining({
        id: "underline",
        style: { fill: "transparent", stroke: "#ffffff", strokeWidth: 4, strokeLinecap: "butt" }
      })
    ]);
    expect(lowered.receipt).toMatchObject({
      operation: "adapter.lower",
      status: "warning",
      packageId: "pkg_svg_static_path",
      inputHashes: { source: lowered.source.sha256 },
      output: {
        adapterId: "adapter.svg",
        motionId: lowered.motion.id,
        motionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        layerCount: 2,
        acceptedWarningFeatures: [{ path: "svg.path#accent-curve", feature: "svg.path.curve" }]
      }
    });
  });

  it("refuses executable, referenced, malformed, unknown, oversized, and partial XML constructs", () => {
    const lower = (sourceText: string) => lowerStaticSvgToMotion({
      adapterId: "adapter.svg",
      sourcePath: "source/input.svg",
      sourceText,
      normalizedPackagePath: "pkg_svg_unsafe"
    });
    expect(() => lower('<!DOCTYPE svg [<!ENTITY x "boom">]><svg width="1" height="1"><path d="M0 0L1 1"/></svg>')).toThrow("refuses DTD");
    expect(() => lower('<svg width="1" height="1"><path d="M0 0L1 1" onclick="alert(1)"/></svg>')).toThrow(/executable or referenced attribute/);
    expect(() => lower('<svg width="1" height="1"><path d="M0 0L1 1" fill="url(#paint)"/></svg>')).toThrow(/referenced attribute/);
    expect(() => lower('<svg width="1" height="1"><rect width="1" height="1"/></svg>')).toThrow(/does not implement element <rect>/);
    expect(() => lower('<svg width="1" height="1"><path d="M0 0 X 1 1"/></svg>')).toThrow(/unsupported path syntax/);
    expect(() => lower('<svg width="1" height="1"><path d="M0 0 C 1 2 3"/></svg>')).toThrow(/incomplete C command/);
    expect(() => lower('<svg width="1" height="1"><path d="M0 0 A 1 1 0 2 0 1 1"/></svg>')).toThrow(/invalid arc radii or flags/);
    expect(() => lower('<svg width="1" height="1"><path d="M0 0L1 1"></svg>')).toThrow(/mismatched closing tag/);
    expect(() => lower('<svg width="1" height="1"><path d="M0 0L1 1"><path d="M0 0L1 1"/></path></svg>')).toThrow(/cannot contain child/);
    expect(() => lower('<svg width="1" height="1">trailing<path d="M0 0L1 1"/></svg>')).toThrow(/text content/);
  });
});
