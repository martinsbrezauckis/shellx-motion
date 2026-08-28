import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHROMA_KEY_SCHEMA,
  ROTO_MASK_SCHEMA,
  inspectPngRegionBuffer,
  loadMotionPackage,
  rendererCapabilityForLane,
} from "@shellx-motion/core";
import { BROWSER_CAPABILITY, renderMotionBrowserFrame } from "./index";
import { motionKeyingDataAttribute } from "./generated-keying";
import { makeRgbaPngFixture } from "./test-support/png-fixture";

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

describe("browser keying and roto rendering", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("keys package-local image pixels with spill cleanup and receipt evidence", async () => {
    const root = await writeKeyedImagePackage();
    const output = await mkdtemp(join(tmpdir(), "shellx-motion-keyed-image-output-"));
    tempDirs.push(root, output);

    const result = await renderMotionBrowserFrame(await loadMotionPackage(root), { atMs: 0, outDir: output });
    const png = await readFile(result.output.path);
    const keyedBackground = inspectPngRegionBuffer(png, { x: 44, y: 19, width: 12, height: 12 });
    const subject = inspectPngRegionBuffer(png, { x: 72, y: 31, width: 20, height: 20 });

    expect(keyedBackground.ok).toBe(true);
    expect(subject.ok).toBe(true);
    if (!keyedBackground.ok || !subject.ok) return;
    expect(keyedBackground.luma.darkPixels).toBeGreaterThan(130);
    expect(subject.luma.brightPixels).toBeGreaterThan(390);
    expect(result.output.keying).toMatchObject({
      policy: "fixed-host-cpu-chroma",
      network: "denied",
      code: "host-fixed",
      layers: [expect.objectContaining({
        layerId: "subject",
        width: 80,
        height: 60,
        transparentPixels: expect.any(Number),
        spillAdjustedPixels: expect.any(Number),
      })],
    });
    expect(result.output.keying?.layers[0].transparentPixels).toBeGreaterThan(2_500);
    expect(result.output.keying?.layers[0].opaquePixels).toBeGreaterThan(800);
    expect(result.receipt.warnings).toEqual([]);
  });

  it("installs keying for motion-blur sampled image layers", async () => {
    const root = await writeKeyedImagePackage();
    const output = await mkdtemp(join(tmpdir(), "shellx-motion-keyed-blur-output-"));
    tempDirs.push(root, output);
    const pkg = await loadMotionPackage(root);
    pkg.motion.layers[0].effects = { motionBlur: { samples: 3, shutterAngle: 150 } };

    const result = await renderMotionBrowserFrame(pkg, { atMs: 250, outDir: output });

    expect(result.output.keying?.layers).toHaveLength(3);
    expect(result.output.keying?.layers.every((entry) => entry.layerId === "subject")).toBe(true);
    expect(result.output.temporalSampling).toMatchObject({
      totalSamples: 3,
      layers: [expect.objectContaining({ layerId: "subject", samples: 3, shutterAngle: 150 })],
    });
  });

  it("renders interpolated roto vertices at multiple timestamps", async () => {
    const root = await writeAnimatedRotoPackage();
    const output = await mkdtemp(join(tmpdir(), "shellx-motion-roto-output-"));
    tempDirs.push(root, output);
    const pkg = await loadMotionPackage(root);

    const [start, end] = await Promise.all([
      renderMotionBrowserFrame(pkg, { atMs: 0, outDir: output }),
      renderMotionBrowserFrame(pkg, { atMs: 999, outDir: output }),
    ]);
    const startPng = await readFile(start.output.path);
    const endPng = await readFile(end.output.path);
    const startLeft = inspectPngRegionBuffer(startPng, { x: 32, y: 32, width: 18, height: 20 });
    const startRight = inspectPngRegionBuffer(startPng, { x: 110, y: 32, width: 18, height: 20 });
    const endLeft = inspectPngRegionBuffer(endPng, { x: 32, y: 32, width: 18, height: 20 });
    const endRight = inspectPngRegionBuffer(endPng, { x: 110, y: 32, width: 18, height: 20 });

    expect(startLeft.ok && startRight.ok && endLeft.ok && endRight.ok).toBe(true);
    if (!startLeft.ok || !startRight.ok || !endLeft.ok || !endRight.ok) return;
    expect(startLeft.luma.brightPixels).toBeGreaterThan(340);
    expect(startRight.luma.darkPixels).toBeGreaterThan(340);
    expect(endLeft.luma.darkPixels).toBeGreaterThan(340);
    expect(endRight.luma.brightPixels).toBeGreaterThan(340);
    expect(start.receipt.warnings).toEqual([]);
    expect(end.receipt.warnings).toEqual([]);
  });

  it("keys the deterministically frozen frame of a package-local video", async () => {
    const root = await writeKeyedVideoPackage();
    const output = await mkdtemp(join(tmpdir(), "shellx-motion-keyed-video-output-"));
    tempDirs.push(root, output);

    const result = await renderMotionBrowserFrame(await loadMotionPackage(root), { atMs: 250, outDir: output });
    const png = await readFile(result.output.path);
    const keyedBackground = inspectPngRegionBuffer(png, { x: 44, y: 19, width: 12, height: 12 });
    const subject = inspectPngRegionBuffer(png, { x: 72, y: 31, width: 20, height: 20 });

    expect(keyedBackground.ok && subject.ok).toBe(true);
    if (!keyedBackground.ok || !subject.ok) return;
    expect(keyedBackground.luma.darkPixels).toBeGreaterThan(125);
    expect(subject.luma.brightPixels).toBeGreaterThan(360);
    expect(result.output.keying?.layers).toEqual([
      expect.objectContaining({ layerId: "subject-video", width: 80, height: 60 }),
    ]);
    expect(result.output.keying?.layers[0].transparentPixels).toBeGreaterThan(2_000);
  });

  it("advertises keying and tracked roto as explicit browser capabilities", () => {
    expect(BROWSER_CAPABILITY.features).toEqual(expect.arrayContaining([
      "keying.chroma",
      "mask.roto",
      "mask.roto.tracked",
    ]));
  });

  it("consumes the browser render capability from the single core source (no local drift)", () => {
    // Guards A1: renderer-browser must not re-declare its own capability. Its exported
    // BROWSER_CAPABILITY must equal the projection of the core browser card.
    expect(BROWSER_CAPABILITY).toEqual(rendererCapabilityForLane("browser"));
  });

  it("rejects out-of-contract keying controls before browser allocation", () => {
    expect(() => motionKeyingDataAttribute({
      id: "unsafe",
      type: "image",
      startMs: 0,
      durationMs: 1_000,
      keying: { ...keyingSettings(), similarity: 4 },
    })).toThrow(/similarity/);
  });
});

