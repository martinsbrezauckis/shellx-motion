import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GPU_CAPABILITY, matchRendererCapability } from "./capabilities";
import { resolveGpuSceneChromaKey } from "./gpu-scene-chroma-key";
import { compileGpuScene2dPlan, type GpuScene2dImageResource, type GpuScene2dVideoResource } from "./gpu-scene-2d-plan";
import { compileGpuSceneStaticPlan } from "./gpu-scene-static-plan";
import type { GpuScene2dFontResource, GpuScene2dFontResources } from "./gpu-scene-text";
import { validateMotionDocumentInStages } from "./motion-validation";
import { hashPackageFile, resolvePackageAsset } from "./package";
import type { MotionLayer, MotionPackage } from "./types";
import { loadSchema, validateDocument } from "./validate";

const PRODUCT_PACK_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../templates/shellx-product-pack"
);
const INTER_LICENSE_SHA256 = "3b0a5fca3d17942cde889069889dedbbbd075e9b599968c82a95f4d944e9b345";
const INTER_HASHES = {
  600: "f9a06e79cd3a2a20951c0f0e28f66dd0e6d3fda73911d640a2125c8fcb78f21a",
  800: "a7d0a50f15d389cad679238466bdb5fc9787aa0715719064ce25abaff042820d",
  900: "d5c0ed7b8b5dde97d48b97947d740bbd8ad3ba9f2c5cc6b8280f16acba2d828e"
} as const;

/** The original five promoted rich templates, with admission truth kept per package. */
const RICH_TEMPLATE_MATRIX = [
  {
    dir: "cinematic-rain-launch",
    lanes: ["browser", "ffmpeg", "gpu"], recommendedLane: "gpu",
    assetHashes: {
      "assets/samples/night-street.svg": "de7e4b51d35ec3fae58e1e0b2baeced400dcbdb2fe1329e19213bb7975c44490",
      "assets/masks/rain-occlusion.svg": "aad33d1c363ce31e9f051d49f606f4685e7c21e375b0230b8a35aa1467433aa8",
      "assets/fonts/inter-latin-600-normal.woff2": INTER_HASHES[600],
      "assets/fonts/inter-latin-900-normal.woff2": INTER_HASHES[900]
    }
  },
  {
    dir: "cinematic-fog-title",
    lanes: ["browser", "ffmpeg", "gpu"], recommendedLane: "gpu",
    assetHashes: {
      "assets/samples/alpine-dawn.svg": "99c73c84bbbfeb2614c3a35341544b615840f96ee4f20f23a0945cc7cccbb154",
      "assets/fonts/inter-latin-600-normal.woff2": INTER_HASHES[600],
      "assets/fonts/inter-latin-800-normal.woff2": INTER_HASHES[800]
    }
  },
  {
    dir: "editorial-liquid-surface",
    lanes: ["browser", "ffmpeg", "gpu"], recommendedLane: "gpu",
    assetHashes: {
      "assets/samples/coastal-editorial.svg": "755d88f9efac2a78dd6d0a67dce0114090c811c1769c8894543a743302ae2170",
      "assets/fonts/inter-latin-600-normal.woff2": INTER_HASHES[600],
      "assets/fonts/inter-latin-800-normal.woff2": INTER_HASHES[800],
      "assets/fonts/inter-latin-900-normal.woff2": INTER_HASHES[900]
    }
  },
  {
    dir: "keyed-subject-promo",
    lanes: ["browser", "ffmpeg", "gpu"], recommendedLane: "ffmpeg",
    assetHashes: {
      "assets/generated/atmosphere-fog-rays.mp4": "24cfaf7065119713d771a48d3d47966c13004d95a8671c4cf2e53516c0834c7c",
      "assets/samples/neon-studio.svg": "4766625ed3986536412fa1c74c4abb40d746ea14a624a7e6483ea59582f47409",
      "assets/samples/green-screen-subject.svg": "dde4d37741cc7b83fa3380fb25f6be78aa29c2a910003edc61682335a7047d1a",
      "assets/fonts/inter-latin-600-normal.woff2": INTER_HASHES[600],
      "assets/fonts/inter-latin-900-normal.woff2": INTER_HASHES[900]
    }
  },
  {
    dir: "tracked-callout-overlay",
    lanes: ["browser", "ffmpeg", "gpu"], recommendedLane: "gpu",
    assetHashes: {
      "assets/samples/device-inspection.svg": "19319f2fad13c45891e14d61dbabb5969f4e0fd2815b546f4b6301e33b2d08e9",
      "assets/fonts/inter-latin-600-normal.woff2": INTER_HASHES[600],
      "assets/fonts/inter-latin-900-normal.woff2": INTER_HASHES[900]
    }
  }
] as const;

