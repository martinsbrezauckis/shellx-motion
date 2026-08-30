/**
 * Gradients must reach every shape kind, not just the rectangular ones.
 *
 * The defect: `renderGeneratedShape` builds a CSS gradient string and applies it as a `background`,
 * which works for rect and rounded-rect. Ellipse, triangle, star and freeform path are drawn as
 * inline SVG instead, and that path only ever received a flat `fill` colour — so a declared,
 * schema-valid, documented gradient was accepted and then silently ignored, and the shape fell
 * back to its solid fill.
 *
 * It mattered more than it sounds: every soft glow, vignette and light halo is an ellipse. Authors
 * hitting it saw a flat disc, concluded gradients did not work on shapes, and reached for stacked
 * ellipses (which band visibly) or hand-built SVG assets.
 *
 * These assert PIXELS from a real render rather than markup, because the thing that was broken was
 * what came out of the browser, and markup assertions would not have caught a paint server that
 * was emitted but never referenced.
 */
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectPngFileRegion, loadMotionPackage } from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { renderMotionBrowserFrame } from "./index";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A package holding one 400px shape centred on a dark field, filled with `gradient`. */
async function shapePackage(shape: string, gradient: unknown, parent = tmpdir()): Promise<string> {
  const root = await mkdtemp(join(parent, "shellx-motion-gradient-"));
  await mkdir(root, { recursive: true });
  const motion = {
    schema: "shellx-motion/motion@1",
    id: "motion_gradient_probe",
    name: "Gradient probe",
    durationMs: 200,
    fps: 30,
    width: 600,
    height: 600,
    background: "#000000",
    assets: [],
    layers: [{
      id: "probe",
      type: "shape",
      shape,
      startMs: 0,
      durationMs: 200,
      transform: { x: 100, y: 100, width: 400, height: 400 },
      // A solid fill is declared too: if the gradient is dropped, the shape renders flat white and
      // centre and edge become identical.
      style: { fill: "#ffffff" },
      ...(gradient ? { gradient } : {})
    }],
    provenance: { sourceApp: "shellx-motion", createdBy: "gradient-test" }
  };
  const manifest = {
    schema: "shellx-motion/package-manifest@1",
    id: "pkg_gradient_probe",
    name: "Gradient probe",
    motion: "motion.json",
    assets: [],
    sourceApp: "shellx-motion",
    compatibility: { lanes: ["browser"], hosts: ["motion"] }
  };
  await writeFile(join(root, "motion.json"), `${JSON.stringify(motion, null, 2)}\n`);
  await writeFile(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return root;
}

/** Average brightness of a small square, used to compare one part of a shape against another. */
async function patchLuma(path: string, x: number, y: number): Promise<number> {
  const result = await inspectPngFileRegion(path, { x, y, width: 24, height: 24 });
  if (!result.ok) throw new Error(`region inspect failed at ${x},${y}: ${result.code}`);
  return result.luma.avg;
}

async function renderShape(shape: string, gradient: unknown): Promise<string> {
  // A host-selected workspace anchor lets the test exercise the same stable-file authority path
  // as production without assuming the OS root directory belongs to the test principal.
  const workspace = await mkdtemp(join(tmpdir(), "shellx-motion-gradient-workspace-"));
  tempDirs.push(workspace);
  const packageRoot = await shapePackage(shape, gradient, workspace);
  const outDir = await mkdtemp(join(workspace, "out-"));
  return await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(workspace), async () => {
    const pkg = await loadMotionPackage(packageRoot);
    const result = await renderMotionBrowserFrame(pkg, { atMs: 0, outDir });
    if (!result.ok) throw new Error("gradient probe render failed");
    return result.output.path;
  });
}

const RADIAL = {
  type: "radial", centerX: 0.5, centerY: 0.5,
  stops: [{ offset: 0, color: "#ffffff" }, { offset: 1, color: "#101820" }]
};

describe("gradients render on SVG-drawn shapes", () => {
  it("gives an ellipse a real radial falloff instead of a flat disc", async () => {
    const path = await renderShape("ellipse", RADIAL);

    const centre = await patchLuma(path, 288, 288);
    const edge = await patchLuma(path, 288, 116);

    // The whole defect in one assertion: with the gradient dropped both patches were the same flat
    // white, so this difference was ~0. A real falloff makes the centre far brighter than the rim.
    expect(centre - edge).toBeGreaterThan(60);
  }, 60000);

  it("leaves a shape with no declared gradient flat", async () => {
    const path = await renderShape("ellipse", undefined);

    const centre = await patchLuma(path, 288, 288);
    const edge = await patchLuma(path, 288, 116);

    // The control: without a gradient the ellipse must still be one solid fill.
    expect(Math.abs(centre - edge)).toBeLessThan(6);
  }, 60000);

  it("gives a triangle a radial falloff too", async () => {
    const path = await renderShape("triangle", RADIAL);

    // Sample the wide lower body against the centre, both inside the triangle.
    const low = await patchLuma(path, 288, 440);
    const mid = await patchLuma(path, 288, 300);

    expect(mid - low).toBeGreaterThan(20);
  }, 60000);

  it("gives a star a radial falloff too", async () => {
    const path = await renderShape("star", RADIAL);

    const centre = await patchLuma(path, 288, 288);
    const topPoint = await patchLuma(path, 288, 116);

    expect(centre - topPoint).toBeGreaterThan(40);
  }, 60000);
});
