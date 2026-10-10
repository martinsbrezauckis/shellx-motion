import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeFrameSequenceMotion,
  comparePngBuffers,
  comparePngFiles,
  encodeRgbaPng,
  inspectFrameSequence,
  inspectPngBuffer,
  inspectPngFile,
  inspectPngFileRegion
} from "./quality";
import { MAX_MOTION_PNG_ENCODED_BYTES } from "./png-rgba-decode";

const onePixelPng = encodeRgbaPng(1, 1, Buffer.from([20, 80, 180, 255]));
const fullRegion = { x: 0, y: 0, width: 1, height: 1 };

describe("encoded PNG quality input bound", () => {
  it("preserves ordinary file inspection and comparison", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-quality-encoded-control-"));
    try {
      const path = join(root, "frame.png");
      await writeFile(path, onePixelPng);
      expect((await inspectPngFile(path)).ok).toBe(true);
      expect((await inspectPngFileRegion(path, fullRegion)).ok).toBe(true);
      expect((await comparePngFiles(path, path)).ok).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a sparse over-budget PNG on every file route before decoding", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-quality-encoded-limit-"));
    try {
      const ordinary = join(root, "ordinary.png");
      const oversized = join(root, "oversized.png");
      await writeFile(ordinary, onePixelPng);
      await writeFile(oversized, onePixelPng);
      await truncate(oversized, MAX_MOTION_PNG_ENCODED_BYTES + 1);

      expect(await inspectPngFile(oversized)).toMatchObject({
        ok: false, code: "invalid_png", message: expect.stringContaining("encoded bytes exceed")
      });
      await expect(inspectPngFileRegion(oversized, fullRegion)).rejects.toThrow(/encoded bytes exceed/i);
      await expect(comparePngFiles(ordinary, oversized)).rejects.toThrow(/encoded bytes exceed/i);
      expect(await inspectFrameSequence({ framePaths: [oversized], durationMs: 1000 })).toMatchObject({
        ok: false, code: "invalid_frame", message: expect.stringContaining("encoded bytes exceed")
      });
      expect(await analyzeFrameSequenceMotion([oversized], [0], { durationMs: 1000 })).toMatchObject({
        status: "unavailable", reason: expect.stringContaining("encoded bytes exceed")
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses an already materialized over-budget PNG before decoding", () => {
    const oversized = Buffer.alloc(MAX_MOTION_PNG_ENCODED_BYTES + 1);
    expect(inspectPngBuffer(oversized)).toMatchObject({
      ok: false, code: "invalid_png", message: expect.stringContaining("encoded bytes exceed")
    });
    expect(comparePngBuffers(onePixelPng, oversized)).toMatchObject({
      ok: false, code: "invalid_png", message: expect.stringContaining("encoded bytes exceed")
    });
  });
});
