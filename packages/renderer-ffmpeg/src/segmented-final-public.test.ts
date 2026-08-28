import { describe, expect, it } from "vitest";
import type { MotionPackage } from "@shellx-motion/core";
import { renderSegmentedFinal } from "./index.js";

describe("public segmented final delivery", () => {
  it("accepts no caller-controlled store field and refuses an invalid high-level checkpoint size before I/O", async () => {
    const result = await renderSegmentedFinal({
      pkg: {} as MotionPackage,
      frameLane: "native",
      outputPath: "/tmp/never-created.mp4",
      segmented: { segmentFrames: 0 }
    });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "segment_checkpoint_invalid", retryable: false, evidence: { phase: "preflight" } })
    });
  });

  it("refuses a malformed GPU package before any lane-specific dereference", async () => {
    const result = await renderSegmentedFinal({
      pkg: {} as MotionPackage,
      frameLane: "gpu",
      outputPath: "/tmp/never-created-gpu.mp4",
      segmented: { segmentFrames: 1 }
    });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "segment_checkpoint_invalid",
        retryable: false,
        evidence: { phase: "preflight" }
      })
    });
  });

  it("refuses an accessor-backed input package field without invoking it", async () => {
    let pkgReads = 0;
    const input: Record<string, unknown> = {
      frameLane: "gpu",
      outputPath: "/tmp/never-created-input-accessor.mp4",
      segmented: { segmentFrames: 1 }
    };
    Object.defineProperty(input, "pkg", {
      enumerable: true,
      get() {
        pkgReads += 1;
        throw new Error("hostile package accessor must not run");
      }
    });
    const result = await renderSegmentedFinal(input as unknown as Parameters<typeof renderSegmentedFinal>[0]);
    expect(result).toMatchObject({ ok: false, error: { code: "segment_checkpoint_invalid", evidence: { phase: "preflight" } } });
    expect(pkgReads).toBe(0);
  });

  it("refuses an accessor-backed output path without invoking it", async () => {
    let outputPathReads = 0;
    const input: Record<string, unknown> = {
      pkg: {
        root: "/tmp/hostile-output-path",
        manifest: { id: "hostile-output-path", motion: "motion.json" },
        motion: { durationMs: 1_000, fps: 1, width: 16, height: 16, layers: [] }
      },
      frameLane: "native",
      segmented: { segmentFrames: 1 }
    };
    Object.defineProperty(input, "outputPath", {
      enumerable: true,
      get() {
        outputPathReads += 1;
        throw new Error("hostile output path accessor must not run");
      }
    });
    const result = await renderSegmentedFinal(input as unknown as Parameters<typeof renderSegmentedFinal>[0]);
    expect(result).toMatchObject({ ok: false, error: { code: "segment_checkpoint_invalid", evidence: { phase: "preflight" } } });
    expect(outputPathReads).toBe(0);
  });

  it("refuses a forged deferred-publication object at the public final-render boundary", async () => {
    const input: Record<string, unknown> = {
      pkg: {
        root: "/tmp/forged-publication-package",
        manifest: { id: "forged-publication-package", motion: "motion.json" },
        motion: { durationMs: 1_000, fps: 1, width: 16, height: 16, layers: [] }
      },
      frameLane: "native",
      outputPath: "/tmp/forged-publication.mp4",
      segmented: { segmentFrames: 1 },
      privateOutputPublication: {
        outputPath: "/tmp/forged-publication.mp4",
        stagingPath: "/tmp/private-forged-publication.mp4"
      }
    };

    const result = await renderSegmentedFinal(input as unknown as Parameters<typeof renderSegmentedFinal>[0]);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "segment_checkpoint_invalid", evidence: { phase: "preflight" } }
    });
  });

  it("refuses an accessor-backed package boundary before GPU preflight", async () => {
    let motionReads = 0;
    const pkg = {
      root: "/tmp/hostile-package",
      manifest: { id: "hostile-package", motion: "motion.json" }
    };
    Object.defineProperty(pkg, "motion", {
      enumerable: true,
      get() {
        motionReads += 1;
        throw new Error("hostile package motion accessor must not reach GPU preflight");
      }
    });
    const result = await renderSegmentedFinal({
      pkg: pkg as MotionPackage,
      frameLane: "gpu",
      outputPath: "/tmp/never-created-accessor.mp4",
      segmented: { segmentFrames: 1 }
    });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "segment_checkpoint_invalid",
        retryable: false,
        evidence: { phase: "preflight" }
      })
    });
    expect(motionReads).toBe(0);
  });
});