async function writeKeyedImagePackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-keyed-image-package-"));
  await mkdir(join(root, "assets"), { recursive: true, mode: 0o700 });
  await writePackage(root, {
    id: "motion-keyed-image",
    assets: ["assets/subject.png"],
    layers: [{
      id: "subject",
      type: "image",
      assetId: "subject-image",
      startMs: 0,
      durationMs: 1_000,
      transform: { x: 40, y: 15, width: 80, height: 60 },
      fit: "fill",
      keying: keyingSettings(),
    }],
    motionAssets: [{
      schema: "shellx-motion/asset@1",
      id: "subject-image",
      kind: "image",
      source: { path: "assets/subject.png", mimeType: "image/png" },
      hash: { sha256: "fixture-subject" },
      size: { width: 80, height: 60 },
    }],
  });
  await writeFile(join(root, "assets", "subject.png"), makeRgbaPngFixture(80, 60, keyedSubjectPixels()));
  return root;
}

async function writeKeyedVideoPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-keyed-video-package-"));
  await mkdir(join(root, "assets"), { recursive: true, mode: 0o700 });
  const sourcePath = join(root, "assets", "source.png");
  await writeFile(sourcePath, makeRgbaPngFixture(80, 60, keyedSubjectPixels()));
  await execFileAsync(process.env.SHELLX_MOTION_FFMPEG?.trim() || "ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-loop", "1", "-i", sourcePath,
    "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    join(root, "assets", "subject.mp4"),
  ]);
  await rm(sourcePath, { force: true });
  await writePackage(root, {
    id: "motion-keyed-video",
    assets: ["assets/subject.mp4"],
    layers: [{
      id: "subject-video",
      type: "video",
      assetId: "subject-video-asset",
      startMs: 0,
      durationMs: 1_000,
      transform: { x: 40, y: 15, width: 80, height: 60 },
      fit: "fill",
      keying: keyingSettings(),
    }],
    motionAssets: [{
      schema: "shellx-motion/asset@1",
      id: "subject-video-asset",
      kind: "video",
      source: { path: "assets/subject.mp4", mimeType: "video/mp4" },
      hash: { sha256: "fixture-subject-video" },
      size: { width: 80, height: 60 },
    }],
  });
  return root;
}

