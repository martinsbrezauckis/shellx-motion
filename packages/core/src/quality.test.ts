import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { buildVisualDiffPng, comparePngBuffers, encodeRgbaPng, inspectFrameSequence, inspectPngBuffer, inspectPngRegionBuffer, summarizeFrameQuality } from "./quality";

const tempDirs: string[] = [];

describe("Motion output quality inspection", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("classifies all-black PNG frames as a blocking blank output", () => {
    const result = inspectPngBuffer(BLACK_PNG);

    expect(result).toMatchObject({
      ok: true,
      width: 2,
      height: 2,
      blank: true,
      luma: { min: 0, max: 0, range: 0 }
    });
  });

  it("accepts frames with visible contrast", () => {
    const result = inspectPngBuffer(CONTRAST_PNG);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.blank).toBe(false);
    expect(result.luma.range).toBeGreaterThan(200);
    expect(result.luma.brightPixels).toBeGreaterThan(0);
    expect(result.luma.brightRatio).toBeGreaterThan(0);
    expect(result.edges.pixels).toBeGreaterThan(0);
    expect(result.edges.ratio).toBeGreaterThan(0);
  });

  it("counts bounded chroma-rich pixels separately from brightness", () => {
    const result = inspectPngBuffer(rgbaPng(2, 1, [[0, 80, 160, 255], [96, 100, 104, 255]]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.chroma).toEqual({ pixels: 1, ratio: 0.5, channelSpanThreshold: 32 });
  });

  it("reports alpha coverage for transparent overlay frames", () => {
    const result = inspectPngBuffer(ALPHA_2X2_PNG);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pixels).toBe(4);
    expect(result.transparentPixels).toBe(2);
    expect(result.transparentRatio).toBe(0.5);
    expect(result.nonTransparentPixels).toBe(2);
    expect(result.nonTransparentRatio).toBe(0.5);
    expect(result.opaquePixels).toBe(1);
    expect(result.opaqueRatio).toBe(0.25);
  });

  it("rejects interlaced PNG frames instead of misreading scanlines", () => {
    const result = inspectPngBuffer(rgbaPng(1, 1, [[255, 255, 255, 255]], { interlaceMethod: 1 }));

    expect(result).toEqual({
      ok: false,
      code: "invalid_png",
      message: "Unsupported PNG interlace method: 1."
    });
  });

  it("rejects PNG frames with invalid chunk CRCs before using them as visual evidence", () => {
    const result = inspectPngBuffer(corruptPngChunkCrc(CONTRAST_PNG, "IDAT"));

    expect(result).toEqual({
      ok: false,
      code: "invalid_png",
      message: "PNG chunk IDAT has invalid CRC."
    });
  });

  it("summarizes frame quality for receipt and final media checks", () => {
    const blank = inspectPngBuffer(BLACK_PNG);
    const contrast = inspectPngBuffer(CONTRAST_PNG);

    expect(blank.ok).toBe(true);
    expect(contrast.ok).toBe(true);
    if (!blank.ok || !contrast.ok) return;
    expect(summarizeFrameQuality([blank, contrast])).toEqual({
      frameCount: 2,
      blankFrames: 1,
      minTransparentPixels: 0,
      maxTransparentPixels: 0,
      minNonTransparentPixels: 2,
      maxNonTransparentPixels: 4,
      minOpaquePixels: 2,
      maxOpaquePixels: 4,
      minDarkPixels: contrast.luma.darkPixels,
      maxDarkPixels: blank.luma.darkPixels,
      minBrightPixels: 0,
      maxBrightPixels: contrast.luma.brightPixels,
      minLumaRange: 0,
      maxLumaRange: contrast.luma.range,
      minChromaPixels: 0,
      maxChromaPixels: contrast.chroma.pixels,
      minEdgePixels: 0,
      maxEdgePixels: contrast.edges.pixels
    });
  });

  it("inspects visual structure inside bounded regions for typography/layout gates", () => {
    const result = inspectPngRegionBuffer(STRUCTURED_4X2_PNG, { x: 2, y: 0, width: 2, height: 2 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.width).toBe(2);
    expect(result.height).toBe(2);
    expect(result.blank).toBe(false);
    expect(result.luma.darkPixels).toBe(2);
    expect(result.luma.brightPixels).toBe(2);
    expect(result.edges.pixels).toBe(2);
  });

  it("reports empty structure for flat regions", () => {
    const result = inspectPngRegionBuffer(STRUCTURED_4X2_PNG, { x: 0, y: 0, width: 2, height: 2 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.blank).toBe(true);
    expect(result.luma.darkPixels).toBe(4);
    expect(result.luma.brightPixels).toBe(0);
    expect(result.edges.pixels).toBe(0);
  });

  it("reports zero visual diff for identical PNG buffers", () => {
    const diff = comparePngBuffers(BLACK_PNG, BLACK_PNG);

    expect(diff).toEqual({
      ok: true,
      width: 2,
      height: 2,
      pixels: 4,
      changedPixels: 0,
      changedRatio: 0,
      meanAbsoluteError: 0,
      meanSquaredError: 0,
      rootMeanSquaredError: 0,
      psnrDb: null,
      ssim: 1,
      maxChannelDelta: 0
    });
  });

  it("reports changed pixels and channel error for same-size PNG buffers", () => {
    const diff = comparePngBuffers(RED_PNG, BLACK_PNG);

    expect(diff).toMatchObject({
      ok: true,
      width: 2,
      height: 2,
      pixels: 4,
      changedPixels: 4,
      changedRatio: 1,
      maxChannelDelta: 255
    });
    expect(diff.ok && diff.meanAbsoluteError).toBeGreaterThan(60);
    expect(diff.ok && diff.meanSquaredError).toBeGreaterThan(10000);
    expect(diff.ok && diff.rootMeanSquaredError).toBeGreaterThan(100);
    expect(diff.ok && diff.psnrDb).toBeLessThan(10);
    expect(diff.ok && diff.ssim).toBeLessThan(0.01);
  });

  it("can compare only RGB channels when alpha differs between preview and encoded media", () => {
    const opaque = rgbaPng(1, 1, [[24, 48, 96, 255]]);
    const transparent = rgbaPng(1, 1, [[24, 48, 96, 0]]);

    const diff = comparePngBuffers(opaque, transparent, { compareAlpha: false });

    expect(diff).toEqual({
      ok: true,
      width: 1,
      height: 1,
      pixels: 1,
      changedPixels: 0,
      changedRatio: 0,
      meanAbsoluteError: 0,
      meanSquaredError: 0,
      rootMeanSquaredError: 0,
      psnrDb: null,
      ssim: 1,
      maxChannelDelta: 0
    });

    const alphaAwareDiff = comparePngBuffers(opaque, transparent);
    expect(alphaAwareDiff.ok && alphaAwareDiff.ssim).toBeLessThan(1);
  });

  it("fails a frame sequence when every sampled frame is blank", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shellx-motion-quality-blank-"));
    tempDirs.push(dir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "000001.png"), BLACK_PNG);
    await writeFile(join(dir, "000002.png"), BLACK_PNG);

    const result = await inspectFrameSequence({
      framePaths: [join(dir, "000001.png"), join(dir, "000002.png")],
      minDurationMs: 1000,
      durationMs: 1000
    });

    expect(result).toMatchObject({
      ok: false,
      code: "blank_frames",
      message: "Rendered frame sequence is blank or visually empty."
    });
  });

  it("fails frame sequence quality checks when no frames are sampled", async () => {
    const result = await inspectFrameSequence({
      framePaths: [],
      minDurationMs: 1000,
      durationMs: 1000
    });

    expect(result).toMatchObject({
      ok: false,
      code: "no_frames",
      message: "Rendered frame sequence has no sampled frames."
    });
  });

  it("fails frame sequence quality checks when a sampled frame is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shellx-motion-quality-missing-frame-"));
    tempDirs.push(dir);
    const missingPath = join(dir, "000001.png");

    const result = await inspectFrameSequence({
      framePaths: [missingPath],
      minDurationMs: 1000,
      durationMs: 1000
    });

    expect(result).toMatchObject({
      ok: false,
      code: "invalid_frame",
      message: expect.stringContaining(`Unable to read frame ${missingPath}`)
    });
  });

  it("warns when a product video is shorter than the review threshold", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shellx-motion-quality-short-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "000001.png"), CONTRAST_PNG);

    const result = await inspectFrameSequence({
      framePaths: [join(dir, "000001.png")],
      minDurationMs: 1500,
      durationMs: 1000
    });

    // A single-frame sequence really does show one picture for the whole clip, so the freeze
    // measurement reports it alongside the duration warning rather than staying silent about it.
    expect(result).toMatchObject({
      ok: true,
      warnings: [
        "Rendered video is 1000ms; product review clips should be at least 1500ms.",
        expect.stringContaining("Rendered motion is static for 100.0% of its duration")
      ]
    });
  });

  it("fails static frame sequences when unique-frame policy is required", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shellx-motion-quality-static-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "000001.png"), CONTRAST_PNG);
    await writeFile(join(dir, "000002.png"), CONTRAST_PNG);

    const result = await inspectFrameSequence({
      framePaths: [join(dir, "000001.png"), join(dir, "000002.png")],
      durationMs: 1000,
      minUniqueFrameHashes: 2
    });

    expect(result).toMatchObject({
      ok: false,
      code: "static_frames",
      message: "Rendered frame sequence has 1 unique frame; expected at least 2."
    });
  });
});

