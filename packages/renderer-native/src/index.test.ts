import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { inspectPngBuffer, inspectPngRegionBuffer, rendererCapabilityForLane } from "@shellx-motion/core";
import { NATIVE_CAPABILITY, renderNativePreviewFrame } from "./index";

const fixtureRoot = fileURLToPath(new URL("../../../fixtures/packages/lower-third/", import.meta.url));
const keyframedFixtureRoot = fileURLToPath(new URL("../../../fixtures/packages/keyframed-lower-third/", import.meta.url));
const expectedPreviewPath = fileURLToPath(new URL("../../../fixtures/packages/lower-third/expected-preview.json", import.meta.url));
const tempDirs: string[] = [];

interface ExpectedPreview {
  renderer: string;
  atMs: number;
  width: number;
  height: number;
  sha256: string;
}

describe("native preview renderer", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("consumes the native render capability from the single core source (no local drift)", () => {
    // Guards A1: renderer-native must not re-declare its own capability. Its exported
    // NATIVE_CAPABILITY must equal the projection of the core native card.
    expect(NATIVE_CAPABILITY).toEqual(rendererCapabilityForLane("native"));
  });

  it("renders the lower-third fixture as a deterministic PNG frame", async () => {
    const expected = JSON.parse(await readFile(expectedPreviewPath, "utf8")) as ExpectedPreview;
    const outDir = await makeTempDir();
    const outputPath = join(outDir, "frame.png");

    const result = await renderNativePreviewFrame({
      packageRoot: fixtureRoot,
      outputPath,
      atMs: expected.atMs,
      now: () => "2026-06-29T00:00:00.000Z"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(expected.renderer).toBe("@shellx-motion/renderer-native");
    expect(result.frame.width).toBe(expected.width);
    expect(result.frame.height).toBe(expected.height);
    expect(result.frame.sha256).toBe(expected.sha256);
    expect(result.frame.png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(readPngChunkTypes(result.frame.png)).toEqual(["IHDR", "IDAT", "IEND"]);
    const written = await readFile(outputPath);
    expect(written.equals(result.frame.png)).toBe(true);
    expect(result.receipt).toMatchObject({
      schema: "shellx-motion/receipt@1",
      operation: "preview.frame",
      // the text-delivery invariant: the fixture's text is "Anna" in Inter. The native lane case-folds it and ignores
      // the font, so the preview receipt is degraded and names both — it is no longer silent.
      status: "warning",
      lane: "native",
      packageId: "pkg_lower_third",
      createdAt: "2026-06-29T00:00:00.000Z",
      output: {
        path: outputPath,
        sha256: expected.sha256,
        width: expected.width,
        height: expected.height,
        atMs: expected.atMs
      },
      warnings: [
        "Native renderer case-folded lowercase text to uppercase block glyphs on layer title: na.",
        "Native renderer ignored the requested font family 'Inter' on layer title and drew block glyphs instead."
      ]
    });
    expect(result.receipt.inputHashes["manifest.json"]).toHaveLength(64);
    expect(result.receipt.inputHashes["motion.json"]).toHaveLength(64);
  });

  it("rejects native preview output paths outside configured output roots", async () => {
    const outDir = await makeTempDir();

    await expect(
      renderNativePreviewFrame({
        packageRoot: fixtureRoot,
        outputPath: join(outDir, "..", "escaped.png"),
        outputRoots: [outDir],
        atMs: 0
      })
    ).rejects.toThrow(/Native output path must be inside a configured output root/);
  });

  it("rejects oversized native canvases before allocating RGBA memory", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_oversized_canvas",
      width: 100_000,
      height: 100_000,
      layers: [],
    });

    await expect(renderNativePreviewFrame({ packageRoot, atMs: 0 })).rejects.toMatchObject({
      code: "job_input_budget_exceeded",
    });
  });

  it("fails closed for RTL complex-script text instead of emitting misleading block glyphs", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_rtl_complex_text",
      layers: [
        {
          id: "arabic-title",
          type: "text",
          text: "مرحبا بالعالم",
          startMs: 0,
          durationMs: 1000,
          style: { direction: "rtl" }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      code: "unsupported_layer",
      message: "Native renderer cannot render 3 unsupported features across 1 layer.",
      unsupported: [
        {
          layerId: "arabic-title",
          feature: "text.direction",
          reason: "Lane native does not support text.direction on layer arabic-title."
        },
        {
          layerId: "arabic-title",
          feature: "text.shaping.complex",
          reason: "Lane native does not support text.shaping.complex on layer arabic-title."
        },
        // the text-delivery invariant: the charset requirement is reported alongside the shaping requirement, and it
        // is the one that also catches Cyrillic/Greek/CJK/emoji, which shape trivially but have no
        // block glyph at all.
        {
          layerId: "arabic-title",
          feature: "text.charset.non-ascii",
          reason: "Lane native does not support text.charset.non-ascii on layer arabic-title."
        }
      ]
    });
    expect(result.receipt).toMatchObject({
      operation: "preview.frame",
      status: "failed",
      lane: "native",
      output: null,
      warnings: [
        "Lane native does not support text.direction on layer arabic-title.",
        "Lane native does not support text.shaping.complex on layer arabic-title.",
        "Lane native does not support text.charset.non-ascii on layer arabic-title."
      ]
    });
  });

  it("renders shape layers over a solid background", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape",
      background: "#000000",
      layers: [
        {
          id: "box",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 10, y: 12 },
          width: 80,
          height: 40,
          style: { fill: "#ff0000" }
        }
      ]
    });

    const first = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-06-29T00:00:00.000Z" });
    const second = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-06-29T00:00:00.000Z" });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.frame.width).toBe(320);
    expect(first.frame.height).toBe(180);
    expect(first.frame.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.frame.sha256).toBe(second.frame.sha256);
    expect(first.receipt.output).toMatchObject({ width: 320, height: 180, sha256: first.frame.sha256 });
  });

  it("skips invisible layers in native preview frames", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_native_invisible_layer",
      background: "#000000",
      layers: [
        {
          id: "hidden-box",
          type: "shape",
          visible: false,
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 10, y: 12, width: 80, height: 40 },
          style: { fill: "#ffffff" }
        },
        {
          id: "shown-box",
          type: "shape",
          visible: true,
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 110, y: 12, width: 40, height: 40 },
          style: { fill: "#ffffff" }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-03T00:00:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readPngPixel(result.frame.png, 20, 24)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
    expect(readPngPixel(result.frame.png, 120, 24)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
  });

  it("preserves transparent default scene backgrounds for native overlay frames", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_native_transparent_overlay",
      layers: [
        {
          id: "overlay",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 40, y: 48, width: 160, height: 64 },
          style: { fill: "#ffffff" }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T23:40:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const quality = inspectPngBuffer(result.frame.png);
    expect(quality.ok).toBe(true);
    if (!quality.ok) return;
    expect(readPngPixel(result.frame.png, 0, 0)).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(readPngPixel(result.frame.png, 44, 52)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
    expect(quality.transparentPixels).toBeGreaterThan(0);
    expect(quality.nonTransparentPixels).toBeGreaterThan(0);
    expect(result.receipt).toMatchObject({
      operation: "preview.frame",
      status: "passed",
      lane: "native",
      warnings: []
    });
  });

  it("writes compressed PNG IDAT data for native preview frames", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_flat_native_png",
      background: "#000000",
      layers: []
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T08:35:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const idat = readPngChunkData(result.frame.png, "IDAT");
    const rawScanlineBytes = (result.frame.width * 4 + 1) * result.frame.height;
    expect(idat.length).toBeLessThan(rawScanlineBytes);
    expect(inspectPngBuffer(result.frame.png)).toMatchObject({ ok: true, width: 320, height: 180 });
  });

  it("composites package-local PNG image layers into native preview frames", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_image_png",
      background: "#000000",
      layers: [
        {
          id: "logo",
          type: "image",
          source: "assets/logo.png",
          assetRef: "assets/logo.png",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 24, width: 4, height: 4 },
          fit: "fill"
        }
      ]
    });
    await mkdir(join(packageRoot, "assets"), { recursive: true });
    await writeFile(join(packageRoot, "assets", "logo.png"), makeRgbaPngFixture(2, 2, [
      { r: 255, g: 0, b: 0, a: 255 },
      { r: 0, g: 255, b: 0, a: 255 },
      { r: 0, g: 0, b: 255, a: 255 },
      { r: 255, g: 255, b: 255, a: 128 }
    ]));

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T12:40:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);
    expect(readPngPixel(result.frame.png, 20, 24)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(readPngPixel(result.frame.png, 23, 24)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(readPngPixel(result.frame.png, 20, 27)).toEqual({ r: 0, g: 0, b: 255, a: 255 });
    expect(readPngPixel(result.frame.png, 23, 27)).toEqual({ r: 128, g: 128, b: 128, a: 255 });
    expect(readPngPixel(result.frame.png, 19, 24)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
  });

  it("hashes composited image assets into receipt inputHashes and detects a swapped asset", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_image_receipt_hash",
      background: "#000000",
      layers: [
        {
          id: "logo",
          type: "image",
          source: "assets/logo.png",
          assetRef: "assets/logo.png",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 24, width: 4, height: 4 },
          fit: "fill"
        }
      ]
    });
    await mkdir(join(packageRoot, "assets"), { recursive: true });
    const assetPath = join(packageRoot, "assets", "logo.png");
    await writeFile(assetPath, makeRgbaPngFixture(2, 2, [
      { r: 255, g: 0, b: 0, a: 255 },
      { r: 0, g: 255, b: 0, a: 255 },
      { r: 0, g: 0, b: 255, a: 255 },
      { r: 255, g: 255, b: 255, a: 255 }
    ]));

    const first = await renderNativePreviewFrame({ packageRoot, atMs: 0 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // The decoded pixel input is attested, keyed by its package-relative asset path.
    expect(first.receipt.inputHashes["assets/logo.png"]).toMatch(/^[a-f0-9]{64}$/);
    expect(first.receipt.inputHashes["manifest.json"]).toHaveLength(64);
    expect(first.receipt.inputHashes["motion.json"]).toHaveLength(64);
    // Keys are sorted for deterministic receipts regardless of layer iteration order.
    expect(Object.keys(first.receipt.inputHashes)).toEqual(["assets/logo.png", "manifest.json", "motion.json"]);

    // Swap only the image asset bytes; manifest + motion are untouched.
    await writeFile(assetPath, makeRgbaPngFixture(2, 2, [
      { r: 10, g: 20, b: 30, a: 255 },
      { r: 0, g: 255, b: 0, a: 255 },
      { r: 0, g: 0, b: 255, a: 255 },
      { r: 255, g: 255, b: 255, a: 255 }
    ]));

    const second = await renderNativePreviewFrame({ packageRoot, atMs: 0 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    // The swapped pixel input changes its hash; structural hashes are unchanged.
    expect(second.receipt.inputHashes["assets/logo.png"]).not.toBe(first.receipt.inputHashes["assets/logo.png"]);
    expect(second.receipt.inputHashes["manifest.json"]).toBe(first.receipt.inputHashes["manifest.json"]);
    expect(second.receipt.inputHashes["motion.json"]).toBe(first.receipt.inputHashes["motion.json"]);
  });

  it("derives content-addressed receipt ids that are stable for identical content and change on a swapped asset", async () => {
    const buildPackage = async (): Promise<{ packageRoot: string; assetPath: string }> => {
      const packageRoot = await writeMotionPackage({
        id: "motion_image_receipt_id",
        background: "#000000",
        layers: [
          {
            id: "logo",
            type: "image",
            source: "assets/logo.png",
            assetRef: "assets/logo.png",
            startMs: 0,
            durationMs: 1000,
            transform: { x: 20, y: 24, width: 4, height: 4 },
            fit: "fill"
          }
        ]
      });
      await mkdir(join(packageRoot, "assets"), { recursive: true });
      const assetPath = join(packageRoot, "assets", "logo.png");
      await writeFile(assetPath, makeRgbaPngFixture(2, 2, [
        { r: 255, g: 0, b: 0, a: 255 },
        { r: 0, g: 255, b: 0, a: 255 },
        { r: 0, g: 0, b: 255, a: 255 },
        { r: 255, g: 255, b: 255, a: 255 }
      ]));
      return { packageRoot, assetPath };
    };

    const { packageRoot, assetPath } = await buildPackage();

    const first = await renderNativePreviewFrame({ packageRoot, atMs: 0 });
    const firstAgain = await renderNativePreviewFrame({ packageRoot, atMs: 0 });
    expect(first.ok).toBe(true);
    expect(firstAgain.ok).toBe(true);
    if (!first.ok || !firstAgain.ok) return;

    // id-shape stability: content component is 16 lowercase hex chars.
    expect(first.receipt.id).toMatch(/^receipt_native_preview_[a-f0-9]{16}$/);
    // Content-addressed (ffmpeg/browser convention): identical content -> identical id, derived from
    // the output frame hash.
    expect(firstAgain.receipt.id).toBe(first.receipt.id);
    expect(first.receipt.id).toBe(`receipt_native_preview_${first.frame.sha256.slice(0, 16)}`);

    // Swap the asset: a different composited frame must produce a different id without a cross-run collision.
    await writeFile(assetPath, makeRgbaPngFixture(2, 2, [
      { r: 10, g: 20, b: 30, a: 255 },
      { r: 0, g: 255, b: 0, a: 255 },
      { r: 0, g: 0, b: 255, a: 255 },
      { r: 255, g: 255, b: 255, a: 255 }
    ]));
    const swapped = await renderNativePreviewFrame({ packageRoot, atMs: 0 });
    expect(swapped.ok).toBe(true);
    if (!swapped.ok) return;
    expect(swapped.receipt.id).not.toBe(first.receipt.id);
  });

  it("derives deterministic, time-distinguished ids for failure receipts", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_failure_receipt_id",
      layers: [
        {
          id: "arabic-title",
          type: "text",
          text: "مرحبا بالعالم",
          startMs: 0,
          durationMs: 1000,
          style: { direction: "rtl" }
        }
      ]
    });

    const atZero = await renderNativePreviewFrame({ packageRoot, atMs: 0 });
    const atZeroAgain = await renderNativePreviewFrame({ packageRoot, atMs: 0 });
    const atLater = await renderNativePreviewFrame({ packageRoot, atMs: 500 });

    // Failure receipts (output: null) still carry a well-formed content-derived id.
    for (const result of [atZero, atZeroAgain, atLater]) {
      expect(result.ok).toBe(false);
      expect(result.receipt.status).toBe("failed");
      expect(result.receipt.output).toBeNull();
      expect(result.receipt.id).toMatch(/^receipt_native_preview_[a-f0-9]{16}$/);
    }
    // Deterministic for identical inputs; distinguished by frame time.
    expect(atZeroAgain.receipt.id).toBe(atZero.receipt.id);
    expect(atLater.receipt.id).not.toBe(atZero.receipt.id);
  });

  it("rejects oversized PNG asset headers before decompression or RGBA allocation", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_oversized_png_asset",
      layers: [{
        id: "oversized-image",
        type: "image",
        source: "assets/oversized.png",
        startMs: 0,
        durationMs: 1000,
      }],
    });
    await mkdir(join(packageRoot, "assets"), { recursive: true });
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(100_000, 0);
    ihdr.writeUInt32BE(100_000, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    await writeFile(join(packageRoot, "assets", "oversized.png"), Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngFixtureChunk("IHDR", ihdr),
      pngFixtureChunk("IDAT", deflateSync(Buffer.alloc(0))),
      pngFixtureChunk("IEND", Buffer.alloc(0)),
    ]));

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0 });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "render_failed", message: expect.stringContaining("pixel output budget") },
    });
  });

  it("clips native PNG image layers to rounded image radii", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_image_radius",
      background: "#000000",
      layers: [
        {
          id: "rounded-logo",
          type: "image",
          source: "assets/logo.png",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 24, width: 6, height: 6 },
          style: { radius: 3 }
        }
      ]
    });
    await mkdir(join(packageRoot, "assets"), { recursive: true });
    await writeFile(join(packageRoot, "assets", "logo.png"), makeRgbaPngFixture(1, 1, [
      { r: 255, g: 255, b: 255, a: 255 }
    ]));

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T13:00:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readPngPixel(result.frame.png, 20, 24)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
    expect(readPngPixel(result.frame.png, 23, 27)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
  });

  it("defaults native PNG image fit to browser-compatible cover", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_image_default_cover",
      background: "#000000",
      layers: [
        {
          id: "covered-logo",
          type: "image",
          source: "assets/logo.png",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 24, width: 9, height: 3 }
        }
      ]
    });
    await mkdir(join(packageRoot, "assets"), { recursive: true });
    await writeFile(join(packageRoot, "assets", "logo.png"), makeRgbaPngFixture(1, 3, [
      { r: 255, g: 0, b: 0, a: 255 },
      { r: 0, g: 255, b: 0, a: 255 },
      { r: 0, g: 0, b: 255, a: 255 }
    ]));

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T13:35:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readPngPixel(result.frame.png, 20, 24)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(readPngPixel(result.frame.png, 28, 26)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
  });

  it("renders native PNG image style objectFit none without stretching", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_image_object_fit_none",
      background: "#000000",
      layers: [
        {
          id: "natural-size-logo",
          type: "image",
          source: "assets/logo.png",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 24, width: 8, height: 8 },
          style: { objectFit: "none" }
        }
      ]
    });
    await mkdir(join(packageRoot, "assets"), { recursive: true });
    await writeFile(join(packageRoot, "assets", "logo.png"), makeRgbaPngFixture(2, 2, [
      { r: 255, g: 255, b: 255, a: 255 },
      { r: 255, g: 255, b: 255, a: 255 },
      { r: 255, g: 255, b: 255, a: 255 },
      { r: 255, g: 255, b: 255, a: 255 }
    ]));

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T18:40:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readPngPixel(result.frame.png, 20, 24)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
    expect(readPngPixel(result.frame.png, 23, 27)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
    expect(readPngPixel(result.frame.png, 24, 28)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
  });

  it("renders native PNG image style fit scale-down without stretching when source fits", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_image_fit_scale_down",
      background: "#000000",
      layers: [
        {
          id: "scale-down-logo",
          type: "image",
          source: "assets/logo.png",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 24, width: 8, height: 8 },
          style: { fit: "scale-down" }
        }
      ]
    });
    await mkdir(join(packageRoot, "assets"), { recursive: true });
    await writeFile(join(packageRoot, "assets", "logo.png"), makeRgbaPngFixture(2, 2, [
      { r: 255, g: 255, b: 255, a: 255 },
      { r: 255, g: 255, b: 255, a: 255 },
      { r: 255, g: 255, b: 255, a: 255 },
      { r: 255, g: 255, b: 255, a: 255 }
    ]));

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T18:45:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readPngPixel(result.frame.png, 20, 24)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
    expect(readPngPixel(result.frame.png, 23, 27)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
    expect(readPngPixel(result.frame.png, 24, 28)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
  });

  it("renders native PNG image style fit scale-down as contain when source is larger", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_image_fit_scale_down_large",
      background: "#000000",
      layers: [
        {
          id: "large-scale-down-logo",
          type: "image",
          source: "assets/logo.png",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 24, width: 4, height: 4 },
          style: { fit: "scale-down" }
        }
      ]
    });
    await mkdir(join(packageRoot, "assets"), { recursive: true });
    await writeFile(join(packageRoot, "assets", "logo.png"), makeRgbaPngFixture(8, 4, Array.from({ length: 32 }, () => {
      return { r: 255, g: 255, b: 255, a: 255 };
    })));

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T18:50:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readPngPixel(result.frame.png, 20, 24)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
    expect(readPngPixel(result.frame.png, 20, 25)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
    expect(readPngPixel(result.frame.png, 23, 26)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
    expect(readPngPixel(result.frame.png, 20, 27)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
  });

  it("renders native PNG image layers from source crop rectangles", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_image_crop",
      background: "#000000",
      layers: [
        {
          id: "cropped-logo",
          type: "image",
          source: "assets/logo.png",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 24, width: 4, height: 4 },
          fit: "fill",
          crop: { x: 1, y: 0, width: 1, height: 1 }
        }
      ]
    });
    await mkdir(join(packageRoot, "assets"), { recursive: true });
    await writeFile(join(packageRoot, "assets", "logo.png"), makeRgbaPngFixture(3, 1, [
      { r: 255, g: 0, b: 0, a: 255 },
      { r: 0, g: 255, b: 0, a: 255 },
      { r: 0, g: 0, b: 255, a: 255 }
    ]));

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T16:40:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readPngPixel(result.frame.png, 20, 24)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(readPngPixel(result.frame.png, 23, 27)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(readPngPixel(result.frame.png, 19, 24)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
  });

  it("renders native PNG image crop keyframes at capture time", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_image_crop_keyframes",
      background: "#000000",
      layers: [
        {
          id: "cropped-logo",
          type: "image",
          source: "assets/logo.png",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 24, width: 4, height: 4 },
          fit: "fill",
          crop: { x: 0, y: 0, width: 1, height: 1 },
          keyframes: {
            "crop.x": [
              { atMs: 0, value: 0, easing: "linear" },
              { atMs: 500, value: 1 }
            ]
          }
        }
      ]
    });
    await mkdir(join(packageRoot, "assets"), { recursive: true });
    await writeFile(join(packageRoot, "assets", "logo.png"), makeRgbaPngFixture(2, 1, [
      { r: 255, g: 0, b: 0, a: 255 },
      { r: 0, g: 255, b: 0, a: 255 }
    ]));

    const start = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T16:50:00.000Z" });
    const mid = await renderNativePreviewFrame({ packageRoot, atMs: 500, now: () => "2026-07-02T16:50:00.000Z" });

    expect(start.ok).toBe(true);
    expect(mid.ok).toBe(true);
    if (!start.ok || !mid.ok) return;
    expect(readPngPixel(start.frame.png, 20, 24)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(readPngPixel(mid.frame.png, 20, 24)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
  });

  it("renders native PNG image box shadows outside the image box", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_image_shadow",
      background: "#000000",
      layers: [
        {
          id: "shadowed-logo",
          type: "image",
          source: "assets/logo.png",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 24, width: 8, height: 8 },
          style: { shadow: { x: 10, y: 0, blur: 0, spread: 0, color: "#ffffff" } }
        }
      ]
    });
    await mkdir(join(packageRoot, "assets"), { recursive: true });
    await writeFile(join(packageRoot, "assets", "logo.png"), makeRgbaPngFixture(1, 1, [
      { r: 255, g: 0, b: 0, a: 255 }
    ]));

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T13:25:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);
    expect(readPngPixel(result.frame.png, 20, 24)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(readPngPixel(result.frame.png, 30, 24)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
    expect(readPngPixel(result.frame.png, 29, 24)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
    expect(readPngPixel(result.frame.png, 38, 24)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
  });

  it("resolves design token radii for native PNG image clipping", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_image_token_radius",
      background: "#000000",
      designTokens: { radius: { image: 3 } },
      layers: [
        {
          id: "token-rounded-logo",
          type: "image",
          source: "assets/logo.png",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 24, width: 6, height: 6 },
          style: { radius: "{radius.image}" }
        }
      ]
    });
    await mkdir(join(packageRoot, "assets"), { recursive: true });
    await writeFile(join(packageRoot, "assets", "logo.png"), makeRgbaPngFixture(1, 1, [
      { r: 255, g: 255, b: 255, a: 255 }
    ]));

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T13:05:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readPngPixel(result.frame.png, 20, 24)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
    expect(readPngPixel(result.frame.png, 23, 27)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
  });

  it("does not preload inactive PNG image layers for native preview frames", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_inactive_image_png",
      background: "#000000",
      layers: [
        {
          id: "active-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 400,
          transform: { x: 10, y: 10, width: 16, height: 16 },
          style: { fill: "#ff0000" }
        },
        {
          id: "future-logo",
          type: "image",
          source: "assets/missing-future-logo.png",
          startMs: 500,
          durationMs: 500,
          transform: { x: 20, y: 24, width: 4, height: 4 }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T12:45:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readPngPixel(result.frame.png, 12, 12)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
  });

  it("renders shape stroke styles over fill", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape_stroke",
      background: "#000000",
      layers: [
        {
          id: "box",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 20, width: 80, height: 80 },
          style: { fill: "#ffffff", stroke: "#ff0000", width: 8 }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T00:10:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const topStroke = inspectPngRegionBuffer(result.frame.png, { x: 30, y: 22, width: 60, height: 4 });
    const centerFill = inspectPngRegionBuffer(result.frame.png, { x: 52, y: 52, width: 16, height: 16 });
    expect(topStroke.ok).toBe(true);
    expect(centerFill.ok).toBe(true);
    if (!topStroke.ok || !centerFill.ok) return;
    expect(topStroke.luma.darkPixels).toBeGreaterThan(0);
    expect(topStroke.luma.brightPixels).toBe(0);
    expect(centerFill.luma.brightPixels).toBeGreaterThan(0);
    expect(centerFill.luma.darkPixels).toBe(0);
  });

  it("renders native outline color keyframes for shape strokes and text borders", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_outline_color_keyframes",
      background: "#000000",
      layers: [
        {
          id: "outlined-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 20, y: 20, width: 40, height: 40 },
          style: { fill: "#000000", stroke: "#ff0000", width: 4 },
          keyframes: {
            "style.stroke": [
              { atMs: 0, value: "#ff0000" },
              { atMs: 1000, value: "#00ff00" }
            ]
          }
        },
        {
          id: "bordered-title",
          type: "text",
          text: "I",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 80, y: 20, width: 48, height: 48 },
          style: { backgroundColor: "#000000", color: "#000000", borderColor: "#ff0000", borderWidth: 4, padding: 8 },
          keyframes: {
            "style.borderColor": [
              { atMs: 0, value: "#ff0000" },
              { atMs: 1000, value: "#00ff00" }
            ]
          }
        }
      ]
    });

    const start = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T14:15:00.000Z" });
    const end = await renderNativePreviewFrame({ packageRoot, atMs: 1000, now: () => "2026-07-02T14:15:00.000Z" });

    expect(start.ok).toBe(true);
    expect(end.ok).toBe(true);
    if (!start.ok || !end.ok) return;
    expect(readPngPixel(start.frame.png, 22, 20)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(readPngPixel(end.frame.png, 22, 20)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(readPngPixel(start.frame.png, 84, 20)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(readPngPixel(end.frame.png, 84, 20)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
  });

  it("renders native outline width keyframes for shape strokes and text borders", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_outline_width_keyframes",
      background: "#000000",
      layers: [
        {
          id: "outlined-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 20, y: 20, width: 40, height: 40 },
          style: { fill: "#000000", stroke: "#ffffff", strokeWidth: 2 },
          keyframes: {
            "style.strokeWidth": [
              { atMs: 0, value: 2 },
              { atMs: 1000, value: 8 }
            ]
          }
        },
        {
          id: "bordered-title",
          type: "text",
          text: "I",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 80, y: 20, width: 48, height: 48 },
          style: { backgroundColor: "#000000", color: "#000000", borderColor: "#ffffff", borderWidth: 2, padding: 8 },
          keyframes: {
            "style.borderWidth": [
              { atMs: 0, value: 2 },
              { atMs: 1000, value: 8 }
            ]
          }
        }
      ]
    });

    const start = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T14:25:00.000Z" });
    const end = await renderNativePreviewFrame({ packageRoot, atMs: 1000, now: () => "2026-07-02T14:25:00.000Z" });

    expect(start.ok).toBe(true);
    expect(end.ok).toBe(true);
    if (!start.ok || !end.ok) return;
    expect(readPngPixel(start.frame.png, 22, 23)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
    expect(readPngPixel(end.frame.png, 22, 23)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
    expect(readPngPixel(start.frame.png, 84, 23)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
    expect(readPngPixel(end.frame.png, 84, 23)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
  });

  it("renders native text background color keyframes", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_text_background_color_keyframes",
      background: "#000000",
      layers: [
        {
          id: "badge",
          type: "text",
          text: "I",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 20, y: 20, width: 64, height: 48 },
          style: { backgroundColor: "#ff0000", color: "#000000", borderWidth: 0, padding: 8 },
          keyframes: {
            "style.backgroundColor": [
              { atMs: 0, value: "#ff0000" },
              { atMs: 1000, value: "#00ff00" }
            ]
          }
        }
      ]
    });

    const start = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T14:35:00.000Z" });
    const end = await renderNativePreviewFrame({ packageRoot, atMs: 1000, now: () => "2026-07-02T14:35:00.000Z" });

    expect(start.ok).toBe(true);
    expect(end.ok).toBe(true);
    if (!start.ok || !end.ok) return;
    expect(readPngPixel(start.frame.png, 24, 24)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(readPngPixel(end.frame.png, 24, 24)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
  });

  it("renders native text background alias keyframes", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_text_background_alias_keyframes",
      background: "#000000",
      layers: [
        {
          id: "badge",
          type: "text",
          text: "I",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 20, y: 20, width: 64, height: 48 },
          style: { background: "#ff0000", color: "#000000", borderWidth: 0, padding: 8 },
          keyframes: {
            "style.background": [
              { atMs: 0, value: "#ff0000" },
              { atMs: 1000, value: "#00ff00" }
            ]
          }
        }
      ]
    });

    const start = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T15:50:00.000Z" });
    const end = await renderNativePreviewFrame({ packageRoot, atMs: 1000, now: () => "2026-07-02T15:50:00.000Z" });

    expect(start.ok).toBe(true);
    expect(end.ok).toBe(true);
    if (!start.ok || !end.ok) return;
    expect(readPngPixel(start.frame.png, 24, 24)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(readPngPixel(end.frame.png, 24, 24)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
  });

  it("renders native shape shadows behind card surfaces", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape_shadow",
      background: "#000000",
      layers: [
        {
          id: "shadow-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 20, width: 80, height: 60 },
          style: { fill: "#111111", shadow: { x: 16, y: 0, blur: 0, spread: 0, color: "#ffffff" } }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T10:20:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const fillRegion = inspectPngRegionBuffer(result.frame.png, { x: 30, y: 30, width: 50, height: 40 });
    const shadowRegion = inspectPngRegionBuffer(result.frame.png, { x: 104, y: 30, width: 10, height: 40 });
    const outsideRegion = inspectPngRegionBuffer(result.frame.png, { x: 118, y: 30, width: 10, height: 40 });
    expect(fillRegion.ok).toBe(true);
    expect(shadowRegion.ok).toBe(true);
    expect(outsideRegion.ok).toBe(true);
    if (!fillRegion.ok || !shadowRegion.ok || !outsideRegion.ok) return;
    expect(fillRegion.luma.darkPixels).toBeGreaterThan(1800);
    expect(fillRegion.luma.brightPixels).toBe(0);
    expect(shadowRegion.luma.brightPixels).toBeGreaterThan(350);
    expect(shadowRegion.luma.darkPixels).toBe(0);
    expect(outsideRegion.luma.darkPixels).toBeGreaterThan(350);
    expect(outsideRegion.luma.brightPixels).toBe(0);
    expect(result.receipt).toMatchObject({
      operation: "preview.frame",
      status: "passed",
      warnings: []
    });
  });

  it("renders native shadow offset keyframes at capture time", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape_shadow_keyframes",
      background: "#000000",
      layers: [
        {
          id: "animated-shadow-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 20, y: 20, width: 80, height: 60 },
          style: { fill: "#111111", shadow: { x: 0, y: 0, blur: 0, color: "#ffffff" } },
          keyframes: {
            "style.shadow.x": [
              { atMs: 0, value: 0, easing: "linear" },
              { atMs: 1000, value: 16 }
            ]
          }
        }
      ]
    });

    const start = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T10:25:00.000Z" });
    const end = await renderNativePreviewFrame({ packageRoot, atMs: 1000, now: () => "2026-07-02T10:25:00.000Z" });

    expect(start.ok).toBe(true);
    expect(end.ok).toBe(true);
    if (!start.ok || !end.ok) return;
    expect(start.frame.sha256).not.toBe(end.frame.sha256);
    const startShadowRegion = inspectPngRegionBuffer(start.frame.png, { x: 104, y: 30, width: 10, height: 40 });
    const endShadowRegion = inspectPngRegionBuffer(end.frame.png, { x: 104, y: 30, width: 10, height: 40 });
    expect(startShadowRegion.ok).toBe(true);
    expect(endShadowRegion.ok).toBe(true);
    if (!startShadowRegion.ok || !endShadowRegion.ok) return;
    expect(startShadowRegion.luma.brightPixels).toBe(0);
    expect(startShadowRegion.luma.darkPixels).toBeGreaterThan(350);
    expect(endShadowRegion.luma.brightPixels).toBeGreaterThan(350);
    expect(endShadowRegion.luma.darkPixels).toBe(0);
  });

  it("renders native shape shadow alias keyframes", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape_shadow_alias_keyframes",
      background: "#000000",
      layers: [
        {
          id: "offset-shadow-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 20, y: 20, width: 80, height: 60 },
          style: { fill: "#111111", shadow: { offsetX: 0, offsetY: 0, blurRadius: 0, color: "#ffffff" } },
          keyframes: {
            "style.shadow.offsetX": [
              { atMs: 0, value: 0, easing: "linear" },
              { atMs: 1000, value: 16 }
            ]
          }
        },
        {
          id: "spread-shadow-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 20, y: 92, width: 4, height: 4 },
          style: { fill: "#000000", shadow: { offsetX: 10, offsetY: 0, blurRadius: 0, spreadRadius: 0, color: "#00ff00" } },
          keyframes: {
            "style.shadow.spreadRadius": [
              { atMs: 0, value: 0 },
              { atMs: 1000, value: 2 }
            ]
          }
        },
        {
          id: "blur-shadow-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 20, y: 116, width: 4, height: 4 },
          style: { fill: "#000000", shadow: { offsetX: 10, offsetY: 0, blurRadius: 0, spreadRadius: 0, color: "#00ff00" } },
          keyframes: {
            "style.shadow.blurRadius": [
              { atMs: 0, value: 0 },
              { atMs: 1000, value: 4 }
            ]
          }
        }
      ]
    });

    const start = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T16:25:00.000Z" });
    const end = await renderNativePreviewFrame({ packageRoot, atMs: 1000, now: () => "2026-07-02T16:25:00.000Z" });

    expect(start.ok).toBe(true);
    expect(end.ok).toBe(true);
    if (!start.ok || !end.ok) return;
    expect(start.frame.sha256).not.toBe(end.frame.sha256);
    const startOffsetRegion = inspectPngRegionBuffer(start.frame.png, { x: 104, y: 30, width: 10, height: 40 });
    const endOffsetRegion = inspectPngRegionBuffer(end.frame.png, { x: 104, y: 30, width: 10, height: 40 });
    expect(startOffsetRegion.ok).toBe(true);
    expect(endOffsetRegion.ok).toBe(true);
    if (!startOffsetRegion.ok || !endOffsetRegion.ok) return;
    expect(startOffsetRegion.luma.brightPixels).toBe(0);
    expect(endOffsetRegion.luma.brightPixels).toBeGreaterThan(350);
    expect(readPngPixel(start.frame.png, 28, 92)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
    expect(readPngPixel(end.frame.png, 28, 92)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(readPngPixel(start.frame.png, 27, 116)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
    expect(readPngPixel(end.frame.png, 27, 116).g).toBeGreaterThan(0);
  });

  it("renders native shape shadow color, spread, and blur keyframes", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape_shadow_component_keyframes",
      background: "#000000",
      layers: [
        {
          id: "spread-shadow-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 20, y: 20, width: 4, height: 4 },
          style: { fill: "#000000", shadow: { x: 10, y: 0, blur: 0, spread: 0, color: "#ff0000" } },
          keyframes: {
            "style.shadow.color": [
              { atMs: 0, value: "#ff0000" },
              { atMs: 1000, value: "#00ff00" }
            ],
            "style.shadow.spread": [
              { atMs: 0, value: 0 },
              { atMs: 1000, value: 2 }
            ]
          }
        },
        {
          id: "blur-shadow-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 20, y: 44, width: 4, height: 4 },
          style: { fill: "#000000", shadow: { x: 10, y: 0, blur: 0, spread: 0, color: "#00ff00" } },
          keyframes: {
            "style.shadow.blur": [
              { atMs: 0, value: 0 },
              { atMs: 1000, value: 4 }
            ]
          }
        }
      ]
    });

    const start = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T14:00:00.000Z" });
    const end = await renderNativePreviewFrame({ packageRoot, atMs: 1000, now: () => "2026-07-02T14:00:00.000Z" });

    expect(start.ok).toBe(true);
    expect(end.ok).toBe(true);
    if (!start.ok || !end.ok) return;
    expect(readPngPixel(start.frame.png, 30, 20)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(readPngPixel(start.frame.png, 28, 20)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
    expect(readPngPixel(end.frame.png, 30, 20)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(readPngPixel(end.frame.png, 28, 20)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(readPngPixel(start.frame.png, 27, 44)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
    expect(readPngPixel(end.frame.png, 27, 44).g).toBeGreaterThan(0);
  });

  it("renders native text shadows behind glyphs", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_text_shadow",
      background: "#000000",
      layers: [
        {
          id: "shadow-title",
          type: "text",
          text: "H",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 20 },
          style: { color: "#111111", fontSize: 28, textShadow: { x: 24, y: 0, blur: 0, color: "#ffffff" } }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T11:50:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const shadowRegion = inspectPngRegionBuffer(result.frame.png, { x: 45, y: 20, width: 16, height: 28 });
    const outsideRegion = inspectPngRegionBuffer(result.frame.png, { x: 68, y: 20, width: 12, height: 28 });
    expect(shadowRegion.ok).toBe(true);
    expect(outsideRegion.ok).toBe(true);
    if (!shadowRegion.ok || !outsideRegion.ok) return;
    expect(shadowRegion.luma.brightPixels).toBeGreaterThan(120);
    expect(shadowRegion.luma.darkPixels).toBeLessThan(320);
    expect(outsideRegion.luma.brightPixels).toBe(0);
    expect(outsideRegion.luma.darkPixels).toBeGreaterThan(300);
    expect(result.receipt).toMatchObject({
      operation: "preview.frame",
      status: "passed",
      warnings: []
    });
  });

  it("renders native text shadow offset keyframes at capture time", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_text_shadow_keyframes",
      background: "#000000",
      layers: [
        {
          id: "animated-shadow-title",
          type: "text",
          text: "H",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 20, y: 20 },
          style: { color: "#111111", fontSize: 28, textShadow: { x: 0, y: 0, blur: 0, color: "#ffffff" } },
          keyframes: {
            "style.textShadow.x": [
              { atMs: 0, value: 0, easing: "linear" },
              { atMs: 1000, value: 24 }
            ]
          }
        }
      ]
    });

    const start = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T11:55:00.000Z" });
    const end = await renderNativePreviewFrame({ packageRoot, atMs: 1000, now: () => "2026-07-02T11:55:00.000Z" });

    expect(start.ok).toBe(true);
    expect(end.ok).toBe(true);
    if (!start.ok || !end.ok) return;
    expect(start.frame.sha256).not.toBe(end.frame.sha256);
    const startShadowRegion = inspectPngRegionBuffer(start.frame.png, { x: 45, y: 20, width: 16, height: 28 });
    const endShadowRegion = inspectPngRegionBuffer(end.frame.png, { x: 45, y: 20, width: 16, height: 28 });
    expect(startShadowRegion.ok).toBe(true);
    expect(endShadowRegion.ok).toBe(true);
    if (!startShadowRegion.ok || !endShadowRegion.ok) return;
    expect(startShadowRegion.luma.brightPixels).toBe(0);
    expect(startShadowRegion.luma.darkPixels).toBeGreaterThan(400);
    expect(endShadowRegion.luma.brightPixels).toBeGreaterThan(120);
    expect(endShadowRegion.luma.darkPixels).toBeLessThan(320);
  });

  it("renders native text shadow alias keyframes at capture time", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_text_shadow_alias_keyframes",
      background: "#000000",
      layers: [
        {
          id: "animated-shadow-title",
          type: "text",
          text: "H",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 20, y: 20 },
          style: { color: "#111111", fontSize: 28, textShadow: { offsetX: 0, offsetY: 0, blurRadius: 0, color: "#ffffff" } },
          keyframes: {
            "style.textShadow.offsetX": [
              { atMs: 0, value: 0, easing: "linear" },
              { atMs: 1000, value: 24 }
            ]
          }
        }
      ]
    });

    const start = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T12:10:00.000Z" });
    const end = await renderNativePreviewFrame({ packageRoot, atMs: 1000, now: () => "2026-07-02T12:10:00.000Z" });

    expect(start.ok).toBe(true);
    expect(end.ok).toBe(true);
    if (!start.ok || !end.ok) return;
    expect(start.frame.sha256).not.toBe(end.frame.sha256);
    const startShadowRegion = inspectPngRegionBuffer(start.frame.png, { x: 45, y: 20, width: 16, height: 28 });
    const endShadowRegion = inspectPngRegionBuffer(end.frame.png, { x: 45, y: 20, width: 16, height: 28 });
    expect(startShadowRegion.ok).toBe(true);
    expect(endShadowRegion.ok).toBe(true);
    if (!startShadowRegion.ok || !endShadowRegion.ok) return;
    expect(startShadowRegion.luma.brightPixels).toBe(0);
    expect(startShadowRegion.luma.darkPixels).toBeGreaterThan(400);
    expect(endShadowRegion.luma.brightPixels).toBeGreaterThan(120);
    expect(endShadowRegion.luma.darkPixels).toBeLessThan(320);
  });

  it("renders native rectangular masks for shape layers", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape_rect_mask",
      background: "#000000",
      layers: [
        {
          id: "masked-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 20, width: 120, height: 60 },
          style: { fill: "#ffffff" },
          mask: { type: "rect", inset: { top: 0, right: 60, bottom: 0, left: 0 } }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T10:40:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const visibleRegion = inspectPngRegionBuffer(result.frame.png, { x: 30, y: 30, width: 40, height: 40 });
    const clippedRegion = inspectPngRegionBuffer(result.frame.png, { x: 90, y: 30, width: 40, height: 40 });
    expect(visibleRegion.ok).toBe(true);
    expect(clippedRegion.ok).toBe(true);
    if (!visibleRegion.ok || !clippedRegion.ok) return;
    expect(visibleRegion.luma.brightPixels).toBeGreaterThan(1500);
    expect(visibleRegion.luma.darkPixels).toBe(0);
    expect(clippedRegion.luma.brightPixels).toBe(0);
    expect(clippedRegion.luma.darkPixels).toBeGreaterThan(1500);
    expect(result.receipt).toMatchObject({
      operation: "preview.frame",
      status: "passed",
      warnings: []
    });
  });

  it("renders native rounded-rect masks for shape layers", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape_rounded_rect_mask",
      background: "#000000",
      layers: [
        {
          id: "rounded-mask-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 20, width: 80, height: 80 },
          style: { fill: "#ffffff" },
          mask: { type: "rounded-rect", radius: 40 }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T18:35:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const clippedCorner = inspectPngRegionBuffer(result.frame.png, { x: 20, y: 20, width: 10, height: 10 });
    const visibleCenter = inspectPngRegionBuffer(result.frame.png, { x: 52, y: 52, width: 16, height: 16 });
    expect(clippedCorner.ok).toBe(true);
    expect(visibleCenter.ok).toBe(true);
    if (!clippedCorner.ok || !visibleCenter.ok) return;
    expect(clippedCorner.luma.brightPixels).toBe(0);
    expect(clippedCorner.luma.darkPixels).toBeGreaterThan(90);
    expect(visibleCenter.luma.brightPixels).toBeGreaterThan(240);
    expect(visibleCenter.luma.darkPixels).toBe(0);
    expect(result.receipt).toMatchObject({
      operation: "preview.frame",
      status: "passed",
      warnings: []
    });
  });

  it("renders native rectangular mask inset keyframes for shape layers", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape_rect_mask_keyframes",
      background: "#000000",
      layers: [
        {
          id: "masked-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 20, width: 120, height: 60 },
          style: { fill: "#ffffff" },
          mask: { type: "rect", inset: { top: 0, right: 0, bottom: 0, left: 80 } },
          keyframes: {
            "mask.inset.left": [
              { atMs: 0, value: 80, easing: "linear" },
              { atMs: 1000, value: 0 }
            ]
          }
        }
      ]
    });

    const start = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T10:42:00.000Z" });
    const mid = await renderNativePreviewFrame({ packageRoot, atMs: 500, now: () => "2026-07-02T10:42:00.000Z" });

    expect(start.ok).toBe(true);
    expect(mid.ok).toBe(true);
    if (!start.ok || !mid.ok) return;
    expect(start.frame.sha256).not.toBe(mid.frame.sha256);
    const startLeft = inspectPngRegionBuffer(start.frame.png, { x: 65, y: 30, width: 25, height: 40 });
    const midLeft = inspectPngRegionBuffer(mid.frame.png, { x: 65, y: 30, width: 25, height: 40 });
    expect(startLeft.ok).toBe(true);
    expect(midLeft.ok).toBe(true);
    if (!startLeft.ok || !midLeft.ok) return;
    expect(startLeft.luma.brightPixels).toBe(0);
    expect(startLeft.luma.darkPixels).toBeGreaterThan(900);
    expect(midLeft.luma.brightPixels).toBeGreaterThan(900);
    expect(midLeft.luma.darkPixels).toBe(0);
  });

  it("renders native fade-in transitions for shape layers", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape_fade_in",
      background: "#000000",
      layers: [
        {
          id: "fade-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1600,
          transform: { x: 20, y: 20, width: 120, height: 60 },
          style: { fill: "#ffffff" },
          transitions: { in: { type: "fade", durationMs: 1000, easing: "linear" } }
        }
      ]
    });

    const start = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T11:30:00.000Z" });
    const mid = await renderNativePreviewFrame({ packageRoot, atMs: 500, now: () => "2026-07-02T11:30:00.000Z" });
    const end = await renderNativePreviewFrame({ packageRoot, atMs: 1000, now: () => "2026-07-02T11:30:00.000Z" });

    expect(start.ok).toBe(true);
    expect(mid.ok).toBe(true);
    expect(end.ok).toBe(true);
    if (!start.ok || !mid.ok || !end.ok) return;
    const startRegion = inspectPngRegionBuffer(start.frame.png, { x: 30, y: 30, width: 100, height: 40 });
    const midRegion = inspectPngRegionBuffer(mid.frame.png, { x: 30, y: 30, width: 100, height: 40 });
    const endRegion = inspectPngRegionBuffer(end.frame.png, { x: 30, y: 30, width: 100, height: 40 });
    expect(startRegion.ok).toBe(true);
    expect(midRegion.ok).toBe(true);
    expect(endRegion.ok).toBe(true);
    if (!startRegion.ok || !midRegion.ok || !endRegion.ok) return;
    expect(startRegion.luma.avg).toBeLessThan(8);
    expect(startRegion.luma.brightPixels).toBe(0);
    expect(midRegion.luma.avg).toBeGreaterThan(90);
    expect(midRegion.luma.avg).toBeLessThan(170);
    expect(midRegion.luma.brightPixels).toBe(0);
    expect(endRegion.luma.brightPixels).toBeGreaterThan(3900);
    expect(start.frame.sha256).not.toBe(mid.frame.sha256);
    expect(mid.frame.sha256).not.toBe(end.frame.sha256);
  });

  it("renders native slide-in transitions for shape layers", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape_slide_in",
      background: "#000000",
      layers: [
        {
          id: "slide-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1600,
          transform: { x: 80, y: 20, width: 60, height: 60 },
          style: { fill: "#ffffff" },
          transitions: { in: { type: "slide", direction: "left", distance: 60, durationMs: 1000, easing: "linear" } }
        }
      ]
    });

    const start = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T11:35:00.000Z" });
    const mid = await renderNativePreviewFrame({ packageRoot, atMs: 500, now: () => "2026-07-02T11:35:00.000Z" });
    const end = await renderNativePreviewFrame({ packageRoot, atMs: 1000, now: () => "2026-07-02T11:35:00.000Z" });

    expect(start.ok).toBe(true);
    expect(mid.ok).toBe(true);
    expect(end.ok).toBe(true);
    if (!start.ok || !mid.ok || !end.ok) return;
    const targetStart = inspectPngRegionBuffer(start.frame.png, { x: 85, y: 30, width: 45, height: 40 });
    const midLeft = inspectPngRegionBuffer(mid.frame.png, { x: 55, y: 30, width: 20, height: 40 });
    const midTarget = inspectPngRegionBuffer(mid.frame.png, { x: 85, y: 30, width: 45, height: 40 });
    const endTarget = inspectPngRegionBuffer(end.frame.png, { x: 85, y: 30, width: 45, height: 40 });
    expect(targetStart.ok).toBe(true);
    expect(midLeft.ok).toBe(true);
    expect(midTarget.ok).toBe(true);
    expect(endTarget.ok).toBe(true);
    if (!targetStart.ok || !midLeft.ok || !midTarget.ok || !endTarget.ok) return;
    expect(targetStart.luma.brightPixels).toBe(0);
    expect(midLeft.luma.brightPixels).toBeGreaterThan(700);
    expect(midTarget.luma.brightPixels).toBeGreaterThan(700);
    expect(midTarget.luma.brightPixels).toBeLessThan(1800);
    expect(endTarget.luma.brightPixels).toBeGreaterThan(1700);
    expect(start.frame.sha256).not.toBe(mid.frame.sha256);
    expect(mid.frame.sha256).not.toBe(end.frame.sha256);
  });

  it("renders native wipe-in transitions for shape layers", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape_wipe_in",
      background: "#000000",
      layers: [
        {
          id: "wipe-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1600,
          transform: { x: 20, y: 20, width: 120, height: 60 },
          style: { fill: "#ffffff" },
          transitions: { in: { type: "wipe", direction: "left", durationMs: 1000, easing: "linear" } }
        }
      ]
    });

    const start = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T11:00:00.000Z" });
    const mid = await renderNativePreviewFrame({ packageRoot, atMs: 500, now: () => "2026-07-02T11:00:00.000Z" });
    const end = await renderNativePreviewFrame({ packageRoot, atMs: 1000, now: () => "2026-07-02T11:00:00.000Z" });

    expect(start.ok).toBe(true);
    expect(mid.ok).toBe(true);
    expect(end.ok).toBe(true);
    if (!start.ok || !mid.ok || !end.ok) return;
    const startRegion = inspectPngRegionBuffer(start.frame.png, { x: 30, y: 30, width: 100, height: 40 });
    const midVisibleRegion = inspectPngRegionBuffer(mid.frame.png, { x: 30, y: 30, width: 40, height: 40 });
    const midHiddenRegion = inspectPngRegionBuffer(mid.frame.png, { x: 100, y: 30, width: 30, height: 40 });
    const endRegion = inspectPngRegionBuffer(end.frame.png, { x: 30, y: 30, width: 100, height: 40 });
    expect(startRegion.ok).toBe(true);
    expect(midVisibleRegion.ok).toBe(true);
    expect(midHiddenRegion.ok).toBe(true);
    expect(endRegion.ok).toBe(true);
    if (!startRegion.ok || !midVisibleRegion.ok || !midHiddenRegion.ok || !endRegion.ok) return;
    expect(startRegion.luma.brightPixels).toBe(0);
    expect(startRegion.luma.darkPixels).toBeGreaterThan(3900);
    expect(midVisibleRegion.luma.brightPixels).toBeGreaterThan(1500);
    expect(midHiddenRegion.luma.brightPixels).toBe(0);
    expect(midHiddenRegion.luma.darkPixels).toBeGreaterThan(1100);
    expect(endRegion.luma.brightPixels).toBeGreaterThan(3900);
    expect(start.frame.sha256).not.toBe(mid.frame.sha256);
    expect(mid.frame.sha256).not.toBe(end.frame.sha256);
  });

  it("renders native wipe-out transitions for shape layers", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape_wipe_out",
      background: "#000000",
      layers: [
        {
          id: "wipe-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 20, width: 120, height: 60 },
          style: { fill: "#ffffff" },
          transitions: { out: { type: "wipe", direction: "left", durationMs: 400, easing: "linear" } }
        }
      ]
    });

    const beforeOut = await renderNativePreviewFrame({ packageRoot, atMs: 500, now: () => "2026-07-02T11:05:00.000Z" });
    const duringOut = await renderNativePreviewFrame({ packageRoot, atMs: 800, now: () => "2026-07-02T11:05:00.000Z" });

    expect(beforeOut.ok).toBe(true);
    expect(duringOut.ok).toBe(true);
    if (!beforeOut.ok || !duringOut.ok) return;
    const fullRegion = inspectPngRegionBuffer(beforeOut.frame.png, { x: 30, y: 30, width: 100, height: 40 });
    const hiddenLeft = inspectPngRegionBuffer(duringOut.frame.png, { x: 30, y: 30, width: 25, height: 40 });
    const visibleRight = inspectPngRegionBuffer(duringOut.frame.png, { x: 90, y: 30, width: 40, height: 40 });
    expect(fullRegion.ok).toBe(true);
    expect(hiddenLeft.ok).toBe(true);
    expect(visibleRight.ok).toBe(true);
    if (!fullRegion.ok || !hiddenLeft.ok || !visibleRight.ok) return;
    expect(fullRegion.luma.brightPixels).toBeGreaterThan(3900);
    expect(hiddenLeft.luma.brightPixels).toBe(0);
    expect(hiddenLeft.luma.darkPixels).toBeGreaterThan(900);
    expect(visibleRight.luma.brightPixels).toBeGreaterThan(1500);
    expect(beforeOut.frame.sha256).not.toBe(duringOut.frame.sha256);
  });

  it("renders native shape rotation around explicit transform origins", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape_rotation",
      background: "#000000",
      layers: [
        {
          id: "rotated-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 70, y: 50, width: 80, height: 20, originX: 0, originY: 0, rotation: 90 },
          style: { fill: "#ffffff" }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T12:05:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rotatedOnly = inspectPngRegionBuffer(result.frame.png, { x: 52, y: 78, width: 16, height: 40 });
    const unrotatedOnly = inspectPngRegionBuffer(result.frame.png, { x: 92, y: 54, width: 36, height: 12 });
    expect(rotatedOnly.ok).toBe(true);
    expect(unrotatedOnly.ok).toBe(true);
    if (!rotatedOnly.ok || !unrotatedOnly.ok) return;
    expect(rotatedOnly.luma.brightPixels).toBeGreaterThan(580);
    expect(rotatedOnly.luma.darkPixels).toBeLessThan(70);
    expect(unrotatedOnly.luma.brightPixels).toBe(0);
    expect(unrotatedOnly.luma.darkPixels).toBeGreaterThan(400);
    expect(result.receipt).toMatchObject({
      operation: "preview.frame",
      status: "passed",
      warnings: []
    });
  });

  it("renders native rotation keyframes at capture time", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape_rotation_keyframes",
      background: "#000000",
      layers: [
        {
          id: "animated-rotation-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 70, y: 50, width: 80, height: 20, originX: 0, originY: 0, rotation: 0 },
          style: { fill: "#ffffff" },
          keyframes: {
            "transform.rotation": [
              { atMs: 0, value: 0, easing: "linear" },
              { atMs: 1000, value: 90 }
            ]
          }
        }
      ]
    });

    const start = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T12:10:00.000Z" });
    const end = await renderNativePreviewFrame({ packageRoot, atMs: 1000, now: () => "2026-07-02T12:10:00.000Z" });

    expect(start.ok).toBe(true);
    expect(end.ok).toBe(true);
    if (!start.ok || !end.ok) return;
    expect(start.frame.sha256).not.toBe(end.frame.sha256);
    const startHorizontal = inspectPngRegionBuffer(start.frame.png, { x: 92, y: 54, width: 36, height: 12 });
    const startVertical = inspectPngRegionBuffer(start.frame.png, { x: 52, y: 78, width: 16, height: 40 });
    const endHorizontal = inspectPngRegionBuffer(end.frame.png, { x: 92, y: 54, width: 36, height: 12 });
    const endVertical = inspectPngRegionBuffer(end.frame.png, { x: 52, y: 78, width: 16, height: 40 });
    expect(startHorizontal.ok).toBe(true);
    expect(startVertical.ok).toBe(true);
    expect(endHorizontal.ok).toBe(true);
    expect(endVertical.ok).toBe(true);
    if (!startHorizontal.ok || !startVertical.ok || !endHorizontal.ok || !endVertical.ok) return;
    expect(startHorizontal.luma.brightPixels).toBeGreaterThan(400);
    expect(startVertical.luma.brightPixels).toBe(0);
    expect(endHorizontal.luma.brightPixels).toBe(0);
    expect(endVertical.luma.brightPixels).toBeGreaterThan(580);
  });

  it("renders native blur effects as layer post-processing", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape_blur",
      background: "#000000",
      layers: [
        {
          id: "blurred-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 60, y: 50, width: 60, height: 60 },
          style: { fill: "#ffffff" },
          effects: { blur: 8 }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T12:20:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const center = inspectPngRegionBuffer(result.frame.png, { x: 78, y: 68, width: 24, height: 24 });
    const spill = inspectPngRegionBuffer(result.frame.png, { x: 122, y: 64, width: 8, height: 32 });
    const outside = inspectPngRegionBuffer(result.frame.png, { x: 142, y: 64, width: 8, height: 32 });
    expect(center.ok).toBe(true);
    expect(spill.ok).toBe(true);
    expect(outside.ok).toBe(true);
    if (!center.ok || !spill.ok || !outside.ok) return;
    expect(center.luma.brightPixels).toBeGreaterThan(500);
    expect(spill.luma.avg).toBeGreaterThan(15);
    expect(spill.luma.avg).toBeGreaterThan(outside.luma.avg + 10);
    expect(outside.luma.brightPixels).toBe(0);
    expect(result.receipt).toMatchObject({
      operation: "preview.frame",
      status: "passed",
      warnings: []
    });
  });

  it("renders native blur keyframes at capture time", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape_blur_keyframes",
      background: "#000000",
      layers: [
        {
          id: "animated-blur-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 60, y: 50, width: 60, height: 60 },
          style: { fill: "#ffffff" },
          effects: { blur: 0 },
          keyframes: {
            "effects.blur": [
              { atMs: 0, value: 0, easing: "linear" },
              { atMs: 1000, value: 8 }
            ]
          }
        }
      ]
    });

    const start = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T12:25:00.000Z" });
    const end = await renderNativePreviewFrame({ packageRoot, atMs: 1000, now: () => "2026-07-02T12:25:00.000Z" });

    expect(start.ok).toBe(true);
    expect(end.ok).toBe(true);
    if (!start.ok || !end.ok) return;
    expect(start.frame.sha256).not.toBe(end.frame.sha256);
    const startSpill = inspectPngRegionBuffer(start.frame.png, { x: 122, y: 64, width: 8, height: 32 });
    const endSpill = inspectPngRegionBuffer(end.frame.png, { x: 122, y: 64, width: 8, height: 32 });
    expect(startSpill.ok).toBe(true);
    expect(endSpill.ok).toBe(true);
    if (!startSpill.ok || !endSpill.ok) return;
    expect(startSpill.luma.avg).toBeLessThan(5);
    expect(endSpill.luma.avg).toBeGreaterThan(15);
  });

  it("renders native color filter effects as layer post-processing", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape_color_effects",
      background: "#000000",
      layers: [
        {
          id: "bright-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 10, y: 20, width: 40, height: 40 },
          style: { fill: "#404040" },
          effects: { brightness: 2 }
        },
        {
          id: "contrast-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 60, y: 20, width: 40, height: 40 },
          style: { fill: "#a0a0a0" },
          effects: { contrast: 2 }
        },
        {
          id: "saturate-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 110, y: 20, width: 40, height: 40 },
          style: { fill: "#336699" },
          effects: { saturate: 0 }
        },
        {
          id: "grayscale-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 160, y: 20, width: 40, height: 40 },
          style: { fill: "#ff0000" },
          effects: { grayscale: 1 }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T12:35:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bright = readPngPixel(result.frame.png, 30, 40);
    const contrast = readPngPixel(result.frame.png, 80, 40);
    const desaturated = readPngPixel(result.frame.png, 130, 40);
    const grayscale = readPngPixel(result.frame.png, 180, 40);
    expect(bright.r).toBeGreaterThan(120);
    expect(bright.g).toBeGreaterThan(120);
    expect(bright.b).toBeGreaterThan(120);
    expect(contrast.r).toBeGreaterThan(185);
    expect(contrast.g).toBeGreaterThan(185);
    expect(contrast.b).toBeGreaterThan(185);
    expect(channelRange(desaturated)).toBeLessThanOrEqual(1);
    expect(channelRange(grayscale)).toBeLessThanOrEqual(1);
    expect(grayscale.r).toBeLessThan(80);
    expect(grayscale.g).toBeGreaterThan(40);
    expect(grayscale.b).toBeGreaterThan(40);
    expect(result.receipt).toMatchObject({
      operation: "preview.frame",
      status: "passed",
      warnings: []
    });
  });

  it("renders native brightness keyframes at capture time", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape_brightness_keyframes",
      background: "#000000",
      layers: [
        {
          id: "animated-bright-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 20, y: 20, width: 60, height: 60 },
          style: { fill: "#404040" },
          effects: { brightness: 1 },
          keyframes: {
            "effects.brightness": [
              { atMs: 0, value: 1, easing: "linear" },
              { atMs: 1000, value: 2 }
            ]
          }
        }
      ]
    });

    const start = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T12:40:00.000Z" });
    const end = await renderNativePreviewFrame({ packageRoot, atMs: 1000, now: () => "2026-07-02T12:40:00.000Z" });

    expect(start.ok).toBe(true);
    expect(end.ok).toBe(true);
    if (!start.ok || !end.ok) return;
    expect(start.frame.sha256).not.toBe(end.frame.sha256);
    const startPixel = readPngPixel(start.frame.png, 50, 50);
    const endPixel = readPngPixel(end.frame.png, 50, 50);
    expect(startPixel.r).toBeGreaterThanOrEqual(60);
    expect(startPixel.r).toBeLessThanOrEqual(68);
    expect(endPixel.r).toBeGreaterThan(startPixel.r + 55);
    expect(endPixel.g).toBeGreaterThan(startPixel.g + 55);
    expect(endPixel.b).toBeGreaterThan(startPixel.b + 55);
  });

  it("renders native blend modes against the existing backdrop", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape_blend_modes",
      background: "#000000",
      layers: [
        {
          id: "multiply-base",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 10, y: 10, width: 40, height: 40 },
          style: { fill: "#00ffff" }
        },
        {
          id: "multiply-top",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 20, width: 40, height: 40 },
          style: { fill: "#ffff00" },
          blendMode: "multiply"
        },
        {
          id: "screen-base",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 80, y: 10, width: 40, height: 40 },
          style: { fill: "#ff0000" }
        },
        {
          id: "screen-top",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 90, y: 20, width: 40, height: 40 },
          style: { fill: "#0000ff" },
          blendMode: "screen"
        },
        {
          id: "plus-base",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 150, y: 10, width: 40, height: 40 },
          style: { fill: "#808000" }
        },
        {
          id: "plus-top",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 160, y: 20, width: 40, height: 40 },
          style: { fill: "#808080" },
          blendMode: "plus-lighter"
        },
        {
          id: "difference-base",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 220, y: 10, width: 40, height: 40 },
          style: { fill: "#204080" }
        },
        {
          id: "difference-top",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 230, y: 20, width: 40, height: 40 },
          style: { fill: "#802010" },
          blendMode: "difference"
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T13:00:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readPngPixel(result.frame.png, 30, 30)).toMatchObject({ r: 0, g: 255, b: 0, a: 255 });
    expect(readPngPixel(result.frame.png, 100, 30)).toMatchObject({ r: 255, g: 0, b: 255, a: 255 });
    expect(readPngPixel(result.frame.png, 170, 30)).toMatchObject({ r: 255, g: 255, b: 128, a: 255 });
    expect(readPngPixel(result.frame.png, 240, 30)).toMatchObject({ r: 96, g: 32, b: 112, a: 255 });
    expect(result.receipt).toMatchObject({
      operation: "preview.frame",
      status: "passed",
      warnings: []
    });
  });

  it("renders native blend mode keyframes against the existing backdrop", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape_blend_mode_keyframes",
      background: "#000000",
      layers: [
        {
          id: "cyan-base",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 10, y: 10, width: 60, height: 60 },
          style: { fill: "#00ffff" }
        },
        {
          id: "yellow-top",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 20, width: 60, height: 60 },
          style: { fill: "#ffff00" },
          blendMode: "normal",
          keyframes: {
            blendMode: [
              { atMs: 0, value: "normal", easing: "hold" },
              { atMs: 500, value: "multiply" }
            ]
          }
        }
      ]
    });

    const start = await renderNativePreviewFrame({ packageRoot, atMs: 250, now: () => "2026-07-02T13:05:00.000Z" });
    const end = await renderNativePreviewFrame({ packageRoot, atMs: 750, now: () => "2026-07-02T13:05:00.000Z" });

    expect(start.ok).toBe(true);
    expect(end.ok).toBe(true);
    if (!start.ok || !end.ok) return;
    expect(readPngPixel(start.frame.png, 30, 30)).toMatchObject({ r: 255, g: 255, b: 0, a: 255 });
    expect(readPngPixel(end.frame.png, 30, 30)).toMatchObject({ r: 0, g: 255, b: 0, a: 255 });
    expect(start.frame.sha256).not.toBe(end.frame.sha256);
  });

  it("renders native ellipse shape fills and strokes", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape_ellipse",
      background: "#000000",
      layers: [
        {
          id: "badge",
          type: "shape",
          shape: "ellipse",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 30, y: 20, width: 120, height: 80 },
          style: { fill: "#ffffff", stroke: "#ff0000", width: 8 }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T13:10:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outsideCorner = inspectPngRegionBuffer(result.frame.png, { x: 30, y: 20, width: 12, height: 12 });
    const centerFill = inspectPngRegionBuffer(result.frame.png, { x: 82, y: 52, width: 16, height: 16 });
    const leftStroke = readPngPixel(result.frame.png, 32, 60);
    expect(outsideCorner.ok).toBe(true);
    expect(centerFill.ok).toBe(true);
    if (!outsideCorner.ok || !centerFill.ok) return;
    expect(outsideCorner.luma.brightPixels).toBe(0);
    expect(outsideCorner.luma.darkPixels).toBeGreaterThan(120);
    expect(centerFill.luma.brightPixels).toBeGreaterThan(240);
    expect(centerFill.luma.darkPixels).toBe(0);
    expect(leftStroke).toMatchObject({ r: 255, g: 0, b: 0, a: 255 });
    expect(result.receipt).toMatchObject({
      operation: "preview.frame",
      status: "passed",
      warnings: []
    });
  });

  it("renders native triangle shape fills and strokes", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape_triangle",
      background: "#000000",
      layers: [
        {
          id: "play-icon",
          type: "shape",
          shape: "triangle",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 40, y: 20, width: 100, height: 80 },
          style: { fill: "#ffffff", stroke: "#ff0000", width: 8 }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T13:20:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outsideTopLeft = inspectPngRegionBuffer(result.frame.png, { x: 40, y: 20, width: 16, height: 16 });
    const centerFill = readPngPixel(result.frame.png, 90, 70);
    const leftStroke = readPngPixel(result.frame.png, 66, 60);
    expect(outsideTopLeft.ok).toBe(true);
    if (!outsideTopLeft.ok) return;
    expect(outsideTopLeft.luma.brightPixels).toBe(0);
    expect(outsideTopLeft.luma.darkPixels).toBeGreaterThan(200);
    expect(centerFill).toMatchObject({ r: 255, g: 255, b: 255, a: 255 });
    expect(leftStroke).toMatchObject({ r: 255, g: 0, b: 0, a: 255 });
    expect(result.receipt).toMatchObject({
      operation: "preview.frame",
      status: "passed",
      warnings: []
    });
  });

  it("renders native star shape fills and strokes", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape_star",
      background: "#000000",
      layers: [
        {
          id: "badge-star",
          type: "shape",
          shape: "star",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 40, y: 20, width: 100, height: 100 },
          style: { fill: "#ffffff", stroke: "#00ff00", width: 6 }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T13:40:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outsideTopLeft = inspectPngRegionBuffer(result.frame.png, { x: 40, y: 20, width: 12, height: 12 });
    const centerFill = readPngPixel(result.frame.png, 90, 70);
    const topStroke = readPngPixel(result.frame.png, 90, 22);
    expect(outsideTopLeft.ok).toBe(true);
    if (!outsideTopLeft.ok) return;
    expect(outsideTopLeft.luma.brightPixels).toBe(0);
    expect(outsideTopLeft.luma.darkPixels).toBeGreaterThan(120);
    expect(centerFill).toMatchObject({ r: 255, g: 255, b: 255, a: 255 });
    expect(topStroke).toMatchObject({ r: 0, g: 255, b: 0, a: 255 });
    expect(result.receipt).toMatchObject({
      operation: "preview.frame",
      status: "passed",
      warnings: []
    });
  });

  it("renders native path shape fills and strokes", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape_path",
      background: "#000000",
      layers: [
        {
          id: "route-badge",
          type: "shape",
          shape: "path",
          "x-path": "M 10 50 L 50 10 L 90 50 L 70 90 L 30 90 Z",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 40, y: 20, width: 100, height: 100 },
          style: { fill: "#ffffff", stroke: "#00aaff", width: 6 }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T14:00:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outsideTopLeft = inspectPngRegionBuffer(result.frame.png, { x: 40, y: 20, width: 12, height: 12 });
    const centerFill = readPngPixel(result.frame.png, 90, 78);
    const topStroke = readPngPixel(result.frame.png, 90, 31);
    expect(outsideTopLeft.ok).toBe(true);
    if (!outsideTopLeft.ok) return;
    expect(outsideTopLeft.luma.brightPixels).toBe(0);
    expect(outsideTopLeft.luma.darkPixels).toBeGreaterThan(120);
    expect(centerFill).toMatchObject({ r: 255, g: 255, b: 255, a: 255 });
    expect(topStroke).toMatchObject({ r: 0, g: 170, b: 255, a: 255 });
    expect(result.receipt).toMatchObject({
      operation: "preview.frame",
      status: "passed",
      warnings: []
    });
  });

  it("renders native freeform shapes with x-path geometry as paths", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape_freeform_path",
      background: "#000000",
      layers: [
        {
          id: "route-badge",
          type: "shape",
          shape: "freeform",
          "x-path": "M 10 50 L 50 10 L 90 50 L 70 90 L 30 90 Z",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 40, y: 20, width: 100, height: 100 },
          style: { fill: "#ffffff", stroke: "#00aaff", width: 6 }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T19:55:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outsideTopLeft = inspectPngRegionBuffer(result.frame.png, { x: 40, y: 20, width: 12, height: 12 });
    const centerFill = readPngPixel(result.frame.png, 90, 78);
    const topStroke = readPngPixel(result.frame.png, 90, 31);
    expect(outsideTopLeft.ok).toBe(true);
    if (!outsideTopLeft.ok) return;
    expect(outsideTopLeft.luma.brightPixels).toBe(0);
    expect(outsideTopLeft.luma.darkPixels).toBeGreaterThan(120);
    expect(centerFill).toMatchObject({ r: 255, g: 255, b: 255, a: 255 });
    expect(topStroke).toMatchObject({ r: 0, g: 170, b: 255, a: 255 });
    expect(result.receipt).toMatchObject({
      operation: "preview.frame",
      status: "passed",
      warnings: []
    });
  });

  it("renders native shape radius as rounded fill corners", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape_radius",
      background: "#000000",
      layers: [
        {
          id: "rounded-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 20, width: 120, height: 80 },
          style: { fill: "#ffffff", radius: 24 }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T10:20:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const roundedCorner = inspectPngRegionBuffer(result.frame.png, { x: 20, y: 20, width: 6, height: 6 });
    const roundedArc = inspectPngRegionBuffer(result.frame.png, { x: 30, y: 30, width: 8, height: 8 });
    const innerFill = inspectPngRegionBuffer(result.frame.png, { x: 58, y: 48, width: 50, height: 30 });
    expect(roundedCorner.ok).toBe(true);
    expect(roundedArc.ok).toBe(true);
    expect(innerFill.ok).toBe(true);
    if (!roundedCorner.ok || !roundedArc.ok || !innerFill.ok) return;
    expect(roundedCorner.luma.brightPixels).toBe(0);
    expect(roundedCorner.luma.darkPixels).toBeGreaterThan(30);
    expect(roundedArc.luma.brightPixels).toBeGreaterThan(20);
    expect(innerFill.luma.brightPixels).toBeGreaterThan(1400);
    expect(result.receipt).toMatchObject({
      operation: "preview.frame",
      status: "passed",
      warnings: []
    });
  });

  it("renders native rounded-rect shape aliases as rounded rectangles", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape_rounded_rect",
      background: "#000000",
      layers: [
        {
          id: "rounded-panel",
          type: "shape",
          shape: "rounded-rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 20, width: 120, height: 80 },
          style: { fill: "#ffffff", radius: 24 }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T13:10:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const roundedCorner = inspectPngRegionBuffer(result.frame.png, { x: 20, y: 20, width: 6, height: 6 });
    const innerFill = inspectPngRegionBuffer(result.frame.png, { x: 58, y: 48, width: 50, height: 30 });
    expect(roundedCorner.ok).toBe(true);
    expect(innerFill.ok).toBe(true);
    if (!roundedCorner.ok || !innerFill.ok) return;
    expect(roundedCorner.luma.brightPixels).toBe(0);
    expect(innerFill.luma.brightPixels).toBeGreaterThan(1400);
  });

  it("renders native style radius keyframes at capture time", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape_radius_keyframes",
      background: "#000000",
      layers: [
        {
          id: "animated-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 20, y: 20, width: 120, height: 80 },
          style: { fill: "#ffffff", radius: 0 },
          keyframes: {
            "style.radius": [
              { atMs: 0, value: 0, easing: "linear" },
              { atMs: 1000, value: 28 }
            ]
          }
        }
      ]
    });

    const start = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T10:25:00.000Z" });
    const end = await renderNativePreviewFrame({ packageRoot, atMs: 1000, now: () => "2026-07-02T10:25:00.000Z" });

    expect(start.ok).toBe(true);
    expect(end.ok).toBe(true);
    if (!start.ok || !end.ok) return;
    const startCorner = inspectPngRegionBuffer(start.frame.png, { x: 20, y: 20, width: 6, height: 6 });
    const endCorner = inspectPngRegionBuffer(end.frame.png, { x: 20, y: 20, width: 6, height: 6 });
    expect(startCorner.ok).toBe(true);
    expect(endCorner.ok).toBe(true);
    if (!startCorner.ok || !endCorner.ok) return;
    expect(start.frame.sha256).not.toBe(end.frame.sha256);
    expect(startCorner.luma.brightPixels).toBeGreaterThan(30);
    expect(endCorner.luma.brightPixels).toBe(0);
    expect(endCorner.luma.darkPixels).toBeGreaterThan(30);
  });

  it("renders native style border-radius keyframes at capture time", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape_border_radius_keyframes",
      background: "#000000",
      layers: [
        {
          id: "animated-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 20, y: 20, width: 120, height: 80 },
          style: { fill: "#ffffff", borderRadius: 0 },
          keyframes: {
            "style.borderRadius": [
              { atMs: 0, value: 0, easing: "linear" },
              { atMs: 1000, value: 28 }
            ]
          }
        }
      ]
    });

    const start = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T14:50:00.000Z" });
    const end = await renderNativePreviewFrame({ packageRoot, atMs: 1000, now: () => "2026-07-02T14:50:00.000Z" });

    expect(start.ok).toBe(true);
    expect(end.ok).toBe(true);
    if (!start.ok || !end.ok) return;
    const startCorner = inspectPngRegionBuffer(start.frame.png, { x: 20, y: 20, width: 6, height: 6 });
    const endCorner = inspectPngRegionBuffer(end.frame.png, { x: 20, y: 20, width: 6, height: 6 });
    expect(startCorner.ok).toBe(true);
    expect(endCorner.ok).toBe(true);
    if (!startCorner.ok || !endCorner.ok) return;
    expect(start.frame.sha256).not.toBe(end.frame.sha256);
    expect(startCorner.luma.brightPixels).toBeGreaterThan(30);
    expect(endCorner.luma.brightPixels).toBe(0);
    expect(endCorner.luma.darkPixels).toBeGreaterThan(30);
  });

  it("renders native shape color keyframes from fill and style aliases", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape_color_keyframes",
      background: "#000000",
      layers: [
        {
          id: "fill-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 20, y: 20, width: 4, height: 4 },
          keyframes: {
            fill: [
              { atMs: 0, value: "#ff0000" },
              { atMs: 1000, value: "#00ff00" }
            ]
          }
        },
        {
          id: "style-fill-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 30, y: 20, width: 4, height: 4 },
          keyframes: {
            "style.fill": [
              { atMs: 0, value: "#ff0000" },
              { atMs: 1000, value: "#00ff00" }
            ]
          }
        },
        {
          id: "style-color-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 40, y: 20, width: 4, height: 4 },
          keyframes: {
            "style.color": [
              { atMs: 0, value: "#ff0000" },
              { atMs: 1000, value: "#00ff00" }
            ]
          }
        }
      ]
    });

    const start = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T13:45:00.000Z" });
    const end = await renderNativePreviewFrame({ packageRoot, atMs: 1000, now: () => "2026-07-02T13:45:00.000Z" });

    expect(start.ok).toBe(true);
    expect(end.ok).toBe(true);
    if (!start.ok || !end.ok) return;
    for (const x of [20, 30, 40]) {
      expect(readPngPixel(start.frame.png, x, 20)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
      expect(readPngPixel(end.frame.png, x, 20)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    }
  });

  it("renders transform width and height keyframes for shape layers", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape_size_keyframes",
      background: "#000000",
      layers: [
        {
          id: "box",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 10, y: 12, width: 20, height: 20 },
          style: { fill: "#ffffff" },
          keyframes: {
            "transform.width": [
              { atMs: 0, value: 20, easing: "linear" },
              { atMs: 1000, value: 180 }
            ],
            "transform.height": [
              { atMs: 0, value: 20, easing: "linear" },
              { atMs: 1000, value: 100 }
            ]
          }
        }
      ]
    });

    const start = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-06-30T09:10:00.000Z" });
    const mid = await renderNativePreviewFrame({ packageRoot, atMs: 500, now: () => "2026-06-30T09:10:00.000Z" });

    expect(start.ok).toBe(true);
    expect(mid.ok).toBe(true);
    if (!start.ok || !mid.ok) return;
    const startQuality = inspectPngBuffer(start.frame.png);
    const midQuality = inspectPngBuffer(mid.frame.png);
    expect(startQuality.ok).toBe(true);
    expect(midQuality.ok).toBe(true);
    if (!startQuality.ok || !midQuality.ok) return;
    expect(midQuality.luma.brightPixels).toBeGreaterThan(startQuality.luma.brightPixels * 3);
  });

  it("renders native style width and height keyframes for shape layers", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape_style_dimension_keyframes",
      background: "#000000",
      layers: [
        {
          id: "panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 20, y: 20 },
          style: { fill: "#ffffff", width: 40, height: 20 },
          keyframes: {
            "style.width": [
              { atMs: 0, value: 40, easing: "linear" },
              { atMs: 1000, value: 90 }
            ],
            "style.height": [
              { atMs: 0, value: 20, easing: "linear" },
              { atMs: 1000, value: 50 }
            ]
          }
        }
      ]
    });

    const start = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T16:10:00.000Z" });
    const end = await renderNativePreviewFrame({ packageRoot, atMs: 1000, now: () => "2026-07-02T16:10:00.000Z" });

    expect(start.ok).toBe(true);
    expect(end.ok).toBe(true);
    if (!start.ok || !end.ok) return;
    expect(start.frame.sha256).not.toBe(end.frame.sha256);
    expect(readPngPixel(start.frame.png, 85, 55)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
    expect(readPngPixel(end.frame.png, 85, 55)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
  });

  it("renders expressive named easing keyframes with overshoot", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape_back_out_keyframes",
      background: "#000000",
      layers: [
        {
          id: "overshoot-card",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1200,
          transform: { x: 20, y: 20, width: 20, height: 20 },
          style: { fill: "#ffffff" },
          keyframes: {
            "transform.x": [
              { atMs: 0, value: 20, easing: "back-out" },
              { atMs: 1000, value: 80 }
            ]
          }
        }
      ]
    });

    const mid = await renderNativePreviewFrame({ packageRoot, atMs: 500, now: () => "2026-07-02T14:20:00.000Z" });

    expect(mid.ok).toBe(true);
    if (!mid.ok) return;
    expect(readPngPixel(mid.frame.png, 103, 30)).toMatchObject({ r: 255, g: 255, b: 255, a: 255 });
    expect(mid.receipt).toMatchObject({
      operation: "preview.frame",
      status: "passed",
      warnings: []
    });
  });

  it("scales shape layers around their center to match browser transform origin", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape_center_scale",
      background: "#000000",
      layers: [
        {
          id: "centered-box",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 80, y: 40, width: 40, height: 20, scale: 2 },
          style: { fill: "#ffffff" }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-01T22:00:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const leftExpansion = inspectPngRegionBuffer(result.frame.png, { x: 60, y: 35, width: 12, height: 12 });
    const topExpansion = inspectPngRegionBuffer(result.frame.png, { x: 90, y: 30, width: 12, height: 8 });
    expect(leftExpansion.ok).toBe(true);
    expect(topExpansion.ok).toBe(true);
    if (!leftExpansion.ok || !topExpansion.ok) return;
    expect(leftExpansion.luma.brightPixels).toBeGreaterThan(0);
    expect(topExpansion.luma.brightPixels).toBeGreaterThan(0);
  });

  it("scales shape layers around explicit transform origins", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape_origin_scale",
      background: "#000000",
      layers: [
        {
          id: "anchored-box",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 80, y: 40, width: 40, height: 20, scale: 2, originX: 0, originY: 0 },
          style: { fill: "#ffffff" }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T01:00:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const leftOfAnchor = inspectPngRegionBuffer(result.frame.png, { x: 60, y: 45, width: 12, height: 12 });
    const aboveAnchor = inspectPngRegionBuffer(result.frame.png, { x: 90, y: 30, width: 12, height: 8 });
    const rightExpansion = inspectPngRegionBuffer(result.frame.png, { x: 125, y: 48, width: 24, height: 16 });
    const bottomExpansion = inspectPngRegionBuffer(result.frame.png, { x: 90, y: 65, width: 24, height: 12 });

    expect(leftOfAnchor.ok).toBe(true);
    expect(aboveAnchor.ok).toBe(true);
    expect(rightExpansion.ok).toBe(true);
    expect(bottomExpansion.ok).toBe(true);
    if (!leftOfAnchor.ok || !aboveAnchor.ok || !rightExpansion.ok || !bottomExpansion.ok) return;
    expect(leftOfAnchor.luma.brightPixels).toBe(0);
    expect(aboveAnchor.luma.brightPixels).toBe(0);
    expect(rightExpansion.luma.brightPixels).toBeGreaterThan(0);
    expect(bottomExpansion.luma.brightPixels).toBeGreaterThan(0);
  });

  it("scales text box layers around their center to match browser transform origin", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_text_center_scale",
      background: "#000000",
      layers: [
        {
          id: "centered-title",
          type: "text",
          text: "II",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 80, y: 40, width: 40, height: 20, scale: 2 },
          style: { backgroundColor: "#ffffff", color: "#000000", fontSize: 16 }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T01:10:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const leftExpansion = inspectPngRegionBuffer(result.frame.png, { x: 60, y: 45, width: 12, height: 12 });
    const topExpansion = inspectPngRegionBuffer(result.frame.png, { x: 90, y: 30, width: 12, height: 8 });
    expect(leftExpansion.ok).toBe(true);
    expect(topExpansion.ok).toBe(true);
    if (!leftExpansion.ok || !topExpansion.ok) return;
    expect(leftExpansion.luma.brightPixels).toBeGreaterThan(0);
    expect(topExpansion.luma.brightPixels).toBeGreaterThan(0);
  });

  it("renders keyframed transform origins for native shape previews", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_shape_origin_keyframes",
      background: "#000000",
      layers: [
        {
          id: "anchored-box",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 80, y: 40, width: 40, height: 20, scale: 2, originX: 20, originY: 10 },
          style: { fill: "#ffffff" },
          keyframes: {
            "transform.originX": [
              { atMs: 0, value: 20, easing: "linear" },
              { atMs: 1000, value: 0 }
            ],
            "transform.originY": [
              { atMs: 0, value: 10, easing: "linear" },
              { atMs: 1000, value: 0 }
            ]
          }
        }
      ]
    });

    const start = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T01:05:00.000Z" });
    const end = await renderNativePreviewFrame({ packageRoot, atMs: 1000, now: () => "2026-07-02T01:05:00.000Z" });

    expect(start.ok).toBe(true);
    expect(end.ok).toBe(true);
    if (!start.ok || !end.ok) return;
    const startLeftExpansion = inspectPngRegionBuffer(start.frame.png, { x: 60, y: 35, width: 12, height: 12 });
    const endLeftExpansion = inspectPngRegionBuffer(end.frame.png, { x: 60, y: 35, width: 12, height: 12 });
    const endRightExpansion = inspectPngRegionBuffer(end.frame.png, { x: 125, y: 48, width: 24, height: 16 });

    expect(start.frame.sha256).not.toBe(end.frame.sha256);
    expect(startLeftExpansion.ok).toBe(true);
    expect(endLeftExpansion.ok).toBe(true);
    expect(endRightExpansion.ok).toBe(true);
    if (!startLeftExpansion.ok || !endLeftExpansion.ok || !endRightExpansion.ok) return;
    expect(startLeftExpansion.luma.brightPixels).toBeGreaterThan(0);
    expect(endLeftExpansion.luma.brightPixels).toBe(0);
    expect(endRightExpansion.luma.brightPixels).toBeGreaterThan(0);
  });

  it("accepts transparent shape fills from Canvas source-selection exports", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_transparent_shape",
      background: "#ffffff",
      layers: [
        {
          id: "source-selection",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 0, y: 0 },
          width: 160,
          height: 80,
          style: { fill: "transparent" }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-06-30T03:10:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frame.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.receipt).toMatchObject({
      operation: "preview.frame",
      status: "passed",
      lane: "native",
      warnings: []
    });
  });

  it("renders named, rgb, rgba, and token-resolved colors", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_css_colors",
      background: "navy",
      designTokens: { color: { accent: "rgb(255, 255, 255)", label: "rgba(56, 189, 248, 0.85)" } },
      layers: [
        {
          id: "token-box",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 12, y: 16 },
          width: 120,
          height: 48,
          style: { fill: "{color.accent}" }
        },
        {
          id: "label",
          type: "text",
          text: "Motion",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 80 },
          style: { color: "{color.label}", fontSize: 24 }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-01T20:00:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const quality = inspectPngBuffer(result.frame.png);
    expect(quality.ok).toBe(true);
    if (!quality.ok) return;
    expect(quality.luma.brightPixels).toBeGreaterThan(5000);
  });

  it("renders token-resolved hsl and hsla CSS colors", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_hsl_css_colors",
      background: "#000000",
      designTokens: {
        color: {
          green: "hsl(120deg 100% 50%)",
          redOverlay: "hsla(0 100% 50% / 50%)"
        }
      },
      layers: [
        {
          id: "green-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 8, y: 8 },
          width: 20,
          height: 20,
          style: { fill: "{color.green}" }
        },
        {
          id: "red-overlay",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 36, y: 8 },
          width: 20,
          height: 20,
          style: { fill: "{color.redOverlay}" }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-03T11:20:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readPngPixel(result.frame.png, 12, 12)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(readPngPixel(result.frame.png, 40, 12)).toEqual({ r: 128, g: 0, b: 0, a: 255 });
  });

  it("renders browser-compatible short hex alpha and currentColor colors", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_current_color_css_colors",
      background: "#ffffff",
      designTokens: { color: { translucentGreen: "#0f08" } },
      layers: [
        {
          id: "short-hex-alpha",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 8, y: 8 },
          width: 20,
          height: 20,
          style: { fill: "{color.translucentGreen}" }
        },
        {
          id: "shape-current-color",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 36, y: 8 },
          width: 20,
          height: 20,
          style: { fill: "currentColor" }
        },
        {
          id: "text-current-color",
          type: "text",
          text: "I",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 64, y: 8, width: 40, height: 28 },
          style: { color: "#00ff00", backgroundColor: "currentColor", fontSize: 14 }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-03T12:10:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readPngPixel(result.frame.png, 12, 12)).toEqual({ r: 119, g: 255, b: 119, a: 255 });
    expect(readPngPixel(result.frame.png, 40, 12)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
    expect(readPngPixel(result.frame.png, 66, 10)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
  });

  it("returns a structured failed receipt when native color parsing fails", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_bad_native_color",
      background: "#ffffff",
      layers: [
        {
          id: "bad-color-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 12, y: 16 },
          width: 120,
          height: 48,
          style: { fill: "color(display-p3 1 0 0)" }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T00:20:00.000Z" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      code: "render_failed",
      message: "Native renderer failed: Unsupported color format: color(display-p3 1 0 0)",
      unsupported: []
    });
    expect(result.receipt).toMatchObject({
      operation: "preview.frame",
      status: "failed",
      lane: "native",
      output: null,
      warnings: ["Native renderer failed: Unsupported color format: color(display-p3 1 0 0)"]
    });
  });

  it("uses browser-compatible dark default text color on light backgrounds", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_default_text_color",
      background: "#ffffff",
      layers: [
        {
          id: "title",
          type: "text",
          text: "AAAA",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 8, y: 8 },
          style: { fontSize: 28 }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T00:00:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const textRegion = inspectPngRegionBuffer(result.frame.png, { x: 0, y: 0, width: 160, height: 80 });
    expect(textRegion.ok).toBe(true);
    if (!textRegion.ok) return;
    expect(textRegion.luma.darkPixels).toBeGreaterThan(100);
    expect(textRegion.luma.range).toBeGreaterThan(100);
    expect(result.warnings).toEqual([]);
  });

  it("renders caption layers as native text-equivalent overlays", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_caption",
      background: "#111827",
      layers: [
        {
          id: "caption",
          type: "caption",
          text: "Motion caption",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 24, y: 120 },
          style: { color: "#38bdf8", fontSize: 24 }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-06-30T08:10:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frame.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.receipt).toMatchObject({
      operation: "preview.frame",
      // the text-delivery invariant: "Motion caption" is case-folded by the block-glyph set, so the caption preview
      // is degraded and says so rather than passing silently.
      status: "warning",
      lane: "native",
      warnings: ["Native renderer case-folded lowercase text to uppercase block glyphs on layer caption: otincap."]
    });
  });

  it("lays out multi-line native text with line-height instead of fallback glyph boxes", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_multiline_text",
      background: "#000000",
      layers: [
        {
          id: "title",
          type: "text",
          text: "TOP\nBOTTOM",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 8, y: 8 },
          style: { color: "#ffffff", fontSize: 28, lineHeight: 1.2 }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T09:00:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const firstLine = inspectPngRegionBuffer(result.frame.png, { x: 8, y: 8, width: 100, height: 30 });
    const secondLine = inspectPngRegionBuffer(result.frame.png, { x: 8, y: 40, width: 150, height: 34 });
    expect(firstLine.ok).toBe(true);
    expect(secondLine.ok).toBe(true);
    if (!firstLine.ok || !secondLine.ok) return;
    expect(firstLine.luma.brightPixels).toBeGreaterThan(100);
    expect(secondLine.luma.brightPixels).toBeGreaterThan(150);
    expect(result.warnings).toEqual([]);
    expect(result.receipt).toMatchObject({
      operation: "preview.frame",
      status: "passed",
      lane: "native",
      warnings: []
    });
  });

  it("wraps native text inside explicit text box widths", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_wrapped_text",
      background: "#000000",
      layers: [
        {
          id: "title",
          type: "text",
          text: "TOP LOW",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 8, y: 8, width: 80 },
          style: { color: "#ffffff", fontSize: 28, lineHeight: 1.2 }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T09:10:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const firstLine = inspectPngRegionBuffer(result.frame.png, { x: 8, y: 8, width: 86, height: 30 });
    const secondLine = inspectPngRegionBuffer(result.frame.png, { x: 8, y: 40, width: 86, height: 34 });
    const unwrappedRightEdge = inspectPngRegionBuffer(result.frame.png, { x: 112, y: 8, width: 80, height: 30 });
    expect(firstLine.ok).toBe(true);
    expect(secondLine.ok).toBe(true);
    expect(unwrappedRightEdge.ok).toBe(true);
    if (!firstLine.ok || !secondLine.ok || !unwrappedRightEdge.ok) return;
    expect(firstLine.luma.brightPixels).toBeGreaterThan(100);
    expect(secondLine.luma.brightPixels).toBeGreaterThan(100);
    expect(unwrappedRightEdge.luma.brightPixels).toBe(0);
    expect(result.receipt).toMatchObject({
      operation: "preview.frame",
      status: "passed",
      warnings: []
    });
  });

  it("aligns native text inside explicit text box widths", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_aligned_text",
      background: "#000000",
      layers: [
        {
          id: "title",
          type: "text",
          text: "II",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 8, y: 8, width: 160 },
          style: { color: "#ffffff", fontSize: 28, textAlign: "right" }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T09:20:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const leftEdge = inspectPngRegionBuffer(result.frame.png, { x: 8, y: 8, width: 60, height: 30 });
    const rightEdge = inspectPngRegionBuffer(result.frame.png, { x: 120, y: 8, width: 60, height: 30 });
    expect(leftEdge.ok).toBe(true);
    expect(rightEdge.ok).toBe(true);
    if (!leftEdge.ok || !rightEdge.ok) return;
    expect(leftEdge.luma.brightPixels).toBe(0);
    expect(rightEdge.luma.brightPixels).toBeGreaterThan(80);
    expect(result.receipt).toMatchObject({
      operation: "preview.frame",
      status: "passed",
      warnings: []
    });
  });

  it("vertically aligns native text inside explicit text box heights", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_vertically_aligned_text",
      background: "#000000",
      layers: [
        {
          id: "title",
          type: "text",
          text: "II",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 8, y: 8, width: 120, height: 80 },
          style: { color: "#ffffff", fontSize: 28, verticalAlign: "bottom" }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T09:30:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const topEdge = inspectPngRegionBuffer(result.frame.png, { x: 8, y: 8, width: 120, height: 30 });
    const bottomEdge = inspectPngRegionBuffer(result.frame.png, { x: 8, y: 58, width: 120, height: 30 });
    expect(topEdge.ok).toBe(true);
    expect(bottomEdge.ok).toBe(true);
    if (!topEdge.ok || !bottomEdge.ok) return;
    expect(topEdge.luma.brightPixels).toBe(0);
    expect(bottomEdge.luma.brightPixels).toBeGreaterThan(80);
    expect(result.receipt).toMatchObject({
      operation: "preview.frame",
      status: "passed",
      warnings: []
    });
  });

  it("renders native text alignment keyframes at capture time", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_text_alignment_keyframes",
      background: "#000000",
      layers: [
        {
          id: "title",
          type: "text",
          text: "II",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 8, y: 8, width: 160, height: 80 },
          style: { color: "#ffffff", fontSize: 28, textAlign: "left", verticalAlign: "top" },
          keyframes: {
            "style.textAlign": [
              { atMs: 0, value: "left", easing: "hold" },
              { atMs: 1000, value: "right" }
            ],
            "style.verticalAlign": [
              { atMs: 0, value: "top", easing: "hold" },
              { atMs: 1000, value: "bottom" }
            ]
          }
        }
      ]
    });

    const start = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T15:20:00.000Z" });
    const end = await renderNativePreviewFrame({ packageRoot, atMs: 1000, now: () => "2026-07-02T15:20:00.000Z" });

    expect(start.ok).toBe(true);
    expect(end.ok).toBe(true);
    if (!start.ok || !end.ok) return;
    const startTopLeft = inspectPngRegionBuffer(start.frame.png, { x: 8, y: 8, width: 60, height: 30 });
    const startBottomRight = inspectPngRegionBuffer(start.frame.png, { x: 120, y: 58, width: 60, height: 30 });
    const endTopLeft = inspectPngRegionBuffer(end.frame.png, { x: 8, y: 8, width: 60, height: 30 });
    const endBottomRight = inspectPngRegionBuffer(end.frame.png, { x: 120, y: 58, width: 60, height: 30 });
    expect(startTopLeft.ok).toBe(true);
    expect(startBottomRight.ok).toBe(true);
    expect(endTopLeft.ok).toBe(true);
    expect(endBottomRight.ok).toBe(true);
    if (!startTopLeft.ok || !startBottomRight.ok || !endTopLeft.ok || !endBottomRight.ok) return;
    expect(start.frame.sha256).not.toBe(end.frame.sha256);
    expect(startTopLeft.luma.brightPixels).toBeGreaterThan(80);
    expect(startBottomRight.luma.brightPixels).toBe(0);
    expect(endTopLeft.luma.brightPixels).toBe(0);
    expect(endBottomRight.luma.brightPixels).toBeGreaterThan(80);
  });

  it("renders native text box backgrounds behind glyphs", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_text_box_background",
      background: "#000000",
      layers: [
        {
          id: "title",
          type: "text",
          text: "II",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 8, y: 8, width: 140, height: 52 },
          style: { backgroundColor: "#ffffff", color: "#000000", fontSize: 28 }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T09:40:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const box = inspectPngRegionBuffer(result.frame.png, { x: 10, y: 10, width: 120, height: 42 });
    expect(box.ok).toBe(true);
    if (!box.ok) return;
    expect(box.luma.brightPixels).toBeGreaterThan(3000);
    expect(result.receipt).toMatchObject({
      operation: "preview.frame",
      status: "passed",
      warnings: []
    });
  });

  it("applies native text box padding before drawing glyphs", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_padded_text_box",
      background: "#000000",
      layers: [
        {
          id: "title",
          type: "text",
          text: "II",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 8, y: 8, width: 150, height: 70 },
          style: { backgroundColor: "#ffffff", color: "#000000", fontSize: 28, padding: 16 }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T09:50:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const inset = inspectPngRegionBuffer(result.frame.png, { x: 8, y: 8, width: 14, height: 52 });
    const paddedText = inspectPngRegionBuffer(result.frame.png, { x: 24, y: 24, width: 70, height: 34 });
    expect(inset.ok).toBe(true);
    expect(paddedText.ok).toBe(true);
    if (!inset.ok || !paddedText.ok) return;
    expect(inset.luma.darkPixels).toBe(0);
    expect(paddedText.luma.darkPixels).toBeGreaterThan(80);
    expect(result.receipt).toMatchObject({
      operation: "preview.frame",
      status: "passed",
      warnings: []
    });
  });

  it("renders native text padding keyframes at capture time", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_text_padding_keyframes",
      background: "#000000",
      layers: [
        {
          id: "title",
          type: "text",
          text: "II",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 8, y: 8, width: 150, height: 70 },
          style: { backgroundColor: "#ffffff", color: "#000000", fontSize: 28, padding: 0 },
          keyframes: {
            "style.padding": [
              { atMs: 0, value: 0, easing: "linear" },
              { atMs: 1000, value: 16 }
            ]
          }
        }
      ]
    });

    const start = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T15:05:00.000Z" });
    const end = await renderNativePreviewFrame({ packageRoot, atMs: 1000, now: () => "2026-07-02T15:05:00.000Z" });

    expect(start.ok).toBe(true);
    expect(end.ok).toBe(true);
    if (!start.ok || !end.ok) return;
    const startInset = inspectPngRegionBuffer(start.frame.png, { x: 8, y: 8, width: 14, height: 52 });
    const endInset = inspectPngRegionBuffer(end.frame.png, { x: 8, y: 8, width: 14, height: 52 });
    const endPaddedText = inspectPngRegionBuffer(end.frame.png, { x: 24, y: 24, width: 70, height: 34 });
    expect(startInset.ok).toBe(true);
    expect(endInset.ok).toBe(true);
    expect(endPaddedText.ok).toBe(true);
    if (!startInset.ok || !endInset.ok || !endPaddedText.ok) return;
    expect(start.frame.sha256).not.toBe(end.frame.sha256);
    expect(startInset.luma.darkPixels).toBeGreaterThan(40);
    expect(endInset.luma.darkPixels).toBe(0);
    expect(endPaddedText.luma.darkPixels).toBeGreaterThan(80);
  });

  it("renders native text side padding keyframes at capture time", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_text_side_padding_keyframes",
      background: "#000000",
      layers: [
        {
          id: "title",
          type: "text",
          text: "II",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 8, y: 8, width: 150, height: 70 },
          style: { backgroundColor: "#ffffff", color: "#000000", fontSize: 28, paddingLeft: 0 },
          keyframes: {
            "style.paddingLeft": [
              { atMs: 0, value: 0, easing: "linear" },
              { atMs: 1000, value: 16 }
            ]
          }
        }
      ]
    });

    const start = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T15:20:00.000Z" });
    const end = await renderNativePreviewFrame({ packageRoot, atMs: 1000, now: () => "2026-07-02T15:20:00.000Z" });

    expect(start.ok).toBe(true);
    expect(end.ok).toBe(true);
    if (!start.ok || !end.ok) return;
    const startInset = inspectPngRegionBuffer(start.frame.png, { x: 8, y: 8, width: 14, height: 52 });
    const endInset = inspectPngRegionBuffer(end.frame.png, { x: 8, y: 8, width: 14, height: 52 });
    const endPaddedText = inspectPngRegionBuffer(end.frame.png, { x: 24, y: 8, width: 70, height: 52 });
    expect(startInset.ok).toBe(true);
    expect(endInset.ok).toBe(true);
    expect(endPaddedText.ok).toBe(true);
    if (!startInset.ok || !endInset.ok || !endPaddedText.ok) return;
    expect(start.frame.sha256).not.toBe(end.frame.sha256);
    expect(startInset.luma.darkPixels).toBeGreaterThan(40);
    expect(endInset.luma.darkPixels).toBe(0);
    expect(endPaddedText.luma.darkPixels).toBeGreaterThan(40);
  });

  it("renders native text line-height keyframes at capture time", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_text_line_height_keyframes",
      background: "#000000",
      layers: [
        {
          id: "title",
          type: "text",
          text: "TOP\nBOT",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 8, y: 8, width: 180, height: 120 },
          style: { color: "#ffffff", fontSize: 28, lineHeight: 1.0 },
          keyframes: {
            "style.lineHeight": [
              { atMs: 0, value: 1.0, easing: "linear" },
              { atMs: 1000, value: 2.0 }
            ]
          }
        }
      ]
    });

    const start = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T15:35:00.000Z" });
    const end = await renderNativePreviewFrame({ packageRoot, atMs: 1000, now: () => "2026-07-02T15:35:00.000Z" });

    expect(start.ok).toBe(true);
    expect(end.ok).toBe(true);
    if (!start.ok || !end.ok) return;
    const startSecondLine = inspectPngRegionBuffer(start.frame.png, { x: 8, y: 34, width: 120, height: 20 });
    const endOldSecondLine = inspectPngRegionBuffer(end.frame.png, { x: 8, y: 34, width: 120, height: 20 });
    const endNewSecondLine = inspectPngRegionBuffer(end.frame.png, { x: 8, y: 58, width: 120, height: 24 });
    expect(startSecondLine.ok).toBe(true);
    expect(endOldSecondLine.ok).toBe(true);
    expect(endNewSecondLine.ok).toBe(true);
    if (!startSecondLine.ok || !endOldSecondLine.ok || !endNewSecondLine.ok) return;
    expect(start.frame.sha256).not.toBe(end.frame.sha256);
    expect(startSecondLine.luma.brightPixels).toBeGreaterThan(100);
    expect(endOldSecondLine.luma.brightPixels).toBeLessThan(startSecondLine.luma.brightPixels / 2);
    expect(endNewSecondLine.luma.brightPixels).toBeGreaterThan(100);
  });

  it("renders native text box borders with rounded corners", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_text_box_border_radius",
      background: "#000000",
      layers: [
        {
          id: "title",
          type: "text",
          text: "II",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 20, width: 160, height: 72 },
          style: {
            backgroundColor: "#ffffff",
            color: "#000000",
            fontSize: 28,
            padding: 16,
            borderColor: "#ff0000",
            borderWidth: 6,
            radius: 18
          }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T10:05:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const topBorder = inspectPngRegionBuffer(result.frame.png, { x: 48, y: 20, width: 90, height: 6 });
    const roundedCorner = inspectPngRegionBuffer(result.frame.png, { x: 20, y: 20, width: 8, height: 8 });
    const innerFill = inspectPngRegionBuffer(result.frame.png, { x: 42, y: 42, width: 90, height: 24 });
    expect(topBorder.ok).toBe(true);
    expect(roundedCorner.ok).toBe(true);
    expect(innerFill.ok).toBe(true);
    if (!topBorder.ok || !roundedCorner.ok || !innerFill.ok) return;
    expect(topBorder.luma.darkPixels).toBeGreaterThan(400);
    expect(topBorder.luma.brightPixels).toBeLessThan(20);
    expect(roundedCorner.luma.darkPixels).toBeGreaterThan(40);
    expect(roundedCorner.luma.brightPixels).toBe(0);
    expect(innerFill.luma.brightPixels).toBeGreaterThan(1000);
    expect(result.receipt).toMatchObject({
      operation: "preview.frame",
      status: "passed",
      warnings: []
    });
  });

  it("renders native rectangular masks for text box surfaces", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_text_rect_mask",
      background: "#000000",
      layers: [
        {
          id: "masked-title",
          type: "text",
          text: "MASK",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 20, width: 120, height: 60 },
          style: { backgroundColor: "#ffffff", color: "#000000", fontSize: 28 },
          mask: { type: "rect", inset: { top: 0, right: 0, bottom: 0, left: 60 } }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T10:45:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const clippedRegion = inspectPngRegionBuffer(result.frame.png, { x: 25, y: 30, width: 40, height: 30 });
    const visibleRegion = inspectPngRegionBuffer(result.frame.png, { x: 92, y: 30, width: 40, height: 30 });
    expect(clippedRegion.ok).toBe(true);
    expect(visibleRegion.ok).toBe(true);
    if (!clippedRegion.ok || !visibleRegion.ok) return;
    expect(clippedRegion.luma.brightPixels).toBe(0);
    expect(clippedRegion.luma.darkPixels).toBeGreaterThan(1100);
    expect(visibleRegion.luma.brightPixels).toBeGreaterThan(800);
    expect(result.receipt).toMatchObject({
      operation: "preview.frame",
      status: "passed",
      warnings: []
    });
  });

  it("renders common ASCII text as compact 5x7 glyphs instead of fallback boxes", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_ascii_glyphs",
      background: "#000000",
      layers: [
        {
          id: "thin-title",
          type: "text",
          text: "IIIIIIII",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 8, y: 8 },
          style: { color: "#ffffff", fontSize: 28 }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-01T20:10:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const quality = inspectPngBuffer(result.frame.png);
    expect(quality.ok).toBe(true);
    if (!quality.ok) return;
    expect(quality.luma.brightPixels).toBeLessThan(2200);
  });

  it("marks native text output as degraded when fallback glyph boxes are used", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_fallback_glyph_warning",
      background: "#000000",
      layers: [
        {
          id: "title",
          type: "text",
          text: "Hello @",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 8, y: 8 },
          style: { color: "#ffffff", fontSize: 28 }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-01T21:30:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([
      "Native renderer case-folded lowercase text to uppercase block glyphs on layer title: elo.",
      "Native renderer used fallback block glyphs for unsupported text characters on layer title: @."
    ]);
    expect(result.receipt).toMatchObject({
      operation: "preview.frame",
      status: "warning",
      lane: "native",
      warnings: result.warnings
    });
  });

  it("renders supported transform and opacity keyframes", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_native_transform_opacity",
      background: "#101820",
      layers: [
        {
          id: "animated_panel",
          type: "shape",
          shape: "rectangle",
          fill: "#ffffff",
          startMs: 0,
          durationMs: 1000,
          width: 160,
          height: 60,
          transform: { x: 40, y: 60, scale: 1, rotation: 0 },
          keyframes: {
            "transform.x": [
              { atMs: 0, value: 20, easing: "ease-out" },
              { atMs: 500, value: 80 },
              { atMs: 1000, value: 120 }
            ],
            opacity: [
              { atMs: 0, value: 0, easing: "ease-out" },
              { atMs: 500, value: 1 },
              { atMs: 1000, value: 0.25 }
            ]
          }
        }
      ]
    });
    const start = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-06-30T09:00:00.000Z" });
    const mid = await renderNativePreviewFrame({ packageRoot, atMs: 500, now: () => "2026-06-30T09:00:00.000Z" });
    const end = await renderNativePreviewFrame({ packageRoot, atMs: 900, now: () => "2026-06-30T09:00:00.000Z" });

    expect(start.ok).toBe(true);
    expect(mid.ok).toBe(true);
    expect(end.ok).toBe(true);
    if (!start.ok || !mid.ok || !end.ok) return;

    const startQuality = inspectPngBuffer(start.frame.png);
    const midQuality = inspectPngBuffer(mid.frame.png);
    const endQuality = inspectPngBuffer(end.frame.png);

    expect(start.frame.sha256).not.toBe(mid.frame.sha256);
    expect(mid.frame.sha256).not.toBe(end.frame.sha256);
    expect(startQuality.ok).toBe(true);
    expect(midQuality.ok).toBe(true);
    expect(endQuality.ok).toBe(true);
    if (!startQuality.ok || !midQuality.ok || !endQuality.ok) return;
    expect(startQuality.luma.brightPixels).toBeLessThan(100);
    expect(midQuality.luma.brightPixels).toBeGreaterThan(1100);
    expect(endQuality.luma.brightPixels).toBeLessThan(midQuality.luma.brightPixels);
  });

  it("renders native font weight as thicker glyphs", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_native_font_weight",
      background: "#000000",
      layers: [
        {
          id: "regular-title",
          type: "text",
          text: "IIII",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 8, y: 8 },
          style: { color: "#ffffff", fontSize: 28, fontWeight: 400 }
        },
        {
          id: "bold-title",
          type: "text",
          text: "IIII",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 8, y: 48 },
          style: { color: "#ffffff", fontSize: 28, fontWeight: 900 }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T15:05:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const regular = inspectPngRegionBuffer(result.frame.png, { x: 8, y: 8, width: 80, height: 28 });
    const bold = inspectPngRegionBuffer(result.frame.png, { x: 8, y: 48, width: 80, height: 28 });
    expect(regular.ok).toBe(true);
    expect(bold.ok).toBe(true);
    if (!regular.ok || !bold.ok) return;
    expect(bold.luma.brightPixels).toBeGreaterThan(regular.luma.brightPixels * 1.35);
  });

  it("renders native letter spacing as wider glyph placement", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_native_letter_spacing",
      background: "#000000",
      layers: [
        {
          id: "tight-title",
          type: "text",
          text: "II",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 8, y: 8 },
          style: { color: "#ffffff", fontSize: 28, letterSpacing: 0 }
        },
        {
          id: "spaced-title",
          type: "text",
          text: "II",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 8, y: 48 },
          style: { color: "#ffffff", fontSize: 28, letterSpacing: 32 }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T15:20:00.000Z" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tightFarGlyph = inspectPngRegionBuffer(result.frame.png, { x: 60, y: 8, width: 32, height: 28 });
    const spacedFarGlyph = inspectPngRegionBuffer(result.frame.png, { x: 60, y: 48, width: 32, height: 28 });
    expect(tightFarGlyph.ok).toBe(true);
    expect(spacedFarGlyph.ok).toBe(true);
    if (!tightFarGlyph.ok || !spacedFarGlyph.ok) return;
    expect(tightFarGlyph.luma.brightPixels).toBe(0);
    expect(spacedFarGlyph.luma.brightPixels).toBeGreaterThan(80);
  });

  it("renders style font-size keyframes for native text previews", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_style_font_size_keyframes",
      background: "#000000",
      layers: [
        {
          id: "title",
          type: "text",
          text: "IIII",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 8, y: 8 },
          style: { color: "#ffffff", fontSize: 14 },
          keyframes: {
            "style.fontSize": [
              { atMs: 0, value: 14, easing: "linear" },
              { atMs: 1000, value: 42 }
            ]
          }
        }
      ]
    });

    const start = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-01T22:00:00.000Z" });
    const end = await renderNativePreviewFrame({ packageRoot, atMs: 1000, now: () => "2026-07-01T22:00:00.000Z" });

    expect(start.ok).toBe(true);
    expect(end.ok).toBe(true);
    if (!start.ok || !end.ok) return;
    const startQuality = inspectPngBuffer(start.frame.png);
    const endQuality = inspectPngBuffer(end.frame.png);
    expect(startQuality.ok).toBe(true);
    expect(endQuality.ok).toBe(true);
    if (!startQuality.ok || !endQuality.ok) return;
    expect(end.frame.sha256).not.toBe(start.frame.sha256);
    expect(endQuality.luma.brightPixels).toBeGreaterThan(startQuality.luma.brightPixels * 2);
  });

  it("renders native font weight keyframes at capture time", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_style_font_weight_keyframes",
      background: "#000000",
      layers: [
        {
          id: "title",
          type: "text",
          text: "IIII",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 8, y: 8 },
          style: { color: "#ffffff", fontSize: 28, fontWeight: 400 },
          keyframes: {
            "style.fontWeight": [
              { atMs: 0, value: 400, easing: "linear" },
              { atMs: 1000, value: 900 }
            ]
          }
        }
      ]
    });

    const start = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T15:10:00.000Z" });
    const end = await renderNativePreviewFrame({ packageRoot, atMs: 1000, now: () => "2026-07-02T15:10:00.000Z" });

    expect(start.ok).toBe(true);
    expect(end.ok).toBe(true);
    if (!start.ok || !end.ok) return;
    const startQuality = inspectPngBuffer(start.frame.png);
    const endQuality = inspectPngBuffer(end.frame.png);
    expect(startQuality.ok).toBe(true);
    expect(endQuality.ok).toBe(true);
    if (!startQuality.ok || !endQuality.ok) return;
    expect(end.frame.sha256).not.toBe(start.frame.sha256);
    expect(endQuality.luma.brightPixels).toBeGreaterThan(startQuality.luma.brightPixels * 1.35);
  });

  it("renders native letter spacing keyframes at capture time", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_style_letter_spacing_keyframes",
      background: "#000000",
      layers: [
        {
          id: "title",
          type: "text",
          text: "II",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 8, y: 8 },
          style: { color: "#ffffff", fontSize: 28, letterSpacing: 0 },
          keyframes: {
            "style.letterSpacing": [
              { atMs: 0, value: 0, easing: "linear" },
              { atMs: 1000, value: 32 }
            ]
          }
        }
      ]
    });

    const start = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-02T15:25:00.000Z" });
    const end = await renderNativePreviewFrame({ packageRoot, atMs: 1000, now: () => "2026-07-02T15:25:00.000Z" });

    expect(start.ok).toBe(true);
    expect(end.ok).toBe(true);
    if (!start.ok || !end.ok) return;
    const startFarGlyph = inspectPngRegionBuffer(start.frame.png, { x: 60, y: 8, width: 32, height: 28 });
    const endFarGlyph = inspectPngRegionBuffer(end.frame.png, { x: 60, y: 8, width: 32, height: 28 });
    expect(startFarGlyph.ok).toBe(true);
    expect(endFarGlyph.ok).toBe(true);
    if (!startFarGlyph.ok || !endFarGlyph.ok) return;
    expect(start.frame.sha256).not.toBe(end.frame.sha256);
    expect(startFarGlyph.luma.brightPixels).toBe(0);
    expect(endFarGlyph.luma.brightPixels).toBeGreaterThan(80);
  });

  it("returns a structured failure for unsupported web layers", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_web",
      background: "#ffffff",
      layers: [{ id: "web-card", type: "web", startMs: 0, durationMs: 1000, src: "index.html" }]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-06-29T00:00:00.000Z" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      code: "unsupported_layer",
      message: "Native renderer cannot render 1 unsupported feature across 1 layer.",
      unsupported: [{ layerId: "web-card", feature: "layer.type:web", reason: "Lane native does not support web layers." }]
    });
    expect(result.receipt).toMatchObject({
      schema: "shellx-motion/receipt@1",
      operation: "preview.frame",
      status: "failed",
      lane: "native",
      packageId: "pkg_test",
      output: null,
      warnings: ["Lane native does not support web layers."]
    });
  });

  it("returns structured failures for unsupported features on native-supported layer types", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_unsupported_native_features",
      background: "#ffffff",
      layers: [
        {
          id: "rotating-title",
          type: "text",
          text: "Rotate",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 20, rotation: 12 }
        },
        {
          id: "freeform-panel",
          type: "shape",
          shape: "freeform",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 10, y: 10 },
          width: 80,
          height: 80,
          fill: "#111827",
          mask: { type: "rect" }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0, now: () => "2026-07-01T19:10:00.000Z" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      code: "unsupported_layer",
      message: "Native renderer cannot render 1 unsupported feature across 1 layer.",
      unsupported: [
        { layerId: "freeform-panel", feature: "shape.freeform", reason: "Lane native does not support shape.freeform on layer freeform-panel." }
      ]
    });
    expect(result.receipt).toMatchObject({
      operation: "preview.frame",
      status: "failed",
      lane: "native",
      output: null,
      warnings: [
        "Lane native does not support shape.freeform on layer freeform-panel."
      ]
    });
  });

  it("fails closed to the browser lane for structured gradients", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_gradient_browser_fallback",
      background: "#05010c",
      layers: [
        {
          id: "gradient-field",
          type: "shape",
          shape: "rounded-rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 10, y: 10, width: 80, height: 60 },
          gradient: {
            type: "linear",
            angle: 25,
            stops: [
              { offset: 0, color: "#ff006e" },
              { offset: 1, color: "#00d4ff" }
            ]
          },
          effects: { glow: { radius: 18, color: "#00d4ff" } }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0 });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "unsupported_layer",
        unsupported: [
          {
            layerId: "gradient-field",
            feature: "shape.gradient",
            reason: "Lane native does not support shape.gradient on layer gradient-field."
          },
          {
            layerId: "gradient-field",
            feature: "effect.glow",
            reason: "Lane native does not support effect.glow on layer gradient-field."
          }
        ]
      }
    });
  });

  it("fails closed to the browser lane for particle emitters", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_particles_browser_fallback",
      background: "#030712",
      layers: [
        {
          id: "spark-field",
          type: "particles",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 0, y: 0, width: 100, height: 100 },
          emitter: {
            seed: 7,
            count: 32,
            lifetimeMs: 900,
            color: "#ffffff"
          }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0 });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "unsupported_layer",
        unsupported: [
          {
            layerId: "spark-field",
            feature: "layer.type:particles",
            reason: "Lane native does not support particles layers."
          }
        ]
      }
    });
  });

  it("fails closed to the browser lane for 2D camera motion", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_camera_browser_fallback",
      layers: [
        {
          id: "camera-main",
          type: "camera",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 0, y: 0, scale: 1 },
          keyframes: {
            "transform.scale": [{ atMs: 0, value: 1 }, { atMs: 1000, value: 1.25 }]
          }
        },
        { id: "subject", type: "shape", shape: "rect", startMs: 0, durationMs: 1000 }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 500 });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "unsupported_layer",
        unsupported: [
          {
            layerId: "camera-main",
            feature: "layer.type:camera",
            reason: "Lane native does not support camera layers."
          }
        ]
      }
    });
  });

  it("fails closed to the browser lane for depth-aware camera planes", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_depth_browser_fallback",
      layers: [
        { id: "camera-main", type: "camera", startMs: 0, durationMs: 1000, transform: { x: 0, y: 0, scale: 1 } },
        { id: "background", type: "shape", shape: "rect", startMs: 0, durationMs: 1000, depth: -0.75 },
        { id: "foreground", type: "text", text: "Near", startMs: 0, durationMs: 1000, depth: 1.5 }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 500 });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "unsupported_layer",
        unsupported: [
          { layerId: "camera-main", feature: "layer.type:camera", reason: "Lane native does not support camera layers." },
          { layerId: "background", feature: "camera.depth", reason: "Lane native does not support camera.depth on layer background." },
          { layerId: "foreground", feature: "camera.depth", reason: "Lane native does not support camera.depth on layer foreground." }
        ]
      }
    });
  });

  it("fails closed to the browser lane for temporal motion blur", async () => {
    const packageRoot = await writeMotionPackage({
      id: "motion_blur_browser_fallback",
      layers: [
        {
          id: "runner",
          type: "shape",
          shape: "ellipse",
          startMs: 0,
          durationMs: 1000,
          effects: { motionBlur: { samples: 8, shutterAngle: 180 } },
          keyframes: { "transform.x": [{ atMs: 0, value: 0 }, { atMs: 1000, value: 200 }] }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 500 });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "unsupported_layer",
        unsupported: [
          {
            layerId: "runner",
            feature: "effect.motionBlur",
            reason: "Lane native does not support effect.motionBlur on layer runner."
          }
        ]
      }
    });
  });

  it("fails closed to the browser lane for film-look adjustment layers", async () => {
    const packageRoot = await writeMotionPackage({
      id: "film_adjustment_browser_fallback",
      layers: [
        { id: "subject", type: "shape", shape: "rect", startMs: 0, durationMs: 1000 },
        {
          id: "film-look",
          type: "adjustment",
          startMs: 0,
          durationMs: 1000,
          effects: {
            vignette: { amount: 0.8, softness: 0.6, color: "#000000" },
            filmGrain: { amount: 0.4, size: 2, seed: 42 }
          }
        }
      ]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 500 });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "unsupported_layer",
        unsupported: [
          {
            layerId: "film-look",
            feature: "layer.type:adjustment",
            reason: "Lane native does not support adjustment layers."
          }
        ]
      }
    });
  });

  it("fails closed to the browser lane for restricted shader plugins", async () => {
    const packageRoot = await writeMotionPackage({
      id: "shader_browser_fallback",
      layers: [{ id: "plasma", type: "shader", startMs: 0, durationMs: 1000 }]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 500 });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "unsupported_layer",
        unsupported: [{ layerId: "plasma", feature: "layer.type:shader", reason: "Lane native does not support shader layers." }]
      }
    });
  });

  it("fails closed to the browser lane for fixed scene3d layers", async () => {
    const packageRoot = await writeMotionPackage({
      id: "scene3d_browser_fallback",
      layers: [{ id: "stage", type: "scene3d", startMs: 0, durationMs: 1000 }]
    });

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 500 });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "unsupported_layer",
        unsupported: [{ layerId: "stage", feature: "layer.type:scene3d", reason: "Lane native does not support scene3d layers." }]
      }
    });
  });
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "shellx-renderer-native-"));
  tempDirs.push(dir);
  return dir;
}