function keyedSubjectPixels() {
  return Array.from({ length: 80 * 60 }, (_value, index) => {
    const x = index % 80;
    const y = Math.floor(index / 80);
    const subject = x >= 24 && x <= 55 && y >= 12 && y <= 47;
    const edge = !subject && x >= 22 && x <= 57 && y >= 10 && y <= 49;
    if (subject) return { r: 255, g: 255, b: 255, a: 255 };
    if (edge) return { r: 28, g: 220, b: 32, a: 255 };
    return { r: 0, g: 255, b: 0, a: 255 };
  });
}

function keyingSettings() {
  return {
    schema: CHROMA_KEY_SCHEMA,
    keyColor: "#00ff00",
    similarity: 0.12,
    smoothness: 0.18,
    spillSuppression: 0.9,
    edgeColorCorrection: 0.5,
    matte: { denoiseRadiusPx: 1, featherPx: 1, blackClip: 0.03, whiteClip: 0.97 },
  };
}

async function writeAnimatedRotoPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-animated-roto-package-"));
  await writePackage(root, {
    id: "motion-animated-roto",
    assets: [],
    motionAssets: [],
    layers: [{
      id: "roto-panel",
      type: "shape",
      shape: "rect",
      startMs: 0,
      durationMs: 1_000,
      transform: { x: 20, y: 15, width: 120, height: 60 },
      style: { fill: "#ffffff" },
      mask: {
        type: "roto",
        schema: ROTO_MASK_SCHEMA,
        closed: true,
        featherPx: 1,
        frames: [
          { atMs: 0, vertices: rectangleVertices(0.05, 0.45) },
          { atMs: 999, vertices: rectangleVertices(0.55, 0.95) },
        ],
      },
    }],
  });
  return root;
}

function rectangleVertices(left: number, right: number) {
  return [
    { id: "top-left", x: left, y: 0.1 },
    { id: "top-right", x: right, y: 0.1 },
    { id: "bottom-right", x: right, y: 0.9 },
    { id: "bottom-left", x: left, y: 0.9 },
  ];
}

async function writePackage(root: string, input: {
  id: string;
  assets: string[];
  layers: unknown[];
  motionAssets: unknown[];
}): Promise<void> {
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1",
    id: `pkg-${input.id}`,
    name: input.id,
    motion: "motion.json",
    assets: input.assets,
    sourceApp: "shellx-motion",
    compatibility: { lanes: ["browser"], hosts: ["motion", "canvas", "cut"] },
  }, null, 2)}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1",
    id: input.id,
    name: input.id,
    durationMs: 1_000,
    fps: 24,
    width: 160,
    height: 90,
    background: "#000000",
    layers: input.layers,
    assets: input.motionAssets,
    provenance: { sourceApp: "shellx-motion", createdBy: "test" },
  }, null, 2)}\n`);
}
import { execFile } from "node:child_process";
