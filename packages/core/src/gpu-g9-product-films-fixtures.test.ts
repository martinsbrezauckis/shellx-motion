import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GPU_CAPABILITY, matchRendererCapability, matchRendererCapabilityCards } from "./capabilities";
import { parseGltfContainer } from "./gltf-container";
import { lowerGltfToMotion } from "./gltf-lowering";
import { hashPackageFile, resolvePackageAsset } from "./package";
import { compileGpuScene2dPlan, type GpuScene2dImageResource, type GpuScene2dVideoResource } from "./gpu-scene-2d-plan";
import { compileGpuSceneStaticPlan } from "./gpu-scene-static-plan";
import type { GpuScene2dFontResource, GpuScene2dFontResources } from "./gpu-scene-text";
import { scene3dMeshGeometrySha256 } from "./scene-3d-geometry";
import type { MotionPackage } from "./types";
import { loadSchema, validateDocument } from "./validate";
import { validateMotionDocumentInStages } from "./motion-validation";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/packages", import.meta.url));
const INTER_LICENSE_SHA256 = "3b0a5fca3d17942cde889069889dedbbbd075e9b599968c82a95f4d944e9b345";

/**
 * Source-only G9 product-film preflight. This deliberately opens fixed repository
 * assets directly rather than calling loadMotionPackage: topology ownership is
 * intentionally unavailable in the managed WSL sandbox, while the packages are
 * still required to prove their schema, bounded GPU topology, resource identity,
 * representative exact-time frames, and final-lane declaration before hardware
 * qualification starts on a qualified Linux GPU host/macOS/Linux.
 */
