import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { convertCanvasFrameToMotionPackage } from "./index";
import { writeCanvasMotionPackage } from "./package-writer";

const tempDirs: string[] = [];
const itLinux = process.platform === "linux" ? it : it.skip;

describe("Canvas Motion package writer", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("requires an explicit source root before a declared asset can be admitted", async () => {
    const fixture = JSON.parse(await readFile(resolve("../../fixtures/canvas/frame-selection.json"), "utf8")) as unknown;
    const canvasExport = convertCanvasFrameToMotionPackage(fixture, {
      createdAt: "2026-06-30T00:00:00.000Z"
    });
    const outDir = await mkdtemp(join(process.cwd(), ".tmp-shellx-motion-canvas-package-"));
    tempDirs.push(outDir);

    await expect(writeCanvasMotionPackage(canvasExport, { packageDir: outDir }))
      .rejects.toThrow("Canvas package assets require an explicit host-approved sourceRoot.");
    await expect(readFile(join(outDir, "manifest.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  itLinux("copies Canvas image assets into the package when a source root is provided", async () => {
    const fixture = JSON.parse(await readFile(resolve("../../fixtures/canvas/frame-selection.json"), "utf8")) as Record<string, any>;
    const sourceRoot = await mkdtemp(join(process.cwd(), ".tmp-shellx-motion-canvas-source-"));
    const outDir = await mkdtemp(join(process.cwd(), ".tmp-shellx-motion-canvas-package-assets-"));
    tempDirs.push(sourceRoot, outDir);
    await mkdir(join(sourceRoot, "assets"), { recursive: true, mode: 0o700 });
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
    const sourceRoot = await mkdtemp(join(process.cwd(), ".tmp-shellx-motion-canvas-source-mismatch-"));
    const outDir = await mkdtemp(join(process.cwd(), ".tmp-shellx-motion-canvas-package-mismatch-"));
    tempDirs.push(sourceRoot, outDir);
    await mkdir(join(sourceRoot, "assets"), { recursive: true, mode: 0o700 });
    await writeFile(join(sourceRoot, "assets", "product-retouched.png"), SAMPLE_PNG);
    const canvasExport = convertCanvasFrameToMotionPackage(fixture, {
      createdAt: "2026-06-30T00:00:00.000Z"
    });

    await expect(writeCanvasMotionPackage(canvasExport, { packageDir: outDir, sourceRoot }))
      .rejects
      .toThrow(`Canvas asset hash mismatch for assets/product-retouched.png: expected 0f6b7b32792c8f8217a78fd375d2f26d51e39bf25f21b8c07b9713f22b3c4f4a, got ${SAMPLE_PNG_SHA256}.`);
    await expect(readFile(join(outDir, "assets", "product-retouched.png"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  itLinux("copies Canvas assets with legacy non-SHA256 hash placeholders without verification", async () => {
    const fixture = JSON.parse(await readFile(resolve("../../fixtures/canvas/frame-selection.json"), "utf8")) as Record<string, any>;
    const sourceRoot = await mkdtemp(join(process.cwd(), ".tmp-shellx-motion-canvas-source-placeholder-"));
    const outDir = await mkdtemp(join(process.cwd(), ".tmp-shellx-motion-canvas-package-placeholder-"));
    tempDirs.push(sourceRoot, outDir);
    await mkdir(join(sourceRoot, "assets"), { recursive: true, mode: 0o700 });
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

  it("refuses symlinked Canvas source parents before it publishes a package", async () => {
    const fixture = JSON.parse(await readFile(resolve("../../fixtures/canvas/frame-selection.json"), "utf8")) as Record<string, any>;
    const sourceRoot = await mkdtemp(join(process.cwd(), ".tmp-shellx-motion-canvas-source-link-"));
    const outsideRoot = await mkdtemp(join(process.cwd(), ".tmp-shellx-motion-canvas-source-link-outside-"));
    const outDir = await mkdtemp(join(process.cwd(), ".tmp-shellx-motion-canvas-package-link-"));
    tempDirs.push(sourceRoot, outsideRoot, outDir);
    await mkdir(join(outsideRoot, "assets"), { recursive: true, mode: 0o700 });
    await writeFile(join(outsideRoot, "assets", "product-retouched.png"), SAMPLE_PNG);
    await symlink(join(outsideRoot, "assets"), join(sourceRoot, "assets"), process.platform === "win32" ? "junction" : "dir");
    fixture.imageEditorOutputs[0].sha256 = SAMPLE_PNG_SHA256;
    const canvasExport = convertCanvasFrameToMotionPackage(fixture);

    await expect(writeCanvasMotionPackage(canvasExport, { packageDir: outDir, sourceRoot }))
      .rejects.toThrow(/symlinked or non-directory parent/);
    await expect(readFile(join(outDir, "manifest.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  itLinux("refuses staged Canvas destinations that are existing files or symlinks", async () => {
    const fixture = JSON.parse(await readFile(resolve("../../fixtures/canvas/frame-selection.json"), "utf8")) as Record<string, any>;
    const sourceRoot = await mkdtemp(join(process.cwd(), ".tmp-shellx-motion-canvas-source-destination-"));
    const outsideRoot = await mkdtemp(join(process.cwd(), ".tmp-shellx-motion-canvas-destination-outside-"));
    const outDir = await mkdtemp(join(process.cwd(), ".tmp-shellx-motion-canvas-package-destination-"));
    tempDirs.push(sourceRoot, outsideRoot, outDir);
    await mkdir(join(sourceRoot, "assets"), { recursive: true, mode: 0o700 });
    await writeFile(join(sourceRoot, "assets", "product-retouched.png"), SAMPLE_PNG);
    await writeFile(join(outsideRoot, "keep.png"), "do-not-touch", "utf8");
    await mkdir(join(outDir, "assets"), { recursive: true, mode: 0o700 });
    await symlink(join(outsideRoot, "keep.png"), join(outDir, "assets", "product-retouched.png"), "file");
    fixture.imageEditorOutputs[0].sha256 = SAMPLE_PNG_SHA256;
    const canvasExport = convertCanvasFrameToMotionPackage(fixture);

    await expect(writeCanvasMotionPackage(canvasExport, { packageDir: outDir, sourceRoot }))
      .rejects.toThrow(/not empty/i);
    await expect(readFile(join(outsideRoot, "keep.png"), "utf8")).resolves.toBe("do-not-touch");
  });
});

const SAMPLE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);

const SAMPLE_PNG_SHA256 = "4b5c5c92cec3b23e6a294fc0eea43234ef5126c5a64f4c6c531ac8430ab0b844";
