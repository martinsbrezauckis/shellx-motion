/** Atomic dotLottie package authoring and provenance convergence tests. */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectPngBuffer, inspectPngRegionBuffer, loadMotionPackage } from "@shellx-motion/core";
import { renderMotionBrowserFrame } from "@shellx-motion/renderer-browser";
import { writeStaticDotLottiePackage } from "./authoring-dotlottie-package.js";

const lottieFixturePath = resolve("../../fixtures/imports/lottie-static-shape/input.json");
const onePixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64");

describe("atomic dotLottie package authoring", () => {
  it("preserves archive and selected animation bytes in one renderable provenance-bound package", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-dotlottie-package-"));
    const sourcePath = join(root, "input", "fixture.lottie");
    const outputRoot = join(root, "packages", "dotlottie-import");
    try {
      await mkdir(dirname(sourcePath), { recursive: true });
      await mkdir(dirname(outputRoot), { recursive: true });
      const animationBytes = await readFile(lottieFixturePath);
      const archive = storedZip([
        { path: "manifest.json", bytes: Buffer.from(JSON.stringify({ version: "2", initial: { animation: "hero" }, animations: [{ id: "hero" }] })) },
        { path: "a/hero.json", bytes: animationBytes }
      ]);
      await writeFile(sourcePath, archive);

      const result = await writeStaticDotLottiePackage({
        sourcePath,
        outputRoot,
        inputRoots: [dirname(sourcePath)],
        outputRoots: [root],
        createdBy: "dotlottie-package-test",
        createdAt: "2026-07-12T08:30:00.000Z"
      });
      const manifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as Record<string, any>;
      const diagnostics = JSON.parse(await readFile(result.diagnosticsReceiptPath, "utf8")) as Record<string, any>;
      const lowered = JSON.parse(await readFile(result.loweringReceiptPath, "utf8")) as Record<string, any>;
      const pkg = await loadMotionPackage(result.packageRoot);
      const render = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir: join(root, "render") });
      const quality = inspectPngBuffer(await readFile(render.output.path));

      expect((await readFile(result.sourcePath)).equals(archive)).toBe(true);
      expect((await readFile(result.selectedAnimationPath)).equals(animationBytes)).toBe(true);
      expect(result.selection).toMatchObject({ version: "2", animationId: "hero", animationPath: "a/hero.json", selectionSource: "manifest-default" });
      expect(manifest).toMatchObject({
        sourceApp: "dotlottie",
        data: {
          adapter: {
            source: "source/input.lottie",
            sourceSha256: result.selection.archiveSha256,
            loweringSource: "source/selected-animation.json",
            loweringSourceSha256: result.selection.animationSha256,
            container: {
              schema: "shellx-motion/dotlottie-source@1",
              version: "2",
              animationId: "hero",
              manifestSha256: result.selection.manifestSha256
            }
          }
        }
      });
      expect(pkg.motion.provenance).toMatchObject({ sourceApp: "dotlottie", createdBy: "dotlottie-package-test" });
      expect(diagnostics.inputHashes.source).toBe(result.selection.animationSha256);
      expect(lowered.inputHashes.source).toBe(result.selection.animationSha256);
      expect(result.motionSha256).toBe(lowered.output.motionSha256);
      expect(quality.ok).toBe(true);
      if (quality.ok) {
        expect(quality.blank).toBe(false);
        expect(quality.edges.pixels).toBeGreaterThan(50);
      }
      if (process.platform !== "win32") {
        expect((await stat(result.sourcePath)).mode & 0o777).toBe(0o600);
        expect((await stat(result.selectedAnimationPath)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("installs only selected bundled images and renders their package-bound bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-dotlottie-images-"));
    const sourcePath = join(root, "fixture.lottie");
    const outputRoot = join(root, "package");
    try {
      const animation = Buffer.from(JSON.stringify({
        v: "5.12.2", fr: 30, ip: 0, op: 30, w: 100, h: 100, nm: "Bundled image",
        assets: [{ id: "logo", w: 64, h: 64, u: "", p: "i/logo.png", e: 0 }],
        layers: [{ ind: 1, ty: 2, nm: "Logo", refId: "logo", ip: 0, op: 30, ks: { p: { a: 0, k: [18, 18] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } } }]
      }));
      const archive = storedZip([
        { path: "manifest.json", bytes: Buffer.from(JSON.stringify({ version: "2", animations: [{ id: "hero" }] })) },
        { path: "a/hero.json", bytes: animation },
        { path: "i/logo.png", bytes: onePixelPng },
        { path: "i/unused.png", bytes: onePixelPng }
      ]);
      await writeFile(sourcePath, archive);

      const result = await writeStaticDotLottiePackage({ sourcePath, outputRoot, inputRoots: [root], outputRoots: [root] });
      const pkg = await loadMotionPackage(outputRoot);
      const manifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as Record<string, any>;
      const render = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir: join(root, "render") });
      const region = inspectPngRegionBuffer(await readFile(render.output.path), { x: 20, y: 20, width: 50, height: 50 });

      expect(result.selection.bundledImages).toEqual([expect.objectContaining({ assetId: "logo", archivePath: "i/logo.png", packagePath: expect.stringMatching(/^assets\/dotlottie\//) })]);
      expect(result.bundledImagePaths).toHaveLength(1);
      expect(await readFile(result.bundledImagePaths[0])).toEqual(onePixelPng);
      expect(manifest.assets).toEqual([result.selection.bundledImages[0].packagePath]);
      expect(pkg.motion.layers).toEqual([expect.objectContaining({ id: "logo", type: "image", assetId: "logo" })]);
      expect(pkg.motion.assets).toEqual([expect.objectContaining({ id: "logo", kind: "image", source: expect.objectContaining({ path: result.selection.bundledImages[0].packagePath, mimeType: "image/png" }) })]);
      expect(region.ok).toBe(true);
      if (region.ok) expect(region.luma.brightPixels).toBeGreaterThan(2000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the first v2 animation by default while preserving an explicit override", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-dotlottie-selection-"));
    const sourcePath = join(root, "input.lottie");
    const outputRoot = join(root, "package");
    try {
      const animationBytes = await readFile(lottieFixturePath);
      await writeFile(sourcePath, storedZip([
        { path: "manifest.json", bytes: Buffer.from(JSON.stringify({ version: "2", animations: [{ id: "first" }, { id: "second" }] })) },
        { path: "a/first.json", bytes: animationBytes },
        { path: "a/second.json", bytes: animationBytes }
      ]));
      const first = await writeStaticDotLottiePackage({
        sourcePath,
        outputRoot,
        inputRoots: [root],
        outputRoots: [root]
      });
      expect(first.selection).toMatchObject({ animationId: "first", selectionSource: "manifest-first" });
      await rm(outputRoot, { recursive: true, force: true });

      const selected = await writeStaticDotLottiePackage({
        sourcePath,
        outputRoot,
        inputRoots: [root],
        outputRoots: [root],
        animationId: "second"
      });
      expect(selected.selection).toMatchObject({ animationId: "second", selectionSource: "explicit" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("installs selected fonts and declared v2 resources as provenance-bound package bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-dotlottie-resources-"));
    const sourcePath = join(root, "fixture.lottie");
    const outputRoot = join(root, "package");
    try {
      const baseAnimation = JSON.parse(await readFile(lottieFixturePath, "utf8")) as Record<string, unknown>;
      const animation = Buffer.from(JSON.stringify({
        ...baseAnimation,
        fonts: { list: [{ fName: "Brand-Bold", fFamily: "Brand", fStyle: "Bold", fPath: "f/brand.woff" }] },
        layers: [
          ...(Array.isArray(baseAnimation.layers) ? baseAnimation.layers : []),
          {
            ind: 99,
            ty: 5,
            nm: "Brand text",
            ip: 0,
            op: 30,
            ks: {
              p: { a: 0, k: [10, 50] },
              a: { a: 0, k: [0, 0] },
              s: { a: 0, k: [100, 100] },
              r: { a: 0, k: 0 },
              o: { a: 0, k: 100 }
            },
            t: { d: { k: [{ s: { t: "Brand", f: "Brand-Bold", s: 24, fc: [1, 1, 1] } }] } }
          }
        ]
      }));
      const fontBytes = Buffer.from([0x77, 0x4f, 0x46, 0x46, 0, 0, 0, 0]);
      const themeBytes = Buffer.from(JSON.stringify({ rules: [{ id: "accent", type: "Color", value: [1, 0, 0] }] }));
      const machineBytes = Buffer.from(JSON.stringify({ descriptor: { id: "button" }, states: [] }));
      await writeFile(sourcePath, storedZip([
        {
          path: "manifest.json",
          bytes: Buffer.from(JSON.stringify({
            version: "2",
            animations: [{ id: "hero", themes: ["dark"] }],
            themes: [{ id: "dark", name: "Dark" }],
            stateMachines: [{ id: "button", name: "Button" }]
          }))
        },
        { path: "a/hero.json", bytes: animation },
        { path: "f/brand.woff", bytes: fontBytes },
        { path: "t/dark.json", bytes: themeBytes },
        { path: "s/button.json", bytes: machineBytes }
      ]));

      const result = await writeStaticDotLottiePackage({ sourcePath, outputRoot, inputRoots: [root], outputRoots: [root] });
      const manifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as Record<string, any>;
      const pkg = await loadMotionPackage(outputRoot);

      expect(result.selection.bundledFonts).toEqual([expect.objectContaining({
        fontName: "Brand-Bold",
        fontFamily: "Brand",
        packagePath: expect.stringMatching(/^assets\/dotlottie\/font-/),
        mimeType: "font/woff",
        weight: 700
      })]);
      expect(result.selection.bundledFonts[0]).not.toHaveProperty("bytes");
      expect(await readFile(result.bundledFontPaths[0])).toEqual(fontBytes);
      expect(result.selection.bundledResources).toEqual([
        expect.objectContaining({ kind: "theme", id: "dark", packagePath: expect.stringMatching(/^source\/dotlottie-resources\//) }),
        expect.objectContaining({ kind: "state-machine", id: "button", packagePath: expect.stringMatching(/^source\/dotlottie-resources\//) })
      ]);
      expect(result.selection.bundledResources[0]).not.toHaveProperty("text");
      expect(await readFile(result.bundledResourcePaths[0])).toEqual(themeBytes);
      expect(await readFile(result.bundledResourcePaths[1])).toEqual(machineBytes);
      expect(manifest.assets).toEqual([result.selection.bundledFonts[0].packagePath]);
      expect(manifest.data.adapter.container.resources).toEqual([
        expect.objectContaining({ kind: "theme", id: "dark", path: result.selection.bundledResources[0].packagePath }),
        expect.objectContaining({ kind: "state-machine", id: "button", path: result.selection.bundledResources[1].packagePath })
      ]);
      expect(manifest.data.adapter.container.resourcePolicy).toEqual({
        themes: "preserved-not-applied",
        stateMachines: "preserved-not-executed",
        background: "lowered-to-motion-background"
      });
      expect(pkg.motion.assets).toEqual([expect.objectContaining({
        type: "font",
        family: "Brand-Bold",
        source: { path: result.selection.bundledFonts[0].packagePath, mimeType: "font/woff" }
      })]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lowers the v2 container background into Motion and rendered pixels", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-dotlottie-background-"));
    const sourcePath = join(root, "background.lottie");
    const outputRoot = join(root, "package");
    try {
      const animation = Buffer.from(JSON.stringify({
        v: "5.12.2", fr: 30, ip: 0, op: 30, w: 100, h: 100, assets: [],
        layers: [{
          ind: 1, ty: 1, nm: "Solid", sw: 10, sh: 10, sc: "#ffffff", ip: 0, op: 30,
          ks: {
            p: { a: 0, k: [20, 20] }, a: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 }
          }
        }]
      }));
      await writeFile(sourcePath, storedZip([
        { path: "manifest.json", bytes: Buffer.from(JSON.stringify({ version: "2", animations: [{ id: "hero", background: 0x2244ccff }] })) },
        { path: "a/hero.json", bytes: animation }
      ]));

      const result = await writeStaticDotLottiePackage({ sourcePath, outputRoot, inputRoots: [root], outputRoots: [root] });
      const pkg = await loadMotionPackage(outputRoot);
      const lowering = JSON.parse(await readFile(result.loweringReceiptPath, "utf8")) as Record<string, any>;
      const render = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir: join(root, "render") });
      const corner = inspectPngRegionBuffer(await readFile(render.output.path), { x: 0, y: 0, width: 4, height: 4 });

      expect(pkg.motion.background).toBe("#2244ccff");
      expect(lowering.output.dotLottieBackground).toEqual({ source: 0x2244ccff, motion: "#2244ccff" });
      expect(corner.ok).toBe(true);
      if (corner.ok) {
        expect(corner.opaquePixels).toBe(16);
        expect(corner.luma.avg).toBeGreaterThanOrEqual(70);
        expect(corner.luma.avg).toBeLessThanOrEqual(72);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies a bounded static initial theme while preserving the original animation", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-dotlottie-overrides-"));
    try {
      const animation = JSON.parse(await readFile(lottieFixturePath, "utf8")) as Record<string, any>;
      animation.slots = { accent: { p: { a: 0, k: [0, 0.83, 1, 1] } } };
      animation.layers[0].shapes[0].it[1].c = { sid: "accent" };
      animation.assets = [{ id: "scene", w: 640, h: 360, layers: animation.layers }];
      animation.layers = [{
        ind: 1, ty: 0, nm: "Group", refId: "scene", ip: 0, op: 90, st: 0, sr: 1,
        ks: {
          p: { a: 0, k: [320, 180] }, a: { a: 0, k: [320, 180] },
          s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 }
        }
      }];
      const animationBytes = Buffer.from(JSON.stringify(animation));
      const sourcePath = join(root, "theme.lottie");
      const outputRoot = join(root, "theme-package");
      const themeBytes = Buffer.from(JSON.stringify({ rules: [{ id: "accent", type: "Color", value: [1, 0, 0] }] }));
      await writeFile(sourcePath, storedZip([
        {
          path: "manifest.json",
          bytes: Buffer.from(JSON.stringify({
            version: "2",
            animations: [{ id: "hero", initialTheme: "dark", themes: ["dark"] }],
            themes: [{ id: "dark" }]
          }))
        },
        { path: "a/hero.json", bytes: animationBytes },
        { path: "t/dark.json", bytes: themeBytes }
      ]));

      const result = await writeStaticDotLottiePackage({
        sourcePath,
        outputRoot,
        inputRoots: [root],
        outputRoots: [root]
      });
      const original = JSON.parse(await readFile(result.selectedAnimationPath, "utf8")) as Record<string, any>;
      const themed = JSON.parse(await readFile(result.loweringAnimationPath, "utf8")) as Record<string, any>;
      const manifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as Record<string, any>;
      const lowering = JSON.parse(await readFile(result.loweringReceiptPath, "utf8")) as Record<string, any>;
      const pkg = await loadMotionPackage(outputRoot);

      expect(original.assets[0].layers[0].shapes[0].it[1].c).toEqual({ sid: "accent" });
      expect(themed.layers[0].shapes[0].it[1].c).toEqual({ sid: "accent", a: 0, k: [1, 0, 0, 1] });
      expect(result.appliedTheme).toMatchObject({ themeId: "dark", appliedRuleCount: 1, appliedTargetCount: 1, slotIds: ["accent"] });
      expect(result.precomposition).toMatchObject({ changed: true, flattenedPrecompCount: 1, flattenedLayerCount: 2 });
      expect(manifest.data.adapter.container.resourcePolicy.themes).toBe("static-subset-applied");
      expect(manifest.data.adapter.container.appliedTheme).toEqual(result.appliedTheme);
      expect(lowering.output.dotLottieTheme).toEqual(result.appliedTheme);
      expect(pkg.motion.layers).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "shape", style: expect.objectContaining({ stroke: "#ff0000ff" }) })
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function storedZip(sources: Array<{ path: string; bytes: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let localOffset = 0;
  for (const source of sources) {
    const name = Buffer.from(source.path, "utf8");
    const checksum = crc32(source.bytes);
    const local = Buffer.alloc(30 + name.length + source.bytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(source.bytes.length, 18);
    local.writeUInt32LE(source.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    source.bytes.copy(local, 30 + name.length);
    locals.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(source.bytes.length, 20);
    central.writeUInt32LE(source.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0o100600 * 0x10000, 38);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centrals.push(central);
    localOffset += local.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(sources.length, 8);
  eocd.writeUInt16LE(sources.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, central, eocd]);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