describe("G9 advanced GPU product film fixtures", () => {
  it("admits Particle Cathedral as a deterministic 100k fixed-compute final-lane package", async () => {
    const pkg = await readFixture("gpu-g9-particle-cathedral");
    await expectValid(pkg, "particle-cathedral");
    expect(matchRendererCapability(pkg.motion, GPU_CAPABILITY)).toEqual({ ok: true, lane: "gpu", unsupported: [] });
    expect(pkg.manifest.compatibility.lanes).toEqual(["gpu", "ffmpeg"]);
    expect(pkg.motion.layers.find((layer) => layer.id === "title")?.transform?.x).toBeGreaterThanOrEqual(pkg.motion.safeAreas?.copy?.left ?? 0);
    expect(pkg.manifest.assets).toEqual([
      "assets/fonts/inter-latin-600-normal.woff2",
      "assets/fonts/inter-latin-900-normal.woff2",
      "assets/fonts/LICENSE-Inter.txt"
    ]);
    await expect(hashPackageFile(resolvePackageAsset(pkg, "assets/fonts/LICENSE-Inter.txt"))).resolves.toBe(INTER_LICENSE_SHA256);

    const staticPlan = compileGpuSceneStaticPlan(pkg.motion);
    expect(staticPlan).toMatchObject({ ok: true, plan: { maxima: { maxComputeParticleFieldCount: 1, maxComputeParticleCount: 100_000, maxPointCount: 0 } } });
    const frames = [0, 2_400, 5_400, 7_199];
    const fingerprints = new Set<string>();
    for (const atMs of frames) {
      const result = compileGpuScene2dPlan(pkg.motion, atMs, await preparedResources(pkg, atMs));
      expect(result, `Particle Cathedral at ${atMs}ms`).toMatchObject({ ok: true });
      if (!result.ok) continue;
      fingerprints.add(result.plan.frame.fingerprint);
      expect(result.plan).toMatchObject({
        particleCount: 100_000,
        pointCount: 0,
        frame: { budget: { computeParticleFieldCount: 1, computeParticleCount: 100_000, computeParticleBufferBytes: 6_400_000 } }
      });
      expect(result.plan.frame.draws).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "particleCompute", id: "hundred-thousand-lights", count: 100_000, atMs })
      ]));
    }
    expect(fingerprints.size).toBe(frames.length);
  });

  it("keeps Mixed Media Atlas on the staged-video GPU final lane with exact source assets, chroma cleanup, matte, mask, typography, effects, and audio", async () => {
    const pkg = await readFixture("gpu-g9-mixed-media-atlas");
    await expectValid(pkg, "mixed-media-atlas");
    // GPU produces pixels; FFmpeg owns this package's audio mux. The direct GPU card must not
    // pretend that it consumes the audio layer, while the requested final pipeline must bind it.
    expect(matchRendererCapability(pkg.motion, GPU_CAPABILITY)).toEqual({
      ok: false, lane: "gpu",
      unsupported: [expect.objectContaining({ layerId: "launch-tone", feature: "layer.type:audio" })]
    });
    expect(matchRendererCapability({ ...pkg.motion, layers: pkg.motion.layers.filter((layer) => layer.type !== "audio") }, GPU_CAPABILITY)).toEqual({ ok: true, lane: "gpu", unsupported: [] });
    expect(matchRendererCapabilityCards(pkg.motion, { output: "mp4-h264", target: "final", needsAudio: true, preferLane: "gpu" }).recommendedPipeline).toEqual({
      lanes: ["gpu", "ffmpeg"],
      frameLane: "gpu",
      finalLane: "ffmpeg",
      reason: "Lane ffmpeg requires gpu frame capture before final encode."
    });
    expect(pkg.manifest.compatibility.lanes).toEqual(["gpu", "ffmpeg"]);
    await expectAssetHashes(pkg, {
      "assets/video/atmosphere-fog-rays.mp4": "24cfaf7065119713d771a48d3d47966c13004d95a8671c4cf2e53516c0834c7c",
      "assets/images/neon-studio.svg": "4766625ed3986536412fa1c74c4abb40d746ea14a624a7e6483ea59582f47409",
      "assets/images/green-screen-subject.svg": "dde4d37741cc7b83fa3380fb25f6be78aa29c2a910003edc61682335a7047d1a",
      "assets/fonts/inter-latin-600-normal.woff2": "f9a06e79cd3a2a20951c0f0e28f66dd0e6d3fda73911d640a2125c8fcb78f21a",
      "assets/fonts/inter-latin-900-normal.woff2": "d5c0ed7b8b5dde97d48b97947d740bbd8ad3ba9f2c5cc6b8280f16acba2d828e",
      "assets/audio/shellx-launch-tone.wav": "9eececabf1a20146b75a196fc884d9f77eaf7dab341f330c15cba98b61018afb"
    });
    await expect(hashPackageFile(resolvePackageAsset(pkg, "assets/fonts/LICENSE-Inter.txt"))).resolves.toBe(INTER_LICENSE_SHA256);

    const badgeCopy = pkg.motion.layers.find((layer) => layer.id === "proof-badge-copy");
    const badgeSafeArea = pkg.motion.safeAreas?.badge;
    expect(badgeCopy).toMatchObject({ textFit: { policy: "auto-fit", safeAreaId: "badge", minFontSize: 14 } });
    expect(badgeSafeArea).toBeDefined();
    const box = badgeCopy?.transform;
    const bounds = badgeSafeArea;
    if (!box || !bounds || [box.x, box.y, box.width, box.height, bounds.top, bounds.right, bounds.bottom, bounds.left].some((value) => typeof value !== "number")) throw new Error("Mixed Media Atlas proof badge requires fixed safe-area geometry.");
    const x = box.x as number; const y = box.y as number; const width = box.width as number; const height = box.height as number;
    const top = bounds.top as number; const right = bounds.right as number; const bottom = bounds.bottom as number; const left = bounds.left as number;
    expect(x).toBeGreaterThanOrEqual(left);
    expect(y).toBeGreaterThanOrEqual(top);
    expect(x + width).toBeLessThanOrEqual(pkg.motion.width - right);
    expect(y + height).toBeLessThanOrEqual(pkg.motion.height - bottom);

    const staticPlan = compileGpuSceneStaticPlan(pkg.motion);
    expect(staticPlan).toMatchObject({ ok: true });
    if (staticPlan.ok) {
      expect(staticPlan.plan.resources).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "video", assetRef: "assets/video/atmosphere-fog-rays.mp4" }),
        expect.objectContaining({ kind: "image", assetRef: "assets/images/neon-studio.svg" }),
        expect.objectContaining({ kind: "image", assetRef: "assets/images/green-screen-subject.svg" }),
        expect.objectContaining({ kind: "font", assetRef: "assets/fonts/inter-latin-900-normal.woff2" })
      ]));
    }
    for (const atMs of [0, 1_300, 4_800, 6_499]) {
      const result = compileGpuScene2dPlan(pkg.motion, atMs, await preparedResources(pkg, atMs));
      expect(result, `Mixed Media Atlas at ${atMs}ms`).toMatchObject({ ok: true });
      if (!result.ok) continue;
      expect(result.plan).toMatchObject({ videoCount: 1, imageCount: 2, matteCount: 1 });
      expect(result.plan.maskCount).toBeGreaterThanOrEqual(1);
      if (atMs === 1_300) expect(result.plan.textCount).toBeGreaterThanOrEqual(2);
      if (atMs === 4_800) expect(result.plan.textCount).toBe(3);
      expect(result.plan.frame.budget).toMatchObject({ chromaKeyCount: 1, chromaMatteCleanupCount: 1, chromaMatteCleanupPassCount: 9 });
      expect(result.plan.frame.draws).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "image", id: "atmosphere-footage" }),
        expect.objectContaining({ kind: "image", id: "keyed-subject", chromaKey: expect.objectContaining({ matte: expect.objectContaining({ chokePx: 1, featherPx: 2 }) }) })
      ]));
    }
    const audio = pkg.motion.layers.find((layer) => layer.id === "launch-tone");
    expect(audio).toMatchObject({ type: "audio", source: "assets/audio/shellx-launch-tone.wav", durationMs: 6_000, normalizeLoudness: true, fadeInMs: 160, fadeOutMs: 420 });
  });

  it("keeps Orbital Depth data-only: lowerer-matched glTF geometry, a depth-buffered 3D scene, two environment passes, trails, and final-lane post processing", async () => {
    const pkg = await readFixture("gpu-g9-orbital-depth");
    await expectValid(pkg, "orbital-depth");
    expect(matchRendererCapability(pkg.motion, GPU_CAPABILITY)).toEqual({ ok: true, lane: "gpu", unsupported: [] });
    expect(pkg.manifest.compatibility.lanes).toEqual(["gpu", "ffmpeg"]);
    await expectAssetHashes(pkg, {
      "assets/fonts/inter-latin-600-normal.woff2": "f9a06e79cd3a2a20951c0f0e28f66dd0e6d3fda73911d640a2125c8fcb78f21a",
      "assets/fonts/inter-latin-900-normal.woff2": "d5c0ed7b8b5dde97d48b97947d740bbd8ad3ba9f2c5cc6b8280f16acba2d828e"
    });
    const sourceBytes = await readFile(resolve(pkg.root, "assets/source/orbital-triangle.gltf"));
    const source = parseGltfContainer(sourceBytes, "gltf");
    const lowered = lowerGltfToMotion({
      adapterId: "adapter.gltf", sourcePath: "assets/source/orbital-triangle.gltf", sourceText: source.jsonText,
      normalizedPackagePath: pkg.manifest.id, container: source, createdBy: "g9-product-film-fixture",
      createdAt: "2026-08-14T00:00:00.000Z", width: pkg.motion.width, height: pkg.motion.height, durationMs: pkg.motion.durationMs
    });
    const imported = lowered.motion.layers[0]?.scene3d?.objects[0];
    const world = pkg.motion.layers.find((layer) => layer.id === "orbital-world")?.scene3d;
    const sail = world?.objects.find((object) => object.id === "gltf-orbital-sail");
    expect(imported?.primitive).toBe("mesh");
    expect(sail).toMatchObject({ primitive: "mesh", source: { format: "gltf", meshIndex: 0, primitiveIndex: 0, materialIndex: 0 } });
    if (imported?.primitive !== "mesh" || sail?.primitive !== "mesh") throw new Error("G9 orbital fixture lost its bounded glTF mesh.");
    expect(sail.geometry).toEqual(imported.geometry);
    expect(sail.source.geometrySha256).toBe(scene3dMeshGeometrySha256(sail.geometry));
    expect(sail.source.geometrySha256).toBe(imported.source.geometrySha256);

    const staticPlan = compileGpuSceneStaticPlan(pkg.motion);
    expect(staticPlan).toMatchObject({ ok: true, plan: { maxima: { maxScene3dCount: 1, maxScene3dObjectCount: 4, maxEnvironmentCount: 2 } } });
    expect(pkg.motion.layers.find((layer) => layer.id === "title")?.transform?.x).toBeGreaterThanOrEqual(pkg.motion.safeAreas?.copy?.left ?? 0);
    for (const atMs of [0, 1_800, 4_200, 7_199]) {
      const result = compileGpuScene2dPlan(pkg.motion, atMs, await preparedResources(pkg, atMs));
      expect(result, `Orbital Depth at ${atMs}ms`).toMatchObject({ ok: true });
      if (!result.ok) continue;
      expect(result.plan).toMatchObject({ scene3dCount: 1, scene3dObjectCount: 4, environmentCount: 2, particleCount: 360, adjustmentCount: 1 });
      const draws = result.plan.frame.draws;
      const scene = draws.find((draw) => draw.kind === "scene3d" && draw.id === "orbital-world");
      expect(scene).toMatchObject({ objects: expect.arrayContaining([expect.objectContaining({ id: "gltf-orbital-sail", indices: [0, 1, 2] })]) });
      expect(draws.find((draw) => draw.kind === "environment" && draw.id === "atmospheric-fog")).toMatchObject({ environmentKind: "fog" });
      expect(draws.find((draw) => draw.kind === "environment" && draw.id === "orbit-snow")).toMatchObject({ environmentKind: "snow" });
      if (atMs > 0) expect(draws.find((draw) => draw.kind === "coloredTriangles" && draw.id.startsWith("trail-"))).toBeDefined();
    }
  });
});