const CONTRAST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAHdElNRQfqBh4KOQqnS6Y6AAAAEGNhTnYAAAABAAAAAQAAAAAAAAAAmdvqagAAABFJREFUCNdjZGBg+P///38GAA4EA/75rp4uAAAAAElFTkSuQmCC",
  "base64"
);

const BLACK_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAHdElNRQfqBh4KOQqnS6Y6AAAAFElEQVQI12NkYGD4z8DAwMDEAAUADigBA29NMG0AAAAASUVORK5CYII=",
  "base64"
);

const RED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=",
  "base64"
);

const ALPHA_2X2_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGNgYGBg+P///38Q3QAiADBkBH2F9jENAAAAAElFTkSuQmCC",
  "base64"
);

const STRUCTURED_4X2_PNG = rgbaPng(4, 2, [
  [0, 0, 0, 255], [0, 0, 0, 255], [0, 0, 0, 255], [255, 255, 255, 255],
  [0, 0, 0, 255], [0, 0, 0, 255], [0, 0, 0, 255], [255, 255, 255, 255]
]);

function rgbaPng(
  width: number,
  height: number,
  pixels: Array<[number, number, number, number]>,
  options: { interlaceMethod?: number } = {}
): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 4));
  let rawOffset = 0;
  let pixelOffset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[rawOffset] = 0;
    rawOffset += 1;
    for (let x = 0; x < width; x += 1) {
      const pixel = pixels[pixelOffset];
      pixelOffset += 1;
      raw[rawOffset] = pixel[0];
      raw[rawOffset + 1] = pixel[1];
      raw[rawOffset + 2] = pixel[2];
      raw[rawOffset + 3] = pixel[3];
      rawOffset += 4;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = options.interlaceMethod ?? 0;

  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function corruptPngChunkCrc(png: Buffer, wantedType: string): Buffer {
  const corrupted = Buffer.from(png);
  let offset = 8;
  while (offset < corrupted.length) {
    const length = corrupted.readUInt32BE(offset);
    const type = corrupted.subarray(offset + 4, offset + 8).toString("ascii");
    const crcOffset = offset + 8 + length;
    if (type === wantedType) {
      corrupted[crcOffset] ^= 0xff;
      return corrupted;
    }
    offset += 12 + length;
  }
  throw new Error(`PNG chunk not found: ${wantedType}`);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------------------------
// Delivery-profile visual-regression thresholds (mirror of the shipped rich product-pack manifests).
// The quality-manifest gate compares a delivered frame against its pre-encode renderer identity, and
// these are the tolerances a clean SDR-BT.709 encode must clear. Golden encode loss sits well inside
// them (~41.5 dB PSNR / 0.978 SSIM / 1.39 MAE); a genuine content shift must still be rejected.
const DELIVERY_MIN_PSNR_DB = 35;
const DELIVERY_MIN_SSIM = 0.95;
const DELIVERY_MAX_MEAN_DIFF = 3;

/** Build a fine vertical-stripe RGBA frame; `shiftPx` phase-shifts the stripes to emulate a content shift. */
function stripeFrame(size: number, shiftPx: number): Buffer {
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const value = (((x + shiftPx) >> 1) & 1) ? 220 : 30;
      const offset = (y * size + x) * 4;
      rgba[offset] = value;
      rgba[offset + 1] = value;
      rgba[offset + 2] = value;
      rgba[offset + 3] = 255;
    }
  }
  return rgba;
}