/**
 * The V25-A admission boundary: keep the product packages' authored temporal
 * controls and source bytes fixed while requiring the strict GPU plan to carry
 * every shutter sample. These are source-level qualifications, not native proof.
 */
const PROMOTED_TEMPORAL_ENVIRONMENT_MATRIX = [
  {
    dir: "cinematic-rain-launch",
    representativeFramesMs: [300, 1500, 3200, 5200],
    environment: {
      layerId: "rain-stage", kind: "rain", samples: 3, shutterAngle: 150,
      scene: { assetRef: "assets/samples/night-street.svg", resourceId: "image-night-street-sample", sha256: "de7e4b51d35ec3fae58e1e0b2baeced400dcbdb2fe1329e19213bb7975c44490" },
      effectMask: { assetRef: "assets/masks/rain-occlusion.svg", resourceId: "image-rain-occlusion-mask", sha256: "aad33d1c363ce31e9f051d49f606f4685e7c21e375b0230b8a35aa1467433aa8" }
    }
  },
  {
    dir: "cinematic-fog-title",
    representativeFramesMs: [500, 1500, 3500, 5000],
    environment: {
      layerId: "fog-stage", kind: "fog", samples: 3, shutterAngle: 140,
      scene: { assetRef: "assets/samples/alpine-dawn.svg", resourceId: "image-alpine-dawn-sample", sha256: "99c73c84bbbfeb2614c3a35341544b615840f96ee4f20f23a0945cc7cccbb154" }
    }
  },
  {
    dir: "editorial-liquid-surface",
    representativeFramesMs: [500, 1500, 3500, 5000],
    environment: {
      layerId: "water-stage", kind: "water", samples: 3, shutterAngle: 120,
      scene: { assetRef: "assets/samples/coastal-editorial.svg", resourceId: "image-coastal-editorial-sample", sha256: "755d88f9efac2a78dd6d0a67dce0114090c811c1769c8894543a743302ae2170" }
    }
  }
] as const;

