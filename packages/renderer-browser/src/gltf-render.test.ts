import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectPngBuffer,
  loadMotionPackage,
  lowerGltfToMotion,
  matchRendererCapability,
  parseGltfContainer,
} from "@shellx-motion/core";
import { BROWSER_CAPABILITY, renderMotionBrowserFrame } from "./index";

const tempDirs: string[] = [];

describe("bounded glTF browser rendering", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("renders an imported static mesh deterministically with visible orbit motion and evidence", async () => {
    const packageRoot = await writeImportedPackage();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-gltf-render-"));
    tempDirs.push(packageRoot, outDir);
    const pkg = await loadMotionPackage(packageRoot);

    expect(matchRendererCapability(pkg.motion, BROWSER_CAPABILITY)).toEqual({
      ok: true,
      lane: "browser",
      unsupported: [],
    });
    const start = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    const startAgain = await renderMotionBrowserFrame(pkg, {
      atMs: 0,
      outDir,
      outputPath: join(outDir, "start-again.png"),
    });
    const later = await renderMotionBrowserFrame(pkg, { atMs: 500, outDir });
    const quality = inspectPngBuffer(await readFile(start.output.path));

    expect(start.output.sha256).toBe(startAgain.output.sha256);
    expect(start.output.sha256).not.toBe(later.output.sha256);
    expect(start.output.scenes3d).toMatchObject({
      policy: "fixed-data-webgl",
      network: "denied",
      code: "host-fixed",
      layers: [{
        layerId: "gltf-scene",
        objectCount: 1,
        meshObjectCount: 1,
        meshVertexCount: 3,
        triangleCount: 1,
        primitives: ["mesh"],
        sourceFormats: ["gltf"],
      }],
    });
    expect(start.receipt.warnings).toEqual([]);
    expect(quality).toMatchObject({ ok: true, blank: false });
  }, 45_000);
});

async function writeImportedPackage(): Promise<string> {
  const fixturePath = resolve("../../fixtures/imports/gltf-triangle/input.gltf");
  const bytes = await readFile(fixturePath);
  const container = parseGltfContainer(bytes, "gltf");
  const lowered = lowerGltfToMotion({
    adapterId: "adapter.gltf",
    sourcePath: fixturePath,
    sourceText: container.jsonText,
    normalizedPackagePath: "pkg_gltf_render_fixture",
    container,
    createdBy: "renderer-test",
    createdAt: "2026-07-13T00:00:00.000Z",
    width: 320,
    height: 180,
    durationMs: 1_000,
    fps: 24,
  });
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-gltf-package-"));
  await Promise.all([
    writeFile(join(root, "manifest.json"), `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_gltf_render_fixture",
      name: "glTF Render Fixture",
      motion: "motion.json",
      assets: [],
      sourceApp: "gltf",
      compatibility: { lanes: ["browser"], hosts: ["motion", "canvas", "cut"] },
    }, null, 2)}\n`),
    writeFile(join(root, "motion.json"), `${JSON.stringify(lowered.motion, null, 2)}\n`),
  ]);
  return root;
}