describe("visual-regression baseline: shifted frames must fail the delivery profile", () => {
  const SIZE = 64;
  const golden = encodeRgbaPng(SIZE, SIZE, stripeFrame(SIZE, 0));

  it("passes an identical delivered frame within tolerance (clean pre-encode identity)", () => {
    const diff = comparePngBuffers(golden, golden);
    expect(diff.ok).toBe(true);
    if (!diff.ok) return;
    expect(diff.changedPixels).toBe(0);
    expect(diff.meanAbsoluteError).toBe(0);
    expect(diff.ssim).toBeGreaterThanOrEqual(DELIVERY_MIN_SSIM);
    // Identical inputs give infinite PSNR (reported as null); that trivially clears the floor.
    expect(diff.psnrDb).toBeNull();
  });

  it("fails a deliberately shifted delivered frame on PSNR, SSIM and mean-diff", () => {
    const shifted = encodeRgbaPng(SIZE, SIZE, stripeFrame(SIZE, 2));
    const diff = comparePngBuffers(shifted, golden);
    expect(diff.ok).toBe(true);
    if (!diff.ok) return;
    // A two-pixel stripe shift is the synthetic analogue of the one-delivered-frame content gap that
    // used to be compared by mistake. It must breach every gate, not squeak through a widened one.
    expect(diff.meanAbsoluteError).toBeGreaterThan(DELIVERY_MAX_MEAN_DIFF);
    expect(diff.psnrDb).not.toBeNull();
    expect(diff.psnrDb ?? Infinity).toBeLessThan(DELIVERY_MIN_PSNR_DB);
    expect(diff.ssim).toBeLessThan(DELIVERY_MIN_SSIM);
  });

  it("emits a diff image that is black for identical frames and lit where content shifts", () => {
    const clean = buildVisualDiffPng(golden, golden);
    expect(clean.ok).toBe(true);
    if (!clean.ok) return;
    expect(clean.maxChannelDelta).toBe(0);
    const cleanInspected = inspectPngBuffer(clean.png);
    expect(cleanInspected.ok).toBe(true);
    if (cleanInspected.ok) expect(cleanInspected.luma.max).toBe(0); // fully black diff

    const shifted = encodeRgbaPng(SIZE, SIZE, stripeFrame(SIZE, 2));
    const lit = buildVisualDiffPng(shifted, golden);
    expect(lit.ok).toBe(true);
    if (!lit.ok) return;
    expect(lit.maxChannelDelta).toBeGreaterThan(0);
    const litInspected = inspectPngBuffer(lit.png);
    expect(litInspected.ok).toBe(true);
    if (litInspected.ok) expect(litInspected.luma.brightPixels).toBeGreaterThan(0);
  });

  it("rejects mismatched dimensions rather than comparing across sizes", () => {
    const small = encodeRgbaPng(8, 8, stripeFrame(8, 0));
    const diff = buildVisualDiffPng(golden, small);
    expect(diff.ok).toBe(false);
    if (!diff.ok) expect(diff.code).toBe("dimension_mismatch");
  });

  it("round-trips encodeRgbaPng through the PNG decoder", () => {
    const png = encodeRgbaPng(2, 2, Buffer.from([
      255, 0, 0, 255, 0, 255, 0, 255,
      0, 0, 255, 255, 255, 255, 255, 255
    ]));
    const inspected = inspectPngBuffer(png);
    expect(inspected.ok).toBe(true);
    if (inspected.ok) {
      expect(inspected.width).toBe(2);
      expect(inspected.height).toBe(2);
    }
  });
});

