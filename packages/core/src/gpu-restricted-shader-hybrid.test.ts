import { compileGpuScene2dPlan } from "./gpu-scene-2d-plan";
import { compileGpuSceneStaticPlan } from "./gpu-scene-static-plan";
import type { MotionDocument } from "./types";
import { describe, expect, it } from "vitest";

function document(overrides: Partial<MotionDocument> = {}): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "restricted-hybrid", name: "Restricted hybrid", durationMs: 1_000, fps: 1, width: 64, height: 64, background: "transparent",
    assets: [{ id: "legacy", type: "shader", source: { path: "assets/legacy.glsl", mimeType: "text/x-shellx-motion-glsl" } }], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [
      { id: "back", type: "shape", shape: "rect", fill: "#ff0000", startMs: 0, durationMs: 1_000, transform: { width: 64, height: 64 } },
      { id: "legacy", type: "shader", startMs: 0, durationMs: 1_000, blendMode: "screen", transform: { x: 8, y: 6, width: 32, height: 16 }, shader: { schema: "shellx-motion/shader-plugin@1", language: "glsl-es-100-expression", fragmentAssetId: "legacy", seed: 7, fallbackColor: "#000000", uniforms: { u_phase: 1 } } },
      { id: "front", type: "shape", shape: "rect", fill: "#00ff00", startMs: 0, durationMs: 1_000, transform: { width: 64, height: 64 } }
    ], ...overrides
  };
}

describe("GPU restricted shader hybrid topology", () => {
  it("keeps package GLSL out of the GPU plan while composing a native-shader-native stack", () => {
    const motion = document();
    const staticPlan = compileGpuSceneStaticPlan(motion);
    expect(staticPlan).toMatchObject({ ok: true, plan: { maxima: { maxBrowserSurfaceCount: 1, maxMaterialCount: 0 }, resources: [{ kind: "browser-surface", assetRef: "assets/legacy.glsl", consumers: [{ layerId: "legacy", role: "governed-restricted-shader-surface" }] }] } });
    const frame = compileGpuScene2dPlan(motion, 0, { browserSurfaces: new Map([["legacy", { resourceId: "isolated-legacy", assetRef: "assets/legacy.glsl", width: 32, height: 16, sha256: "a".repeat(64) }]]) });
    expect(frame.ok).toBe(true); if (!frame.ok) return;
    expect(frame.plan.frame.draws.map((draw) => `${draw.kind}:${draw.id}`)).toEqual(["rect:back", "image:legacy", "rect:front"]);
    expect(JSON.stringify(frame.plan)).not.toContain("motionMain");
    expect(frame.plan).toMatchObject({ browserSurfaceCount: 1, materialCount: 0 });
  });

  it("refuses multiple hybrid producers, active scripts, and shader network declarations before staging", () => {
    const multiple = document({ layers: [...document().layers, { ...document().layers[1], id: "legacy-2", startMs: 0, durationMs: 1_000 }] });
    expect(compileGpuSceneStaticPlan(multiple)).toMatchObject({ ok: false, failure: { code: "gpu_resource_refused", message: expect.stringContaining("exactly one visible package GLSL") } });
    const active = document() as MotionDocument & Record<string, unknown>;
    active["x-shellx-motion-script-execution"] = { schema: "shellx-motion/script-execution-request@1", requestedMode: "trusted-local-agent-authored" };
    expect(compileGpuSceneStaticPlan(active)).toMatchObject({ ok: false, failure: { message: expect.stringContaining("refuses active") } });
    const network = document(); network.layers[1].allowedOrigins = ["https://invalid.example"];
    expect(compileGpuSceneStaticPlan(network)).toMatchObject({ ok: false, failure: { layerId: "legacy", message: expect.stringContaining("accepts declared shader uniforms") } });
  });
});
