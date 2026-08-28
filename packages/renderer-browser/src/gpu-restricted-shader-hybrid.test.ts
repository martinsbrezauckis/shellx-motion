import type { MotionPackage } from "@shellx-motion/core";
import { describe, expect, it } from "vitest";
import { assertRestrictedShaderCaptureEvidence, isGpuRestrictedShaderHybridPackage } from "./gpu-restricted-shader-hybrid";

describe("GPU restricted shader hybrid source", () => {
  it("classifies a package GLSL layer as one isolated restricted hybrid rather than a browser HTML surface", () => {
    expect(isGpuRestrictedShaderHybridPackage(shaderPackage("/test"))).toBe(true);
  });

  it("fails closed when the renderer evidence binds bytes other than the stable source snapshot", async () => {
    const pkg = shaderPackage("/test"); const layer = pkg.motion.layers[0];
    expect(() => assertRestrictedShaderCaptureEvidence({
      output: { network: { approvedOrigins: [] }, scriptExecution: { activeMode: "data-only", sources: [] }, shaders: { layers: [{ layerId: "legacy", assetRef: "assets/legacy.glsl", sha256: "b".repeat(64), bytes: 64 }] } } as never, inputHashes: { "assets/legacy.glsl": "a".repeat(64) },
      layer, assetRef: "assets/legacy.glsl", sourceSha256: "a".repeat(64), sourceBytes: 64
    })).toThrow(/stable-source WebGL evidence/);
  });
});

function shaderPackage(root: string): MotionPackage { return { root, manifest: { schema: "shellx-motion/package-manifest@1", id: "shader-hybrid", name: "shader hybrid", motion: "motion.json", assets: ["assets/legacy.glsl"], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } }, motion: { schema: "shellx-motion/motion@1", id: "shader-hybrid", name: "shader hybrid", durationMs: 1_000, fps: 1, width: 16, height: 16, assets: [{ id: "legacy", type: "shader", source: { path: "assets/legacy.glsl", mimeType: "text/x-shellx-motion-glsl" } }], provenance: { sourceApp: "test", createdBy: "test" }, layers: [{ id: "legacy", type: "shader", startMs: 0, durationMs: 1_000, transform: { width: 16, height: 16 }, shader: { schema: "shellx-motion/shader-plugin@1", language: "glsl-es-100-expression", fragmentAssetId: "legacy", seed: 1, fallbackColor: "#000000" } }] } }; }
