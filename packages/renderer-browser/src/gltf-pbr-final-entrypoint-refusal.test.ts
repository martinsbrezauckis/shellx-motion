import { describe, expect, it } from "vitest";
import { GltfPbrFinalEntrypointError, gltfPbrFinalEntrypointRefusal } from "./gltf-pbr-final-entrypoint-refusal";
import { createGpuPreviewSession } from "./gpu-points-preview";
import { renderMotionBrowserFrame } from "./index";

const marked = {
  manifest: { data: { adapter: { scene3dGltfPbrFinal: { schema: "untrusted", sceneLayerId: "gltf-scene" } } } },
} as never;

describe("marked glTF PBR generic-entrypoint refusal", () => {
  it.each(["browser-preview", "gpu-preview"] as const)("refuses %s by marker presence before generic resource planning", (entrypoint) => {
    const refusal = gltfPbrFinalEntrypointRefusal(marked, entrypoint);
    expect(refusal).toEqual({
      code: "gltf_pbr_final_direct_final_only",
      message: expect.stringContaining("1280x720 static GPU direct-final"),
    });
    expect(new GltfPbrFinalEntrypointError(refusal!)).toMatchObject({
      code: "gltf_pbr_final_direct_final_only",
      name: "GltfPbrFinalEntrypointError",
    });
  });

  it("leaves no-marker generic routes untouched", () => {
    expect(gltfPbrFinalEntrypointRefusal({ manifest: { data: { adapter: {} } } } as never, "browser-preview")).toBeUndefined();
  });

  it("blocks both production generic render entrypoints before any resource opener", async () => {
    await expect(renderMotionBrowserFrame(marked, { atMs: 0, outDir: "/never-created" })).rejects.toMatchObject({
      code: "gltf_pbr_final_direct_final_only",
    });
    const gpu = createGpuPreviewSession(marked);
    await expect(gpu.renderFrame({ atMs: 0, outDir: "/never-created" })).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({ code: "gltf_pbr_final_direct_final_only" }),
    });
    await gpu.close();
  });
});
