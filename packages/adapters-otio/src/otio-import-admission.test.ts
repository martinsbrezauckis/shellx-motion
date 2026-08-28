import { describe, expect, it } from "vitest";
import { assertBoundedOtioJson, assertBoundedOtioJsonText, assertDistinctOtioLayerId, assertGeneratedOtioPackage, deriveOtioMilliseconds, requireOtioTimeRange, requirePositiveOtioDuration } from "./otio-import-admission";

describe("OTIO import admission", () => {
  it("rejects overflow, non-safe, and over-cap derived RationalTime", () => {
    for (const time of [{ value: 1, rate: Number.MIN_VALUE }, { value: 9_000_000_000_000_000, rate: 1 }, { value: 36_000_001, rate: 1_000 }]) {
      expect(() => deriveOtioMilliseconds(time, "duration")).toThrow(/safe integer millisecond/);
    }
  });

  it("requires an explicit positive source range and globally unique layer ids", () => {
    expect(() => requireOtioTimeRange(undefined, "clip.source_range")).toThrow("clip.source_range must be an object.");
    expect(() => requirePositiveOtioDuration({ value: 0, rate: 24 }, "clip.source_range.duration")).toThrow(/positive whole-millisecond/);
    expect(() => assertDistinctOtioLayerId(new Set(["clip_01"]), "clip_01", "tracks.children[0]")).toThrow(/duplicate Motion layer id/);
  });

  it("refuses a schema-invalid generated Motion document before publication", async () => {
    const manifest = { schema: "shellx-motion/package-manifest@1", id: "pkg_otio", name: "OTIO", motion: "motion.json", assets: [], sourceApp: "otio", compatibility: { lanes: ["otio"], hosts: ["shellx-motion"] } } as any;
    const motion = { schema: "shellx-motion/motion@1", id: "motion_otio", name: "OTIO", durationMs: -1, fps: 24, width: 1280, height: 720, layers: [], assets: [], provenance: { sourceApp: "otio", createdBy: "test" } } as any;
    await expect(assertGeneratedOtioPackage(manifest, motion)).rejects.toThrow(/generated an invalid Motion document/);
  });

  it("refuses structural amplification before OTIO-specific cloning or diagnostics", () => {
    expect(() => assertBoundedOtioJsonText(`[${Array.from({ length: 50_002 }, () => "{}").join(",")}]`)).toThrow("pre-parse structural limit");
    expect(() => assertBoundedOtioJsonText(JSON.stringify({ literal: "[{},".repeat(20_000) }))).not.toThrow();
    expect(() => assertBoundedOtioJson(Array.from({ length: 10_001 }, () => null))).toThrow("10000-item array limit");
    let nested: unknown = null;
    for (let index = 0; index < 34; index += 1) nested = { child: nested };
    expect(() => assertBoundedOtioJson(nested)).toThrow("32-level nesting limit");
  });
});
