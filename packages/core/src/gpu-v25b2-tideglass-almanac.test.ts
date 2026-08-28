import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileGpuScene2dPlan } from "./gpu-scene-2d-plan";
import { compileGpuSceneStaticPlan } from "./gpu-scene-static-plan";
import { validateMotionDocumentInStages } from "./motion-validation";
import { validateRestrictedFragmentShader } from "./shader-plugin";
import type { MotionPackage } from "./types";
import { loadSchema, validateDocument } from "./validate";

const ROOT = fileURLToPath(new URL("../../../fixtures/packages/gpu-v25b2-tideglass-almanac", import.meta.url));
const SHADER_ASSET = "assets/tideglass-almanac.glsl";
const SHADER_SHA256 = "6446d73b702e9b6f066a1af82e999992eb8ed4eabd10a9be4db56c408cbca44b";
const BOUNDARY_AND_ADJACENT_TIMES = [0, 2_999, 3_000, 3_001, 5_999, 6_000, 6_001, 8_999, 9_000, 9_001, 11_999] as const;
const EXPECTED_RANGES = [
  { index: 0, startFrame: 0, endFrameExclusive: 90 },
  { index: 1, startFrame: 90, endFrameExclusive: 180 },
  { index: 2, startFrame: 180, endFrameExclusive: 270 },
  { index: 3, startFrame: 270, endFrameExclusive: 360 }
] as const;

/**
 * Source and accepted-native fixture preflight. `loadMotionPackage` intentionally owns stable-file/output
 * topology, which the managed WSL sandbox does not grant to tests. Read package files directly
 * here so schema, semantic, shader, static-plan, and exact-time plan evidence remain testable
 * without a CLI output root or renderer launch; native segmented evidence is documented separately.
 */
describe("Tideglass Almanac V25-B2 restricted-shader hybrid source fixture", () => {
  it("keeps one bounded hybrid surface stable through all four intended 90-frame arcs", async () => {
    const fixture = await readFixture();
    const { pkg, shaderSource, rawManifest } = fixture;

    expect(await validateDocument(await loadSchema("packageManifest"), pkg.manifest)).toEqual({ ok: true });
    expect(await validateMotionDocumentInStages(pkg.motion)).toMatchObject({ ok: true });
    expect(pkg.manifest.compatibility).toEqual({ lanes: ["gpu"], hosts: ["motion"] });
    expect(pkg.manifest.assets).toEqual([SHADER_ASSET]);
    expect(rawManifest.metadata).toMatchObject({
      hybridSurface: "one-isolated-restricted-glsl-texture",
      segmentFrames: 90,
      acceptance: "native-qualified-restricted-glsl-resume-cold-replay-accepted"
    });
    expect(pkg.motion).toMatchObject({ durationMs: 12_000, fps: 30, width: 1_920, height: 1_080 });
    const frameCount = pkg.motion.durationMs * pkg.motion.fps / 1_000;
    expect(frameCount).toBe(360);
    const ranges = Array.from({ length: 4 }, (_, index) => ({
      index,
      startFrame: index * (frameCount / 4),
      endFrameExclusive: (index + 1) * (frameCount / 4)
    }));
    expect(ranges).toEqual(EXPECTED_RANGES);
    expect(pkg.motion.markers?.map((marker) => marker.atMs)).toEqual([0, 3_000, 6_000, 9_000]);
    expect(pkg.motion.layers.some((layer) => ["audio", "canvas", "html", "video", "web"].includes(layer.type))).toBe(false);

    const shaderLayer = pkg.motion.layers.find((layer) => layer.id === "tideglass-window");
    expect(shaderLayer).toMatchObject({
      type: "shader",
      transform: { width: 1_600, height: 900 },
      mask: { type: "rounded-rect", radius: 86 },
      shader: {
        schema: "shellx-motion/shader-plugin@1",
        language: "glsl-es-100-expression",
        fragmentAssetId: "tideglass-fragment",
        seed: 20260815,
        uniforms: { u_speed: 0.18, u_drift: 0.22 }
      }
    });
    if (!shaderLayer?.shader) throw new Error("Tideglass fixture lost its one restricted-shader layer.");
    expect(pkg.motion.layers.filter((layer) => layer.type === "shader" && !layer.shader?.gpuMaterial)).toHaveLength(1);
    expect(Buffer.byteLength(shaderSource)).toBe(668);
    expect(createHash("sha256").update(shaderSource).digest("hex")).toBe(SHADER_SHA256);
    expect(validateRestrictedFragmentShader(shaderSource, Object.keys(shaderLayer.shader.uniforms ?? {}))).toMatchObject({ ok: true, errors: [] });

    const staticPlan = compileGpuSceneStaticPlan(pkg.motion);
    expect(staticPlan).toMatchObject({
      ok: true,
      plan: {
        canonicalFrameCount: 360,
        maxima: { maxBrowserSurfaceCount: 1, maxMaterialCount: 0 },
        resources: [{
          kind: "browser-surface",
          assetRef: SHADER_ASSET,
          consumers: [{ layerId: "tideglass-window", role: "governed-restricted-shader-surface" }]
        }]
      }
    });
    if (!staticPlan.ok) return;

    const resource = {
      resourceId: "tideglass-source-fixture",
      assetRef: SHADER_ASSET,
      width: 1_600,
      height: 900,
      sha256: SHADER_SHA256
    };
    const fingerprints = new Set<string>();
    for (const atMs of BOUNDARY_AND_ADJACENT_TIMES) {
      const frame = compileGpuScene2dPlan(pkg.motion, atMs, {
        browserSurfaces: new Map([["tideglass-window", resource]])
      });
      expect(frame, `Tideglass source plan at ${atMs}ms`).toMatchObject({ ok: true });
      if (!frame.ok) continue;
      fingerprints.add(frame.plan.frame.fingerprint);
      expect(frame.plan).toMatchObject({ browserSurfaceCount: 1, materialCount: 0 });
      expect(frame.plan.frame.draws).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "image", id: "tideglass-window", resourceId: "tideglass-source-fixture", width: 1_600, height: 900 })
      ]));
    }
    expect(fingerprints.size).toBe(BOUNDARY_AND_ADJACENT_TIMES.length);
  });
});

async function readFixture(): Promise<{ pkg: MotionPackage; shaderSource: string; rawManifest: Record<string, unknown> }> {
  const [manifestText, motionText, shaderSource] = await Promise.all([
    readFile(join(ROOT, "manifest.json"), "utf8"),
    readFile(join(ROOT, "motion.json"), "utf8"),
    readFile(join(ROOT, SHADER_ASSET), "utf8")
  ]);
  const rawManifest = JSON.parse(manifestText) as Record<string, unknown>;
  return {
    pkg: { root: ROOT, manifest: rawManifest as unknown as MotionPackage["manifest"], motion: JSON.parse(motionText) as MotionPackage["motion"] },
    shaderSource,
    rawManifest
  };
}