async function writeMotionPackage(input: {
  id: string;
  width?: number;
  height?: number;
  background?: string;
  layers: Array<Record<string, unknown>>;
  designTokens?: Record<string, unknown>;
}): Promise<string> {
  const root = await makeTempDir();
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify(
      {
        schema: "shellx-motion/package-manifest@1",
        id: "pkg_test",
        name: "Test Package",
        motion: "motion.json",
        assets: [],
        sourceApp: "shellx-motion",
        compatibility: { lanes: ["native"], hosts: ["motion"] }
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify(
      {
        schema: "shellx-motion/motion@1",
        id: input.id,
        name: input.id,
        durationMs: 1000,
        fps: 30,
        width: input.width ?? 320,
        height: input.height ?? 180,
        ...(input.background === undefined ? {} : { background: input.background }),
        layers: input.layers,
        assets: [],
        designTokens: input.designTokens ?? {},
        provenance: { sourceApp: "shellx-motion", createdBy: "test" }
      },
      null,
      2
    )}\n`
  );
  return resolve(root);
}

function readPngChunkTypes(png: Buffer): string[] {
  const types: string[] = [];
  let offset = 8;

  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const nextOffset = offset + 12 + length;
    expect(nextOffset).toBeLessThanOrEqual(png.length);
    types.push(type);
    offset = nextOffset;
    if (type === "IEND") break;
  }

  expect(offset).toBe(png.length);
  return types;
}

function readPngChunkData(png: Buffer, wantedType: string): Buffer {
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const data = png.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === wantedType) return data;
    if (type === "IEND") break;
  }
  throw new Error(`PNG chunk not found: ${wantedType}`);
}

function readPngPixel(png: Buffer, x: number, y: number): { r: number; g: number; b: number; a: number } {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  expect(x).toBeGreaterThanOrEqual(0);
  expect(x).toBeLessThan(width);
  expect(y).toBeGreaterThanOrEqual(0);
  expect(y).toBeLessThan(height);
  const data = inflateSync(readPngChunkData(png, "IDAT"));
  const rowStride = 1 + width * 4;
  const rowStart = y * rowStride;
  expect(data[rowStart]).toBe(0);
  const offset = rowStart + 1 + x * 4;
  return {
    r: data[offset],
    g: data[offset + 1],
    b: data[offset + 2],
    a: data[offset + 3]
  };
}

function makeRgbaPngFixture(width: number, height: number, pixels: Array<{ r: number; g: number; b: number; a: number }>): Buffer {
  expect(pixels).toHaveLength(width * height);
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    scanlines[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixel = pixels[y * width + x];
      const offset = rowStart + 1 + x * 4;
      scanlines[offset] = pixel.r;
      scanlines[offset + 1] = pixel.g;
      scanlines[offset + 2] = pixel.b;
      scanlines[offset + 3] = pixel.a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngFixtureChunk("IHDR", ihdr),
    pngFixtureChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngFixtureChunk("IEND", Buffer.alloc(0))
  ]);
}

function pngFixtureChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32Fixture(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

const CRC_FIXTURE_TABLE = createCrcFixtureTable();

function createCrcFixtureTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function crc32Fixture(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_FIXTURE_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function channelRange(pixel: { r: number; g: number; b: number }): number {
  return Math.max(pixel.r, pixel.g, pixel.b) - Math.min(pixel.r, pixel.g, pixel.b);
}
