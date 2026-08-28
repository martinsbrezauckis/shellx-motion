import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeRgbaPng, type MotionPackage } from "@shellx-motion/core";
import { describe, expect, it } from "vitest";
import { GpuSceneResourceError, prepareGpuSceneResources } from "./gpu-scene-resources";

describe("prepareGpuSceneResources", () => {
  it("takes one bounded exact PNG snapshot and deduplicates repeated layers", async () => {
    const root = await mkdtemp(join(tmpdir(), "motion-gpu-images-")); await mkdir(join(root, "assets"), { mode: 0o700 });
    const rgba = Buffer.from([255, 0, 0, 255, 0, 255, 0, 128]);
    await writeFile(join(root, "assets", "hero.png"), encodeRgbaPng(2, 1, rgba), { mode: 0o600 });
    const prepared = await prepareGpuSceneResources(pkg(root, [
      { id: "hero-a", type: "image", assetRef: "assets/hero.png", startMs: 0, durationMs: 1_000 },
      { id: "hero-b", type: "image", assetRef: "assets/hero.png", startMs: 200, durationMs: 500 }
    ]));
    expect(prepared.images.size).toBe(1); expect(prepared.sessionImages).toHaveLength(1);
    expect(prepared.fonts.size).toBe(0); expect(prepared.sessionFonts).toHaveLength(0);
    expect(prepared.images.get("assets/hero.png")).toMatchObject({ width: 2, height: 1, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(prepared.sessionImages[0].rgba).toEqual(rgba);
    expect(prepared.inputHashes["assets/hero.png"]).toBe(prepared.sessionImages[0].sha256);
  });

  it("refuses a linked package asset before decoding", async () => {
    const root = await mkdtemp(join(tmpdir(), "motion-gpu-images-link-")); await mkdir(join(root, "assets"), { mode: 0o700 });
    const outside = join(root, "outside.png"); await writeFile(outside, encodeRgbaPng(1, 1, Buffer.from([1, 2, 3, 255])), { mode: 0o600 });
    await symlink(outside, join(root, "assets", "hero.png"));
    await expect(prepareGpuSceneResources(pkg(root, [{ id: "hero", type: "image", assetRef: "assets/hero.png", startMs: 0, durationMs: 1_000 }]))).rejects.toBeInstanceOf(GpuSceneResourceError);
  });

  it("binds bounded JPEG, WebP, and static SVG snapshots for decode only inside the retained GPU page", async () => {
    const root = await mkdtemp(join(tmpdir(), "motion-gpu-image-formats-")); await mkdir(join(root, "assets"), { mode: 0o700 });
    const jpeg = jpegFixture(3, 2); const webp = webpFixture(3, 2);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="3" height="2"><rect width="3" height="2" fill="#22c55e"/></svg>');
    await writeFile(join(root, "assets", "photo.jpg"), jpeg, { mode: 0o600 });
    await writeFile(join(root, "assets", "poster.webp"), webp, { mode: 0o600 });
    await writeFile(join(root, "assets", "brand.svg"), svg, { mode: 0o600 });
    const prepared = await prepareGpuSceneResources(pkg(root, [
      { id: "photo", type: "image", assetRef: "assets/photo.jpg", startMs: 0, durationMs: 1_000 },
      { id: "poster", type: "image", assetRef: "assets/poster.webp", startMs: 0, durationMs: 1_000 },
      { id: "brand", type: "image", assetRef: "assets/brand.svg", startMs: 0, durationMs: 1_000 }
    ], ["assets/photo.jpg", "assets/poster.webp", "assets/brand.svg"]));
    expect(prepared.sessionImages).toEqual(expect.arrayContaining([
      expect.objectContaining({ width: 3, height: 2, bytes: jpeg, mimeType: "image/jpeg" }),
      expect.objectContaining({ width: 3, height: 2, bytes: webp, mimeType: "image/webp" }),
      expect.objectContaining({ width: 3, height: 2, bytes: svg, mimeType: "image/svg+xml", staticSvg: true })
    ]));
    expect(prepared.sessionImages.every((image) => image.rgba === undefined)).toBe(true);
  });

  it("refuses hostile static SVG before a GPU page can receive its package bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "motion-gpu-svg-refusal-")); await mkdir(join(root, "assets"), { mode: 0o700 });
    await writeFile(join(root, "assets", "hostile.svg"), '<svg width="3" height="2"><image href="https://example.invalid/pixel.png"/></svg>', { mode: 0o600 });
    await expect(prepareGpuSceneResources(pkg(root, [{ id: "hostile", type: "image", assetRef: "assets/hostile.svg", startMs: 0, durationMs: 1_000 }], ["assets/hostile.svg"]))).rejects.toThrow(/external references/i);
  });

  it("refuses the aggregate decoded-image budget before opening the contained GPU page", async () => {
    const root = await mkdtemp(join(tmpdir(), "motion-gpu-image-budget-")); await mkdir(join(root, "assets"), { mode: 0o700 });
    const assetRefs = Array.from({ length: 9 }, (_, index) => `assets/full-${index}.jpg`);
    await Promise.all(assetRefs.map(async (assetRef) => await writeFile(join(root, assetRef), jpegFixture(3840, 2160), { mode: 0o600 })));
    const layers = assetRefs.map((assetRef, index) => ({ id: `full-${index}`, type: "image" as const, assetRef, startMs: 0, durationMs: 1_000 }));
    await expect(prepareGpuSceneResources(pkg(root, layers, assetRefs))).rejects.toThrow(/256 MiB decoded session budget/);
  });
});

function pkg(root: string, layers: MotionPackage["motion"]["layers"], assets: string[] = ["assets/hero.png"]): MotionPackage {
  return { root, manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_gpu_images", name: "GPU images", motion: "motion.json", assets, sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } }, motion: { schema: "shellx-motion/motion@1", id: "motion_gpu_images", name: "GPU images", durationMs: 1_000, fps: 30, width: 64, height: 64, layers, assets: [], provenance: { sourceApp: "test", createdBy: "test" } } };
}

function jpegFixture(width: number, height: number): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x08, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x11, 0x00, 0xff, 0xd9]);
}

function webpFixture(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii"); bytes.writeUInt32LE(bytes.byteLength - 8, 4); bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8X", 12, "ascii"); bytes.writeUInt32LE(10, 16);
  bytes[24] = (width - 1) & 0xff; bytes[25] = ((width - 1) >>> 8) & 0xff; bytes[26] = ((width - 1) >>> 16) & 0xff;
  bytes[27] = (height - 1) & 0xff; bytes[28] = ((height - 1) >>> 8) & 0xff; bytes[29] = ((height - 1) >>> 16) & 0xff;
  return bytes;
}
