import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMotionPackage } from "@shellx-motion/core";
import { convertCanvasFrameToMotionPackage } from "./index";
import { writeCanvasMotionPackage } from "./package-writer";

const tempDirs: string[] = [];

describe("Canvas Motion package writer", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("materializes a Canvas export as a loadable Motion package with receipt evidence", async () => {
    const fixture = JSON.parse(await readFile(resolve("../../fixtures/canvas/frame-selection.json"), "utf8")) as unknown;
    const canvasExport = convertCanvasFrameToMotionPackage(fixture, {
      createdAt: "2026-06-30T00:00:00.000Z"
    });
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-package-"));
    tempDirs.push(outDir);

    const written = await writeCanvasMotionPackage(canvasExport, { packageDir: outDir });
    const loaded = await loadMotionPackage(outDir);
    const receipt = JSON.parse(await readFile(written.receiptPath, "utf8")) as Record<string, unknown>;
    const resourceCatalog = JSON.parse(await readFile(written.resourceCatalogPath, "utf8")) as Record<string, unknown>;

    expect(written).toEqual({
      packageDir: outDir,
      manifestPath: join(outDir, "manifest.json"),
      motionPath: join(outDir, "motion.json"),
      receiptPath: join(outDir, "receipts", "canvas-export.receipt.json"),
      resourceCatalogPath: join(outDir, "resource-catalog.json"),
      assetRefs: ["assets/product-retouched.png"],
      copiedAssetRefs: [],
      missingAssetRefs: []
    });
    expect(loaded.manifest.id).toBe("pkg_canvas_launch_campaign_frame_story_hero");
    expect(loaded.motion.id).toBe("motion_canvas_frame_story_hero");
    expect(resourceCatalog).toMatchObject({
      schema: "shellx-motion/resource-catalog@1",
      packageId: "pkg_canvas_launch_campaign_frame_story_hero",
      sourceApp: "shellx-canvas",
      resources: [
        {
          id: "pkg_canvas_launch_campaign_frame_story_hero",
          ref: ".",
          kind: "motion_package",
          source: {
            app: "shellx-canvas",
            sourceFrameId: "frame_story_hero",
            receiptId: "receipt_canvas_export_frame_story_hero"
          }
        },
        {
          id: "asset_product_retouched",
          ref: "assets/product-retouched.png",
          kind: "image",
          mimeType: "image/png",
          source: {
            app: "shellx-canvas/image-editor",
            sourceFrameId: "frame_story_hero"
          }
        }
      ]
    });
    expect(receipt).toMatchObject({
      schema: "shellx-motion/receipt@1",
      operation: "export.final",
      status: "passed",
      packageId: "pkg_canvas_launch_campaign_frame_story_hero",
      lane: "canvas"
    });
  });

  it("copies Canvas image assets into the package when a source root is provided", async () => {
    const fixture = JSON.parse(await readFile(resolve("../../fixtures/canvas/frame-selection.json"), "utf8")) as Record<string, any>;
    const sourceRoot = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-source-"));
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-package-assets-"));
    tempDirs.push(sourceRoot, outDir);
    await mkdir(join(sourceRoot, "assets"), { recursive: true });
    await writeFile(join(sourceRoot, "assets", "product-retouched.png"), SAMPLE_PNG);
    fixture.imageEditorOutputs[0].sha256 = SAMPLE_PNG_SHA256;
    const canvasExport = convertCanvasFrameToMotionPackage(fixture, {
      createdAt: "2026-06-30T00:00:00.000Z"
    });

    const written = await writeCanvasMotionPackage(canvasExport, { packageDir: outDir, sourceRoot });

    expect(written).toMatchObject({
      copiedAssetRefs: ["assets/product-retouched.png"],
      missingAssetRefs: []
    });
    await expect(readFile(join(outDir, "assets", "product-retouched.png"))).resolves.toEqual(SAMPLE_PNG);
  });

  it("rejects copied Canvas assets whose bytes do not match the declared hash", async () => {
    const fixture = JSON.parse(await readFile(resolve("../../fixtures/canvas/frame-selection.json"), "utf8")) as unknown;
    const sourceRoot = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-source-mismatch-"));
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-package-mismatch-"));
    tempDirs.push(sourceRoot, outDir);
    await mkdir(join(sourceRoot, "assets"), { recursive: true });
    await writeFile(join(sourceRoot, "assets", "product-retouched.png"), SAMPLE_PNG);
    const canvasExport = convertCanvasFrameToMotionPackage(fixture, {
      createdAt: "2026-06-30T00:00:00.000Z"
    });

    await expect(writeCanvasMotionPackage(canvasExport, { packageDir: outDir, sourceRoot }))
      .rejects
      .toThrow(`Canvas asset hash mismatch for assets/product-retouched.png: expected 0f6b7b32792c8f8217a78fd375d2f26d51e39bf25f21b8c07b9713f22b3c4f4a, got ${SAMPLE_PNG_SHA256}.`);
    await expect(readFile(join(outDir, "assets", "product-retouched.png"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("copies Canvas assets with legacy non-SHA256 hash placeholders without verification", async () => {
    const fixture = JSON.parse(await readFile(resolve("../../fixtures/canvas/frame-selection.json"), "utf8")) as Record<string, any>;
    const sourceRoot = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-source-placeholder-"));
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-package-placeholder-"));
    tempDirs.push(sourceRoot, outDir);
    await mkdir(join(sourceRoot, "assets"), { recursive: true });
    await writeFile(join(sourceRoot, "assets", "product-retouched.png"), SAMPLE_PNG);
    fixture.imageEditorOutputs[0].sha256 = "legacy-placeholder";
    const canvasExport = convertCanvasFrameToMotionPackage(fixture, {
      createdAt: "2026-06-30T00:00:00.000Z"
    });

    const written = await writeCanvasMotionPackage(canvasExport, { packageDir: outDir, sourceRoot });

    expect(written).toMatchObject({
      copiedAssetRefs: ["assets/product-retouched.png"],
      missingAssetRefs: []
    });
    await expect(readFile(join(outDir, "assets", "product-retouched.png"))).resolves.toEqual(SAMPLE_PNG);
  });
});

const SAMPLE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);

const SAMPLE_PNG_SHA256 = "4b5c5c92cec3b23e6a294fc0eea43234ef5126c5a64f4c6c531ac8430ab0b844";