async function expectValid(pkg: MotionPackage, label: string): Promise<void> {
  expect(await validateDocument(await loadSchema("packageManifest"), pkg.manifest), `${label}: manifest schema`).toEqual({ ok: true });
  expect(await validateMotionDocumentInStages(pkg.motion), `${label}: motion validation`).toMatchObject({ ok: true });
}

async function expectAssetHashes(pkg: MotionPackage, expected: Record<string, string>): Promise<void> {
  for (const [assetRef, sha256] of Object.entries(expected)) {
    await expect(hashPackageFile(resolvePackageAsset(pkg, assetRef)), assetRef).resolves.toBe(sha256);
  }
}

async function readFixture(dir: string): Promise<MotionPackage> {
  const root = join(FIXTURES, dir);
  const [manifest, motion] = await Promise.all([
    readJson(join(root, "manifest.json")),
    readJson(join(root, "motion.json"))
  ]);
  return { root, manifest: manifest as MotionPackage["manifest"], motion: motion as MotionPackage["motion"] };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function preparedResources(pkg: MotionPackage, atMs: number): Promise<{
  images: ReadonlyMap<string, GpuScene2dImageResource>;
  videos: ReadonlyMap<string, GpuScene2dVideoResource>;
  fonts: GpuScene2dFontResources;
}> {
  const images = new Map<string, GpuScene2dImageResource>();
  for (const asset of pkg.motion.assets.filter(isImageAsset)) {
    images.set(asset.source.path, {
      resourceId: `image-${asset.id}`, assetRef: asset.source.path, width: asset.size.width, height: asset.size.height,
      sha256: await hashPackageFile(resolvePackageAsset(pkg, asset.source.path))
    });
  }
  const videos = new Map<string, GpuScene2dVideoResource>();
  for (const layer of pkg.motion.layers.filter((candidate) => candidate.type === "video")) {
    const assetRef = typeof layer.assetRef === "string" ? layer.assetRef : layer.source;
    const asset = pkg.motion.assets.filter(isVideoAsset).find((candidate) => candidate.source.path === assetRef);
    if (!asset || typeof assetRef !== "string") throw new Error(`Video layer ${layer.id} lacks a declared source descriptor.`);
    videos.set(layer.id, {
      layerId: layer.id, resourceId: `video-${layer.id}`, assetRef, width: asset.size.width, height: asset.size.height,
      sha256: await hashPackageFile(resolvePackageAsset(pkg, asset.source.path)), sourceAtMs: atMs
    });
  }
  const faces: readonly GpuScene2dFontResource[] = await Promise.all(pkg.motion.assets.filter(isFontAsset).map(async (asset) => ({
    resourceId: `font-${asset.id}`, assetRef: asset.source.path, family: asset.family, weight: asset.weight, style: asset.style,
    mimeType: asset.source.mimeType, sha256: await hashPackageFile(resolvePackageAsset(pkg, asset.source.path))
  })));
  const fonts = new Map<string, readonly GpuScene2dFontResource[]>();
  for (const face of faces) {
    const key = face.family.toLowerCase();
    fonts.set(key, [...(fonts.get(key) ?? []), face]);
  }
  return { images, videos, fonts };
}

interface ImageAsset { id: string; kind: "image"; source: { path: string }; size: { width: number; height: number }; }
interface VideoAsset { id: string; kind: "video"; source: { path: string }; size: { width: number; height: number }; }
interface FontAsset { id: string; type: "font"; family: string; source: { path: string; mimeType: GpuScene2dFontResource["mimeType"] }; weight: number; style: "normal" | "italic" | "oblique"; }
function isImageAsset(value: unknown): value is ImageAsset { const asset = record(value); return asset?.kind === "image" && typeof asset.id === "string" && source(asset)?.path !== undefined && size(asset)?.width !== undefined && size(asset)?.height !== undefined; }
function isVideoAsset(value: unknown): value is VideoAsset { const asset = record(value); return asset?.kind === "video" && typeof asset.id === "string" && source(asset)?.path !== undefined && size(asset)?.width !== undefined && size(asset)?.height !== undefined; }
function isFontAsset(value: unknown): value is FontAsset { const asset = record(value); const descriptor = source(asset); return asset?.type === "font" && typeof asset.id === "string" && typeof asset.family === "string" && typeof asset.weight === "number" && (asset.style === "normal" || asset.style === "italic" || asset.style === "oblique") && typeof descriptor?.path === "string" && isFontMime(descriptor.mimeType); }
function isFontMime(value: unknown): value is GpuScene2dFontResource["mimeType"] { return value === "font/woff2" || value === "font/woff" || value === "font/ttf" || value === "font/otf"; }
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function source(asset: Record<string, unknown> | null): { path?: string; mimeType?: unknown } | null { const value = record(asset?.source); return value ? { path: typeof value.path === "string" ? value.path : undefined, mimeType: value.mimeType } : null; }
function size(asset: Record<string, unknown> | null): { width?: number; height?: number } | null { const value = record(asset?.size); return value ? { width: typeof value.width === "number" ? value.width : undefined, height: typeof value.height === "number" ? value.height : undefined } : null; }