describe("GPU admission status for promoted rich templates", () => {
  it("pins licensed image and font bytes, declared faces, and truthful lane metadata", async () => {
    for (const status of RICH_TEMPLATE_MATRIX) {
      const pkg = await readRichPackage(status.dir);
      const attributed = pkg.template?.metadata?.assetsAttribution ?? [];
      const fontAssets = pkg.motion.assets.filter(isFontAsset);

      expect(pkg.manifest.compatibility.lanes, status.dir).toEqual(status.lanes);
      expect(pkg.template?.compatibleLanes, status.dir).toEqual(status.lanes);
      expect(pkg.template?.metadata?.performance?.recommendedLane, status.dir).toBe(status.recommendedLane);
      expect(pkg.manifest.assets, status.dir).toEqual(Object.keys(status.assetHashes));
      expect(pkg.template?.metadata?.license).toMatchObject({
        id: "shellx-generated-sample",
        attributionRequired: false,
        redistributionAllowed: true,
        commercialUse: true,
        notes: expect.stringContaining("Inter")
      });

      for (const [assetRef, sha256] of Object.entries(status.assetHashes)) {
        await expect(hashPackageFile(resolvePackageAsset(pkg, assetRef)), `${status.dir}:${assetRef}`).resolves.toBe(sha256);
        if (assetRef.includes("/fonts/")) {
          expect(attributed, `${status.dir}:${assetRef} needs OFL attribution`).toEqual(expect.arrayContaining([
            expect.objectContaining({ path: assetRef, license: "SIL-OFL-1.1", author: "The Inter Project Authors" })
          ]));
        } else {
          expect(attributed, `${status.dir}:${assetRef} needs declared attribution`).toEqual(expect.arrayContaining([
            expect.objectContaining({ path: assetRef, license: "shellx-generated-sample", author: "ShellX Motion" })
          ]));
        }
      }
      await expect(hashPackageFile(resolvePackageAsset(pkg, "assets/fonts/LICENSE-Inter.txt")), `${status.dir}:Inter license`).resolves.toBe(INTER_LICENSE_SHA256);
      expect(fontAssets.map((asset) => asset.weight).sort((left, right) => left - right)).toEqual(
        Object.keys(status.assetHashes).filter((asset) => asset.includes("/fonts/inter-")).map((asset) => Number(/inter-latin-(\d+)-normal/.exec(asset)?.[1])).sort((left, right) => left - right)
      );
      for (const layer of pkg.motion.layers.filter((layer) => layer.type === "text" || layer.type === "caption")) {
        expect(layer.style?.fontFamily, `${status.dir}:${layer.id}`).toBe("Inter, Arial, Helvetica, sans-serif");
        expect(fontAssets.map((asset) => asset.weight), `${status.dir}:${layer.id}`).toContain(layer.style?.fontWeight);
      }
    }
  });

  it("keeps static planning and every representative exact-time resource compile honest per template", async () => {
    for (const status of RICH_TEMPLATE_MATRIX) {
      const pkg = await readRichPackage(status.dir);
      expect(await validateMotionDocumentInStages(pkg.motion), status.dir).toMatchObject({ ok: true });
      const staticPlan = compileGpuSceneStaticPlan(pkg.motion);
      expect(staticPlan, `${status.dir}:static topology`).toMatchObject({ ok: true });
      if (!staticPlan.ok) continue;
      expect(staticPlan.plan.resources.some((resource) => resource.kind === "font"), `${status.dir}:font topology`).toBe(true);
      expect(staticPlan.plan.resources.some((resource) => resource.kind === "image"), `${status.dir}:image topology`).toBe(true);

      const frames = pkg.template?.metadata?.qualityTargets?.representativeFramesMs;
      if (!frames) throw new Error(`${status.dir} is missing representative-frame metadata`);
      for (const atMs of frames) {
        const result = compileGpuScene2dPlan(pkg.motion, atMs, await preparedResources(pkg, atMs));
        expect(result, `${status.dir}:${atMs}`).toMatchObject({ ok: true });
      }
    }
  });

  it("keeps the three V25-A environment packages GPU-admitted with their authored shutter, exact source hashes, and no fallback claim", async () => {
    for (const status of PROMOTED_TEMPORAL_ENVIRONMENT_MATRIX) {
      const pkg = await readRichPackage(status.dir);
      const { environment } = status;
      const effectMask = "effectMask" in environment ? environment.effectMask : undefined;
      const performance = pkg.template?.metadata?.performance;
      expect(pkg.manifest.compatibility.lanes, `${status.dir}:manifest lanes`).toEqual(["browser", "ffmpeg", "gpu"]);
      expect(pkg.template?.compatibleLanes, `${status.dir}:template lanes`).toEqual(["browser", "ffmpeg", "gpu"]);
      expect(performance, `${status.dir}:GPU preference`).toMatchObject({ recommendedLane: "gpu" });
      expect(performance?.notes, `${status.dir}:fallback truth`).toEqual(expect.arrayContaining([
        expect.stringMatching(/strict GPU lane/i),
        expect.stringMatching(/refuses without browser, native, or software fallback/i)
      ]));
      expect(pkg.template?.metadata?.qualityTargets?.representativeFramesMs, `${status.dir}:representative frames`).toEqual(status.representativeFramesMs);
      expect(matchRendererCapability(pkg.motion, GPU_CAPABILITY), `${status.dir}:strict capability admission`).toEqual({ ok: true, lane: "gpu", unsupported: [] });
      expect(compileGpuSceneStaticPlan(pkg.motion), `${status.dir}:static admission`).toMatchObject({ ok: true });

      const authoredLayer = pkg.motion.layers.find((layer) => layer.id === environment.layerId);
      expect(authoredLayer, `${status.dir}:environment layer`).toMatchObject({
        type: "environment",
        environment: { kind: environment.kind },
        effects: { motionBlur: { samples: environment.samples, shutterAngle: environment.shutterAngle } }
      });

      for (const atMs of status.representativeFramesMs) {
        const resources = await preparedResources(pkg, atMs);
        expect(resources.images.get(environment.scene.assetRef), `${status.dir}:${atMs}:scene resource`).toMatchObject({
          resourceId: environment.scene.resourceId, assetRef: environment.scene.assetRef, sha256: environment.scene.sha256
        });
        if (effectMask) {
          expect(resources.images.get(effectMask.assetRef), `${status.dir}:${atMs}:effect-mask resource`).toMatchObject({
            resourceId: effectMask.resourceId, assetRef: effectMask.assetRef, sha256: effectMask.sha256
          });
        }

        const result = compileGpuScene2dPlan(pkg.motion, atMs, resources);
        expect(result, `${status.dir}:${atMs}:frame admission`).toMatchObject({ ok: true });
        if (!result.ok) continue;
        expect(result.plan).toMatchObject({
          atMs,
          environmentCount: 1,
          frame: {
            budget: {
              environmentCount: environment.samples,
              environmentUniformBytes: environment.samples * 208
            }
          }
        });

        const startIndex = result.plan.frame.draws.findIndex((draw) => draw.kind === "motionBlurStart" && draw.id === `${environment.layerId}.motion-blur`);
        expect(startIndex, `${status.dir}:${atMs}:environment temporal group`).toBeGreaterThanOrEqual(0);
        const shutterDurationMs = (1_000 / pkg.motion.fps) * (environment.shutterAngle / 360);
        const start = result.plan.frame.draws[startIndex];
        expect(start, `${status.dir}:${atMs}:environment temporal start`).toMatchObject({
          kind: "motionBlurStart",
          id: `${environment.layerId}.motion-blur`,
          sampleCount: environment.samples,
          drawCount: environment.samples,
          shutterAngle: environment.shutterAngle,
          shutterDurationMs
        });
        const samples = result.plan.frame.draws.slice(startIndex + 1, startIndex + 1 + environment.samples);
        expect(samples, `${status.dir}:${atMs}:environment sample count`).toHaveLength(environment.samples);
        const expectedSampleTimes = Array.from({ length: environment.samples }, (_unused, sampleIndex) => (
          (atMs + ((sampleIndex / (environment.samples - 1)) - 0.5) * shutterDurationMs) / 1_000
        ));
        const environmentSamples = samples.filter((draw) => draw.kind === "environment");
        expect(environmentSamples, `${status.dir}:${atMs}:environment-only samples`).toHaveLength(environment.samples);
        expect(environmentSamples.map((draw) => draw.timeSeconds), `${status.dir}:${atMs}:exact shutter times`).toEqual(expectedSampleTimes);
        for (const sample of environmentSamples) {
          expect(sample, `${status.dir}:${atMs}:uncomposited sample`).toMatchObject({
            environmentKind: environment.kind,
            sceneResourceId: environment.scene.resourceId,
            blendMode: "normal",
            effects: null,
            opacity: 1 / environment.samples
          });
          expect(sample.colors.some((color) => color.a > 1 / environment.samples), `${status.dir}:${atMs}:authored colours are not attenuated`).toBe(true);
          if (effectMask) expect(sample.effectMaskResourceId, `${status.dir}:${atMs}:effect-mask binding`).toBe(effectMask.resourceId);
          else expect(sample.effectMaskResourceId, `${status.dir}:${atMs}:no invented effect mask`).toBeUndefined();
        }
        expect(result.plan.frame.draws[startIndex + environment.samples + 1], `${status.dir}:${atMs}:environment temporal end`).toMatchObject({
          kind: "motionBlurEnd", groupId: `${environment.layerId}.motion-blur`
        });
      }
    }
  });

  it("marks keyed active video as a bounded preview contract while retaining its admitted GPU-frame final path", async () => {
    const pkg = await readRichPackage("keyed-subject-promo");
    expect(pkg.manifest.compatibility.lanes).toContain("gpu");
    const performance = pkg.template?.metadata?.performance;
    expect(performance?.recommendedLane).toBe("ffmpeg");
    const notes = performance?.notes?.join(" ") ?? "";
    expect(notes).toMatch(/V25-B1 visual-only preview/i);
    expect(notes).toMatch(/host-owned exact-time CFR video provider/i);
    expect(notes).toMatch(/existing render --lane ffmpeg --frame-lane gpu final path/i);
    expect(notes).toMatch(/Preview does not attest audio, final-video staging, encoding, or mux/i);
    expect(notes).not.toMatch(/native acceptance/i);
    const subject = pkg.motion.layers.find((layer) => layer.id === "subject") as MotionLayer | undefined;
    if (!subject) throw new Error("keyed-subject-promo is missing its subject layer");
    expect(subject.keying?.matte).toMatchObject({
      denoiseRadiusPx: 1, growShrinkPx: -1, chokePx: 1, featherPx: 2, blackClip: 0.04, whiteClip: 0.96
    });
    expect(resolveGpuSceneChromaKey(subject)).toMatchObject({ ok: true, chromaKey: { matte: subject.keying?.matte } });
    const staticPlan = compileGpuSceneStaticPlan(pkg.motion);
    expect(staticPlan).toMatchObject({ ok: true });
    if (!staticPlan.ok) return;
    expect(staticPlan.plan.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "video", assetRef: "assets/generated/atmosphere-fog-rays.mp4" })
    ]));
  });
});