/**
 * The quality decoder must refuse a PNG decompression bomb.
 *
 * Every PNG this decoder sees is PACKAGE-CONTROLLED: quality-manifest baselines are named by
 * `template.metadata.qualityTargets.manifest` and resolved out of the package, and the rendered
 * frames it inspects were produced from package input. So both attacker-controlled numbers in a PNG
 * header reach an allocation:
 *
 *   1. the IDAT byte stream, whose inflated size is not bounded by the file's size (zlib reaches
 *      ~1029:1 on a run of zeros, measured on this Node — a 65 KB IDAT inflates to 64 MiB);
 *   2. the IHDR `width`/`height`, two UInt32BE fields that sized `Buffer.alloc(width * height * 4)`
 *      before anything checked them.
 *
 * Each of these tests failed before the fix, and each failed in its own way — which is the point of
 * having both, since either guard alone leaves the other door open:
 *
 *   - the inflate-cap case returned `ok: true`: a 65 KB file made the decoder inflate 64 MiB, read
 *     the first 8 scanlines out of it and report a clean 8x8 frame. A sane-looking header does not
 *     make the stream behind it sane.
 *   - the dimension case never returned at all: with `Buffer.alloc(100000 * 100000 * 4)` Node
 *     attempted a 40 GB allocation (observed as `RangeError: Array buffer allocation failed` under
 *     a 3 GB `ulimit -v`, and as an OOM without one). A tiny IDAT does not make a huge header safe.
 *
 * The bomb fixtures are BUILT HERE from zlib rather than committed as bytes: this repository refuses
 * raw binary in source (`scripts/no-nul-bytes.mjs`), and a bomb is far more legible as the two
 * numbers that make it one than as a base64 blob.
 */
