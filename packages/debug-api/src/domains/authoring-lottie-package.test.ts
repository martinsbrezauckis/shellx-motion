import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileGpuScene2dPlan,
  compileGpuSceneStaticPlan,
  hashBuffer,
  inspectPngBuffer,
  inspectPngRegionBuffer,
  loadMotionPackage,
  matchRendererCapabilityCards
} from "@shellx-motion/core";
import { renderMotionBrowserFrame } from "@shellx-motion/renderer-browser";
import { writeStaticLottiePackage } from "./authoring-lottie-package.js";

const fixturePath = resolve("../../fixtures/imports/lottie-static-shape/input.json");
const matteEffectsFixturePath = resolve("../../fixtures/imports/lottie-matte-effects/input.json");
const lumaMattesFixturePath = resolve("../../fixtures/imports/lottie-luma-mattes/input.json");
const primitivesFixturePath = resolve("../../fixtures/imports/lottie-primitives/input.json");

describe("atomic Lottie package authoring", () => {
  it("preserves source bytes and installs one hash-converged portable package", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-lottie-package-"));
    const outputRoot = join(root, "packages", "lottie-import");
    try {
      await mkdir(dirname(outputRoot), { recursive: true, mode: 0o700 });
      const result = await writeStaticLottiePackage({
        sourcePath: fixturePath,
        outputRoot,
        inputRoots: [dirname(fixturePath)],
        outputRoots: [root],
        createdBy: "adapter-package-test",
        createdAt: "2026-07-12T03:30:00.000Z"
      });
      const sourceBytes = await readFile(fixturePath);
      const preservedBytes = await readFile(result.sourcePath);
      const diagnosticsReceipt = JSON.parse(await readFile(result.diagnosticsReceiptPath, "utf8")) as Record<string, any>;
      const loweringReceipt = JSON.parse(await readFile(result.loweringReceiptPath, "utf8")) as Record<string, any>;
      const manifestText = await readFile(result.manifestPath, "utf8");
      const reopened = await loadMotionPackage(result.packageRoot);
      const render = await renderMotionBrowserFrame(reopened, { atMs: 0, outDir: join(root, "render") });
      const quality = inspectPngBuffer(await readFile(render.output.path));

      expect(preservedBytes.equals(sourceBytes)).toBe(true);
      expect(result.sourceSha256).toBe(hashBuffer(sourceBytes));
      expect(result.loweringSourcePath).toBe(result.sourcePath);
      expect(await readFile(result.loweringSourcePath)).toEqual(sourceBytes);
      expect(result.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.motionSha256).toBe(loweringReceipt.output.motionSha256);
      expect(reopened.manifest.id).toBe(`pkg_lottie_${result.sourceSha256.slice(0, 16)}`);
      expect(reopened.motion.provenance).toMatchObject({ sourceApp: "lottie", createdBy: "adapter-package-test" });
      expect(diagnosticsReceipt).toMatchObject({
        operation: "adapter.diagnostics",
        packageId: reopened.manifest.id,
        inputHashes: { source: result.sourceSha256 },
        output: { source: { path: "source/input.lottie.json", sha256: result.sourceSha256 } }
      });
      expect(loweringReceipt).toMatchObject({
        operation: "adapter.lower",
        packageId: reopened.manifest.id,
        inputHashes: { source: result.sourceSha256 },
        output: { motionId: reopened.motion.id, motionSha256: result.motionSha256 }
      });
      expect(loweringReceipt.output).not.toHaveProperty("lottieGpuPrecomposition");
      expect(diagnosticsReceipt.output).not.toHaveProperty("lottieGpuPrecomposition");
      expect(manifestText).not.toContain(fixturePath);
      expect(JSON.stringify(diagnosticsReceipt)).not.toContain(fixturePath);
      expect(quality.ok).toBe(true);
      if (quality.ok) {
        expect(quality.blank).toBe(false);
        expect(quality.edges.pixels).toBeGreaterThan(50);
      }
      expect(render.output.typography?.layers).toEqual(expect.arrayContaining([
        expect.objectContaining({ layerId: "arabic-title", direction: "rtl" })
      ]));
      if (process.platform !== "win32") {
        expect((await stat(result.motionPath)).mode & 0o777).toBe(0o600);
        expect((await stat(result.packageRoot)).mode & 0o077).toBe(0);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renders fixture-backed alpha matte and static effect evidence from the installed package", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-lottie-matte-effects-"));
    const outputRoot = join(root, "package");
    try {
      const result = await writeStaticLottiePackage({
        sourcePath: matteEffectsFixturePath,
        outputRoot,
        inputRoots: [dirname(matteEffectsFixturePath)],
        outputRoots: [root],
        createdAt: "2026-07-12T18:00:00.000Z"
      });
      const render = await renderMotionBrowserFrame(await loadMotionPackage(outputRoot), { atMs: 0, outDir: join(root, "render") });
      const png = await readFile(render.output.path);
      const matteInside = inspectPngRegionBuffer(png, { x: 100, y: 60, width: 40, height: 40 });
      const matteOutside = inspectPngRegionBuffer(png, { x: 260, y: 60, width: 40, height: 40 });
      const effectCenter = inspectPngRegionBuffer(png, { x: 20, y: 70, width: 30, height: 30 });
      const loweringReceipt = JSON.parse(await readFile(result.loweringReceiptPath, "utf8")) as Record<string, any>;

      expect(matteInside.ok && matteOutside.ok && effectCenter.ok).toBe(true);
      if (!matteInside.ok || !matteOutside.ok || !effectCenter.ok) return;
      expect(matteInside.opaquePixels).toBeGreaterThan(1500);
      expect(matteOutside.opaquePixels).toBe(0);
      expect(effectCenter.opaquePixels).toBeGreaterThan(800);
      expect(loweringReceipt).toMatchObject({
        status: "warning",
        output: {
          acceptedWarningFeatures: expect.arrayContaining([
            expect.objectContaining({ feature: "lottie.effect.gaussianBlur.approximation" }),
            expect.objectContaining({ feature: "lottie.effect.brightnessContrast.approximation" })
          ])
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renders fixture-backed luma and inverted-luma matte evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-lottie-luma-mattes-"));
    const outputRoot = join(root, "package");
    try {
      await writeStaticLottiePackage({
        sourcePath: lumaMattesFixturePath,
        outputRoot,
        inputRoots: [dirname(lumaMattesFixturePath)],
        outputRoots: [root],
        createdAt: "2026-07-12T20:00:00.000Z"
      });
      const render = await renderMotionBrowserFrame(await loadMotionPackage(outputRoot), { atMs: 0, outDir: join(root, "render") });
      const png = await readFile(render.output.path);
      const lumaInside = inspectPngRegionBuffer(png, { x: 60, y: 30, width: 30, height: 30 });
      const lumaOutside = inspectPngRegionBuffer(png, { x: 200, y: 30, width: 30, height: 30 });
      const invertedInside = inspectPngRegionBuffer(png, { x: 200, y: 120, width: 30, height: 30 });
      const invertedOutside = inspectPngRegionBuffer(png, { x: 40, y: 120, width: 30, height: 30 });
      expect(lumaInside.ok && lumaOutside.ok && invertedInside.ok && invertedOutside.ok).toBe(true);
      if (!lumaInside.ok || !lumaOutside.ok || !invertedInside.ok || !invertedOutside.ok) return;
      expect(lumaInside.nonTransparentPixels).toBeGreaterThan(800);
      expect(lumaInside.opaquePixels).toBe(0);
      expect(lumaOutside.nonTransparentPixels).toBe(0);
      expect(invertedInside.nonTransparentPixels).toBeGreaterThan(800);
      expect(invertedInside.opaquePixels).toBe(0);
      expect(invertedOutside.opaquePixels).toBeGreaterThan(800);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renders fixture-backed rectangle and ellipse primitives from the installed package", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-lottie-primitives-"));
    const outputRoot = join(root, "package");
    try {
      await writeStaticLottiePackage({
        sourcePath: primitivesFixturePath,
        outputRoot,
        inputRoots: [dirname(primitivesFixturePath)],
        outputRoots: [root],
        createdAt: "2026-07-12T21:00:00.000Z"
      });
      const render = await renderMotionBrowserFrame(await loadMotionPackage(outputRoot), { atMs: 0, outDir: join(root, "render") });
      const png = await readFile(render.output.path);
      const rectangle = inspectPngRegionBuffer(png, { x: 40, y: 45, width: 30, height: 30 });
      const ellipse = inspectPngRegionBuffer(png, { x: 165, y: 45, width: 30, height: 30 });
      const outside = inspectPngRegionBuffer(png, { x: 110, y: 10, width: 20, height: 20 });
      expect(rectangle.ok && ellipse.ok && outside.ok).toBe(true);
      if (!rectangle.ok || !ellipse.ok || !outside.ok) return;
      expect(rectangle.opaquePixels).toBeGreaterThan(850);
      expect(ellipse.opaquePixels).toBeGreaterThan(850);
      expect(outside.nonTransparentPixels).toBe(0);
      expect(rectangle.sha256).not.toBe(ellipse.sha256);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes transformed/clipped precompositions to the exact GPU group lowerer without flattening source bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-lottie-precomp-"));
    const sourcePath = join(root, "precomp.json");
    const outputRoot = join(root, "package");
      const identity = {
        p: { a: 0, k: [50, 50] }, a: { a: 0, k: [50, 50] },
        s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 }
      };
      const sourceBytes = Buffer.from(JSON.stringify({
        v: "5.12.2", ddd: 0, fr: 10, ip: 0, op: 10, w: 100, h: 100, nm: "Nested",
        assets: [
          { id: "scene", w: 100, h: 100, layers: [{ ind: 1, ty: 1, nm: "Solid", sw: 20, sh: 20, sc: "#ffffff", ip: 0, op: 10, ks: identity }] },
          { id: "sibling-image", w: 1, h: 1, u: "images/", p: "logo.png", e: 0 }
        ],
        layers: [{ ind: 1, ty: 0, nm: "Group", refId: "scene", ip: 2, op: 8, st: 0, sr: 1, ks: { ...identity, p: { a: 0, k: [55, 50] } } }]
      }));
    try {
      await writeFile(sourcePath, sourceBytes);
      const result = await writeStaticLottiePackage({ sourcePath, outputRoot, inputRoots: [root], outputRoots: [root] });
      const manifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as Record<string, any>;
      const lowering = JSON.parse(await readFile(result.loweringReceiptPath, "utf8")) as Record<string, any>;
      const pkg = await loadMotionPackage(outputRoot);
      const matches = matchRendererCapabilityCards(pkg.motion, { output: "png-frame", target: "preview" });
      const staticPlan = compileGpuSceneStaticPlan(pkg.motion);
      const framePlan = compileGpuScene2dPlan(pkg.motion, 500);

      expect(await readFile(result.sourcePath)).toEqual(sourceBytes);
      expect(await readFile(result.loweringSourcePath)).toEqual(sourceBytes);
      expect(result.loweringSourcePath).toBe(result.sourcePath);
      expect(result.precomposition).toMatchObject({
        changed: false,
        flattenedPrecompCount: 0,
        flattenedLayerCount: 0,
        maxDepth: 0,
        policy: "full-frame-identity-static"
      });
      expect(manifest.data.adapter.precomposition).toEqual(result.precomposition);
      expect(manifest.compatibility).toEqual({ lanes: ["gpu"], hosts: ["shellx-motion"] });
      expect(lowering.output.lottieGpuPrecomposition).toMatchObject({ sourceSha256: hashBuffer(sourceBytes), loweringFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), outputMotionSha256: result.motionSha256 });
      expect(pkg.motion.layers).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "group", name: "Group", startMs: 200, durationMs: 600, childLayerIds: [expect.any(String)], mask: { type: "rect", inset: { right: 0, bottom: 0 } } }),
        expect.objectContaining({ type: "shape", name: "Solid", startMs: 0, durationMs: 600 })
      ]));
      expect(matches.matches.find((match) => match.lane === "browser")).toMatchObject({
        ok: false,
        unsupported: [expect.objectContaining({ feature: "layer.type:group", reason: "Lane browser does not support group layers." })]
      });
      expect(matches.matches.find((match) => match.lane === "gpu")).toMatchObject({ ok: true, unsupported: [] });
      expect(staticPlan).toMatchObject({ ok: true, plan: { maxima: { maxGroupCount: 1 } } });
      expect(framePlan).toMatchObject({ ok: true, plan: { groupCount: 1, groupMaxDepth: 1 } });
      if (!framePlan.ok) throw new Error(framePlan.failure.message);
      expect(framePlan.plan.frame.draws).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "groupStart" }),
        expect.objectContaining({ kind: "rect" }),
        expect.objectContaining({ kind: "groupEnd" })
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects path escapes, source symlinks, and source mutation without creating output", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-lottie-package-security-"));
    const inputRoot = join(root, "input");
    const outputBase = join(root, "output");
    const sourcePath = join(inputRoot, "input.json");
    try {
      await mkdir(inputRoot);
      await mkdir(outputBase);
      await writeFile(sourcePath, await readFile(fixturePath));
      await expect(writeStaticLottiePackage({
        sourcePath,
        outputRoot: join(root, "escaped", "package"),
        inputRoots: [inputRoot],
        outputRoots: [outputBase]
      })).rejects.toThrow("approved output root");

      const mutatedOutput = join(outputBase, "mutated");
      await expect(writeStaticLottiePackage({
        sourcePath,
        outputRoot: mutatedOutput,
        inputRoots: [inputRoot],
        outputRoots: [outputBase],
        beforeSourceStabilityCheck: async () => { await writeFile(sourcePath, "{\"changed\":true}\n", "utf8"); }
      })).rejects.toThrow("changed while it was being read");
      await expect(readdir(mutatedOutput)).rejects.toMatchObject({ code: "ENOENT" });

      if (process.platform !== "win32") {
        await writeFile(sourcePath, await readFile(fixturePath));
        const linkedPath = join(inputRoot, "linked.json");
        await symlink(sourcePath, linkedPath, "file");
        await expect(writeStaticLottiePackage({
          sourcePath: linkedPath,
          outputRoot: join(outputBase, "linked"),
          inputRoots: [inputRoot],
          outputRoots: [outputBase]
        })).rejects.toMatchObject({ code: "ELOOP" });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls back package installation when host receipt persistence fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-lottie-package-rollback-"));
    const outputRoot = join(root, "package");
    try {
      await expect(writeStaticLottiePackage({
        sourcePath: fixturePath,
        outputRoot,
        inputRoots: [dirname(fixturePath)],
        outputRoots: [root],
        afterCommit: async () => { throw new Error("host receipt persistence failed"); }
      })).rejects.toThrow("host receipt persistence failed");
      await expect(readdir(outputRoot)).rejects.toMatchObject({ code: "ENOENT" });

      await mkdir(outputRoot);
      await expect(writeStaticLottiePackage({
        sourcePath: fixturePath,
        outputRoot,
        inputRoots: [dirname(fixturePath)],
        outputRoots: [root],
        afterCommit: async () => { throw new Error("host receipt persistence failed"); }
      })).rejects.toThrow("host receipt persistence failed");
      expect(await readdir(outputRoot)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