/**
 * Package loading normally enforces output-path ownership. This source-tree
 * fixture test deliberately reads fixed repository assets only, so it keeps
 * validation useful in the managed sandbox where `/` is synthetic uid 65534.
 */
async function readRichPackage(dir: string): Promise<MotionPackage> {
  const root = join(PRODUCT_PACK_ROOT, dir);
  const [manifest, motion, template] = await Promise.all([
    readJson(join(root, "manifest.json")),
    readJson(join(root, "motion.json")),
    readJson(join(root, "template.json"))
  ]);
  const [manifestSchema, templateSchema] = await Promise.all([loadSchema("packageManifest"), loadSchema("template")]);
  expect(await validateDocument(manifestSchema, manifest), `${dir}:manifest schema`).toEqual({ ok: true });
  expect(await validateDocument(templateSchema, template), `${dir}:template schema`).toEqual({ ok: true });
  return { root, manifest: manifest as MotionPackage["manifest"], motion: motion as MotionPackage["motion"], template: template as NonNullable<MotionPackage["template"]> };
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
      resourceId: `image-${asset.id}`,
      assetRef: asset.source.path,
      width: asset.size.width,
      height: asset.size.height,
      sha256: await hashPackageFile(resolvePackageAsset(pkg, asset.source.path))
    });
  }
  const videos = new Map<string, GpuScene2dVideoResource>();
  for (const layer of pkg.motion.layers.filter((candidate) => candidate.type === "video")) {
    const assetRef = typeof layer.assetRef === "string" ? layer.assetRef : typeof layer.source === "string" ? layer.source : undefined;
    const asset = pkg.motion.assets.filter(isVideoAsset).find((candidate) => candidate.source.path === assetRef);
    if (!asset || !assetRef) throw new Error(`GPU video layer ${layer.id} has no declared exact resource descriptor.`);
    videos.set(layer.id, {
      layerId: layer.id,
      resourceId: `video-${layer.id}`,
      assetRef,
      width: asset.size.width,
      height: asset.size.height,
      sha256: await hashPackageFile(resolvePackageAsset(pkg, asset.source.path)),
      sourceAtMs: atMs
    });
  }
  const fonts = new Map<string, readonly GpuScene2dFontResource[]>();
  const faces: readonly GpuScene2dFontResource[] = await Promise.all(pkg.motion.assets.filter(isFontAsset).map(async (asset) => ({
    resourceId: `font-${asset.id}`,
    assetRef: asset.source.path,
    family: asset.family,
    weight: asset.weight,
    style: asset.style,
    mimeType: asset.source.mimeType,
    sha256: await hashPackageFile(resolvePackageAsset(pkg, asset.source.path))
  })));
  if (faces.length > 0) fonts.set("inter", faces);
  return { images, videos, fonts };
}

