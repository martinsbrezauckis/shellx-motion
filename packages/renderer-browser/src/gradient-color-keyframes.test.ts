import { lstatSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodePngRgba, loadMotionPackage } from "@shellx-motion/core";
import { renderMotionBrowserFrame } from "./index";

const tempDirs: string[] = [];
const browserFrame = hasBrowserFrameAuthority() ? it : it.skip;
afterEach(async () => { await Promise.all(tempDirs.splice(0).map(async (path) => await rm(path, { recursive: true, force: true }))); });

describe("browser fixed-topology gradient color keyframes", () => {
  browserFrame("renders evaluated stop colors at their exact microsecond-derived frame times", async () => {
    const root = await writePackage();
    const pkg = await loadMotionPackage(root);
    const zero = await render(pkg, 0);
    const middle = await render(pkg, 500);
    const zeroPixel = await pixel(zero, 118, 300);
    const middlePixel = await pixel(middle, 118, 300);

    // The left-most interior sample is nearly the first stop. At 0us it is red; at 500,000us
    // canonical linear interpolation makes it purple. This is an actual browser pixel proof;
    // strict-GPU retained-resource/no-per-frame-allocation evidence belongs to the Core plan test.
    expect(zeroPixel.r).toBeGreaterThan(190);
    expect(zeroPixel.b).toBeLessThan(65);
    expect(middlePixel.r).toBeGreaterThan(75);
    expect(middlePixel.b).toBeGreaterThan(75);
    expect(middlePixel.g).toBeLessThan(32);
  }, 60_000);
});

async function writePackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-browser-gradient-color-keyframes-"));
  tempDirs.push(root);
  const motion = {
    schema: "shellx-motion/motion@1", id: "motion_browser_gradient_color_keyframes", name: "Gradient color keyframes",
    durationMs: 1000, fps: 30, width: 600, height: 600, background: "#000000", assets: [],
    layers: [{
      id: "field", type: "shape", shape: "rect", startMs: 0, durationMs: 1000,
      transform: { x: 100, y: 100, width: 400, height: 400 },
      gradient: {
        type: "linear", angle: 90,
        stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#000000" }],
        colorKeyframes: {
          schema: "shellx-motion/gradient-color-keyframes@1",
          keyframes: [
            { atUs: 0, colors: ["#ff0000", "#000000"], easing: "linear" },
            { atUs: 1_000_000, colors: ["#0000ff", "#ffffff"] },
          ],
        },
      },
    }],
    provenance: { sourceApp: "test", createdBy: "gradient-color-keyframes-test" },
  };
  const manifest = {
    schema: "shellx-motion/package-manifest@1", id: "pkg_browser_gradient_color_keyframes", name: "Gradient color keyframes",
    motion: "motion.json", assets: [], sourceApp: "shellx-motion", compatibility: { lanes: ["browser"], hosts: ["motion"] },
  };
  await writeFile(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify(motion, null, 2)}\n`);
  return root;
}

async function render(pkg: Awaited<ReturnType<typeof loadMotionPackage>>, atMs: number): Promise<string> {
  const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-browser-gradient-color-keyframes-out-"));
  tempDirs.push(outDir);
  const result = await renderMotionBrowserFrame(pkg, { atMs, outDir });
  return result.output.path;
}

async function pixel(path: string, x: number, y: number): Promise<{ r: number; g: number; b: number }> {
  const png = decodePngRgba(await readFile(path));
  const offset = (y * png.width + x) * 4;
  return { r: png.rgba[offset]!, g: png.rgba[offset + 1]!, b: png.rgba[offset + 2]! };
}

function hasBrowserFrameAuthority(): boolean {
  if (process.platform === "win32" || typeof process.getuid !== "function") return true;
  const uid = process.getuid();
  let current = resolve(process.cwd());
  for (;;) {
    if (lstatSync(current).uid !== uid && lstatSync(current).uid !== 0) return false;
    if (current === parse(current).root) return true;
    current = dirname(current);
  }
}