describe("PNG decompression-bomb refusal in the quality decoder", () => {
  it("refuses an IDAT stream that inflates past the frame its own IHDR declares", () => {
    // 8x8 RGBA declares (8 * 4 + 1) * 8 = 264 bytes of filtered scanlines. This IDAT carries 64 MiB
    // of zeros — ~254,000x the declared frame — in ~65 KB on the wire.
    const bomb = decompressionBombPng(8, 8, 64 * 1024 * 1024);
    expect(bomb.length).toBeLessThan(128 * 1024);

    const result = inspectPngBuffer(bomb);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_png");
    expect(result.message).toContain("inflates past");
    expect(result.message).toContain("264 bytes");
  });

  it("refuses IHDR dimensions past the render budget before allocating a pixel buffer", () => {
    // 100000x100000 is the same hostile shape `job-governor.test.ts` pins the frame budget against.
    // The IDAT is deliberately tiny: the refusal must come from the declared dimensions, never from
    // running out of image data after 40 GB has already been reserved for it.
    const oversized = decompressionBombPng(100_000, 100_000, 64);

    const result = inspectPngBuffer(oversized);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_png");
    expect(result.message).toContain("budget");
  });

  it("still decodes an ordinary frame and a full-size FHD delivery frame", () => {
    // The guard must be a bound, not a wall. `CONTRAST_PNG` is an existing fixture (a real
    // libpng-written file with ancillary chunks, not one this suite encoded), and the FHD frame is
    // the size the template proof lane actually renders — 1920x1080 inflates to exactly
    // (1920 * 4 + 1) * 1080 = 8,295,480 bytes, which the cap admits because it IS the cap.
    const ordinary = inspectPngBuffer(CONTRAST_PNG);
    expect(ordinary.ok).toBe(true);

    const fhd = inspectPngBuffer(encodeRgbaPng(1920, 1080, stripeFrame2d(1920, 1080)));
    expect(fhd.ok).toBe(true);
    if (!fhd.ok) return;
    expect(fhd.width).toBe(1920);
    expect(fhd.height).toBe(1080);
    expect(fhd.blank).toBe(false);
  });
});

/**
 * A PNG whose IHDR declares `width`x`height` but whose IDAT inflates to `inflatedBytes` zeros.
 *
 * Zeros are what make it a bomb: zlib's window compresses a long run to its ~1029:1 ceiling, so the
 * file on disk stays small while the inflated buffer does not. The chunks are otherwise fully valid
 * (correct CRCs, colour type 6, bit depth 8, no interlace), so the decoder's existing rejections do
 * not fire first and the test proves the new guard rather than an older one.
 */
function decompressionBombPng(width: number, height: number, inflatedBytes: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type 6: truecolour with alpha
  header[10] = 0; // compression method: deflate
  header[11] = 0; // filter method: adaptive
  header[12] = 0; // interlace method: none

  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.alloc(inflatedBytes), { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

/** Non-blank RGBA content at an arbitrary aspect ratio (the square `stripeFrame` above is square-only). */
function stripeFrame2d(width: number, height: number): Buffer {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = (((x + y) >> 3) & 1) ? 220 : 30;
      const offset = (y * width + x) * 4;
      rgba[offset] = value;
      rgba[offset + 1] = value;
      rgba[offset + 2] = value;
      rgba[offset + 3] = 255;
    }
  }
  return rgba;
}