interface ImageAsset {
  id: string;
  kind: "image";
  source: { path: string };
  size: { width: number; height: number };
}
interface VideoAsset {
  id: string;
  kind: "video";
  source: { path: string };
  size: { width: number; height: number };
}
interface FontAsset {
  id: string;
  type: "font";
  family: string;
  source: { path: string; mimeType: "font/woff2" | "font/woff" | "font/ttf" | "font/otf" };
  weight: number;
  style: "normal" | "italic" | "oblique";
}
function isImageAsset(value: unknown): value is ImageAsset {
  const asset = record(value); return asset?.kind === "image" && typeof asset.id === "string" && source(asset)?.path !== undefined && size(asset)?.width !== undefined && size(asset)?.height !== undefined;
}
function isVideoAsset(value: unknown): value is VideoAsset {
  const asset = record(value); return asset?.kind === "video" && typeof asset.id === "string" && source(asset)?.path !== undefined && size(asset)?.width !== undefined && size(asset)?.height !== undefined;
}
function isFontAsset(value: unknown): value is FontAsset {
  const asset = record(value); const font = source(asset); return asset?.type === "font" && typeof asset.id === "string" && typeof asset.family === "string" && typeof asset.weight === "number" && (asset.style === "normal" || asset.style === "italic" || asset.style === "oblique") && font?.mimeType !== undefined && font.path !== undefined;
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function source(asset: Record<string, unknown> | null): { path?: string; mimeType?: FontAsset["source"]["mimeType"] } | null {
  const value = record(asset?.source); return value && typeof value.path === "string" ? { path: value.path, ...(typeof value.mimeType === "string" ? { mimeType: value.mimeType as FontAsset["source"]["mimeType"] } : {}) } : null;
}
function size(asset: Record<string, unknown> | null): { width?: number; height?: number } | null {
  const value = record(asset?.size); return value && typeof value.width === "number" && typeof value.height === "number" ? { width: value.width, height: value.height } : null;
}
