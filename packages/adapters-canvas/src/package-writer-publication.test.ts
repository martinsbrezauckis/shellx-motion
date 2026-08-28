import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";

const faults = vi.hoisted(() => ({ writeLabel: undefined as string | undefined }));

vi.mock("@shellx-motion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shellx-motion/core")>();
  return {
    ...actual,
    writeVerifiedBoundedFile: async (path: string, bytes: Buffer, options: { label?: string }) => {
      if (faults.writeLabel === options.label) throw new Error(`injected late package write failure: ${options.label}`);
      return await actual.writeVerifiedBoundedFile(path, bytes, options as any);
    }
  };
});

import { hashBuffer, loadMotionPackage } from "@shellx-motion/core";
import { CANVAS_FIXTURE_EXAMPLE, convertCanvasFrameToMotionPackage } from "./index";
import { writeCanvasMotionPackage } from "./package-writer";

const roots: string[] = [];
const itLinux = process.platform === "linux" ? it : it.skip;

afterEach(async () => {
  faults.writeLabel = undefined;
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

it("keeps staging mutation out of the exported package-writer options", async () => {
  const source = await readFile(new URL("./package-writer.ts", import.meta.url), "utf8");
  const options = source.slice(source.indexOf("export interface WriteCanvasMotionPackageOptions"), source.indexOf("export interface CanvasPackageAssetEvidence"));

  expect(options).not.toMatch(/beforeCommit|finalizeReceipt|stagingPath/);
  expect(source).toContain("requireClosedTree: true");
  expect(source).toContain("await transaction.commit(expectedInventory)");
});

describe("Canvas package closed publication", () => {
  itLinux("commits one exact package tree with image-editor and layer-only asset evidence", async () => {
    const root = await workspace();
    const sourceRoot = join(root, "source");
    const packageDir = join(root, "package");
    const imageBytes = Buffer.from("image-editor bytes\n");
    const layerBytes = Buffer.from("package-only layer bytes\n");
    await mkdir(join(sourceRoot, "assets"), { recursive: true, mode: 0o700 });
    await writeFile(join(sourceRoot, "assets", "product-retouched.png"), imageBytes);
    await writeFile(join(sourceRoot, "assets", "layer-only.bin"), layerBytes);
    const fixture = JSON.parse(await readFile(resolve("../../fixtures/canvas/frame-selection.json"), "utf8")) as Record<string, any>;
    fixture.imageEditorOutputs[0].sha256 = hashBuffer(imageBytes);
    fixture.frames[0].layers.push({ id: "layer-only", kind: "image", assetRef: "assets/layer-only.bin", startMs: 0, durationMs: 5_000 });
    const canvasExport = convertCanvasFrameToMotionPackage(fixture, { createdAt: "2026-08-22T00:00:00.000Z", inputPath: "selection.json" });

    const written = await trusted(root, () => writeCanvasMotionPackage(canvasExport, { packageDir, sourceRoot }));
    const loaded = await trusted(root, () => loadMotionPackage(packageDir));
    const receipt = JSON.parse(await readFile(written.receiptPath, "utf8")) as Record<string, any>;
    const catalog = JSON.parse(await readFile(written.resourceCatalogPath, "utf8")) as Record<string, any>;

    expect(loaded.manifest.assets).toEqual(["assets/product-retouched.png", "assets/layer-only.bin"]);
    expect(written).toMatchObject({
      copiedAssetRefs: ["assets/product-retouched.png", "assets/layer-only.bin"],
      missingAssetRefs: [],
      assetEvidence: [
        { assetRef: "assets/product-retouched.png", sha256: hashBuffer(imageBytes), byteLength: imageBytes.byteLength, role: "canvas_image_editor_asset" },
        { assetRef: "assets/layer-only.bin", sha256: hashBuffer(layerBytes), byteLength: layerBytes.byteLength, role: "canvas_package_layer_asset" }
      ]
    });
    expect(receipt.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "motion_package", path: ".", status: "available", primary: true }),
      expect.objectContaining({ role: "canvas_frame_selection", path: "selection.json", status: "available" })
    ]));
    expect(receipt.output).toMatchObject({
      packageRoot: ".",
      manifestPath: "manifest.json",
      motionPath: "motion.json",
      receiptPath: "receipts/canvas-export.receipt.json",
      resourceCatalogPath: "resource-catalog.json",
      packageContentHashes: {
        "manifest.json": { sha256: expect.stringMatching(/^[a-f0-9]{64}$/), byteLength: expect.any(Number) },
        "motion.json": { sha256: expect.stringMatching(/^[a-f0-9]{64}$/), byteLength: expect.any(Number) },
        "resource-catalog.json": { sha256: expect.stringMatching(/^[a-f0-9]{64}$/), byteLength: expect.any(Number) }
      },
      missingAssetRefs: [],
      assetEvidence: expect.arrayContaining([
        expect.objectContaining({ assetRef: "assets/layer-only.bin", sha256: hashBuffer(layerBytes), role: "canvas_package_layer_asset" })
      ])
    });
    expect(catalog.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ ref: "assets/product-retouched.png", sha256: hashBuffer(imageBytes) }),
      expect.objectContaining({ ref: "assets/layer-only.bin", kind: "package_layer_asset", sha256: hashBuffer(layerBytes), byteLength: layerBytes.byteLength })
    ]));
  });

  itLinux("refuses missing or pre-populated output before any complete package is published", async () => {
    const root = await workspace();
    const sourceRoot = join(root, "source");
    const packageDir = join(root, "package");
    await mkdir(sourceRoot, { recursive: true, mode: 0o700 });
    const fixture = JSON.parse(await readFile(resolve("../../fixtures/canvas/frame-selection.json"), "utf8")) as Record<string, any>;
    const canvasExport = convertCanvasFrameToMotionPackage(fixture, { createdAt: "2026-08-22T00:00:00.000Z" });

    await expect(trusted(root, () => writeCanvasMotionPackage(canvasExport, { packageDir, sourceRoot })))
      .rejects.toThrow(/missing declared assets/i);
    await expect(readFile(join(packageDir, "manifest.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await mkdir(packageDir, { recursive: true, mode: 0o700 });
    await writeFile(join(packageDir, "sentinel.txt"), "preserve\n", "utf8");
    await expect(trusted(root, () => writeCanvasMotionPackage({ ...canvasExport, manifest: { ...canvasExport.manifest, assets: [] }, motion: { ...canvasExport.motion, assets: [] } }, { packageDir })))
      .rejects.toThrow(/not empty/i);
    await expect(readFile(join(packageDir, "sentinel.txt"), "utf8")).resolves.toBe("preserve\n");
  });

  itLinux("publishes to a caller-provided empty directory", async () => {
    const root = await workspace();
    const packageDir = join(root, "empty-package");
    await mkdir(packageDir, { recursive: true, mode: 0o700 });
    const canvasExport = convertCanvasFrameToMotionPackage(structuredClone(CANVAS_FIXTURE_EXAMPLE), {
      createdAt: "2026-08-22T00:00:00.000Z"
    });

    await expect(trusted(root, () => writeCanvasMotionPackage(canvasExport, { packageDir }))).resolves.toMatchObject({
      packageDir,
      missingAssetRefs: []
    });
  });

  it("requires a source root for any declared asset before output transaction admission", async () => {
    const root = await workspace();
    const canvasExport = convertCanvasFrameToMotionPackage(JSON.parse(await readFile(resolve("../../fixtures/canvas/frame-selection.json"), "utf8")), {
      createdAt: "2026-08-22T00:00:00.000Z"
    });
    await expect(trusted(root, () => writeCanvasMotionPackage(canvasExport, { packageDir: join(root, "package") })))
      .rejects.toThrow(/explicit host-approved sourceRoot/i);
  });

  itLinux.each([
    ["catalog", "Canvas package resource-catalog.json"],
    ["receipt", "Canvas package receipts/canvas-export.receipt.json"],
    ["asset", "Canvas package asset assets/product-retouched.png"]
  ])("leaves no public package when the late %s write fails", async (_kind, label) => {
    const root = await workspace();
    const sourceRoot = join(root, "source");
    const packageDir = join(root, "package");
    const asset = Buffer.from("late write asset\n");
    await mkdir(join(sourceRoot, "assets"), { recursive: true, mode: 0o700 });
    await writeFile(join(sourceRoot, "assets", "product-retouched.png"), asset);
    const fixture = JSON.parse(await readFile(resolve("../../fixtures/canvas/frame-selection.json"), "utf8")) as Record<string, any>;
    fixture.imageEditorOutputs[0].sha256 = hashBuffer(asset);
    const canvasExport = convertCanvasFrameToMotionPackage(fixture, { createdAt: "2026-08-22T00:00:00.000Z" });
    faults.writeLabel = label;

    await expect(trusted(root, () => writeCanvasMotionPackage(canvasExport, { packageDir, sourceRoot })))
      .rejects.toThrow(`injected late package write failure: ${label}`);
    await expect(stat(packageDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform !== "linux")("refuses unsupported closed-tree publication without exposing a package", async () => {
    const root = await workspace();
    const packageDir = join(root, "unsupported-package");
    const canvasExport = convertCanvasFrameToMotionPackage(structuredClone(CANVAS_FIXTURE_EXAMPLE), {
      createdAt: "2026-08-22T00:00:00.000Z"
    });

    await expect(writeCanvasMotionPackage(canvasExport, { packageDir }))
      .rejects.toThrow(/closed-tree publication requires a Linux descriptor-relative primitive/i);
    await expect(stat(packageDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), ".tmp-shellx-motion-canvas-publication-"));
  roots.push(root);
  return root;
}

async function trusted<T>(root: string, action: () => Promise<T>): Promise<T> {
  if (process.platform === "win32") return await action();
  return await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), action);
}
