import { describe, expect, it, vi } from "vitest";

const marker = vi.hoisted(() => vi.fn());
const resolvePbr = vi.hoisted(() => vi.fn());
const resolveGeneric = vi.hoisted(() => vi.fn());

vi.mock("@shellx-motion/renderer-browser/internal/scene3d-gltf-pbr-final", () => ({
  hasGpuScene3dGltfPbrFinalRouteMarker: marker,
  resolveGpuScene3dGltfPbrFinalRoute: resolvePbr,
}));
vi.mock("@shellx-motion/renderer-browser", () => ({
  gpuEffectModuleFinalReceiptEvidence: vi.fn(),
  resolveGpuEffectModuleStaticPlanForUse: resolveGeneric,
}));

import { preflightGpuFinalDelivery, renderStreamingFinalUnpublished } from "./streaming-final-adapter-execution.js";

const pkg = { root: "/unused", manifest: { id: "pkg", assets: [], motion: "motion.json", data: {} }, motion: { width: 1280, height: 720, fps: 30, durationMs: 1000, layers: [] } } as never;

describe("fixed glTF PBR final dispatch", () => {
  it("does not invoke the generic GPU static/session branch when the marker resolves", async () => {
    marker.mockReturnValue(true);
    resolvePbr.mockResolvedValue({ kind: "present", route: { fingerprint: "a".repeat(64) } });
    resolveGeneric.mockReset();
    await expect(preflightGpuFinalDelivery({ pkg, frameLane: "gpu", outputPath: "/unused.mp4" })).resolves.toMatchObject({ ok: true, pbrRoute: { route: { fingerprint: "a".repeat(64) } } });
    expect(resolvePbr).toHaveBeenCalledWith(pkg);
    expect(resolveGeneric).not.toHaveBeenCalled();
  });

  it("keeps the no-marker legacy generic preflight golden unchanged", async () => {
    marker.mockReturnValue(false); resolvePbr.mockReset();
    resolveGeneric.mockResolvedValue({ ok: true, plan: { resources: [], effectModules: undefined } });
    await expect(preflightGpuFinalDelivery({ pkg, frameLane: "gpu", outputPath: "/unused.mp4" })).resolves.toMatchObject({ ok: true, staticPlan: { resources: [] } });
    expect(resolvePbr).not.toHaveBeenCalled(); expect(resolveGeneric).toHaveBeenCalledOnce();
  });

  it("refuses a stale canonical source scene before Browser or generic GPU planning", async () => {
    marker.mockReturnValue(true); resolveGeneric.mockReset(); resolvePbr.mockRejectedValue(new Error("exact immutable canonical source-lowered scene state"));
    await expect(preflightGpuFinalDelivery({ pkg, frameLane: "gpu", outputPath: "/unused.mp4" })).resolves.toMatchObject({ ok: false, failure: { code: "gpu_resource_refused", message: expect.stringContaining("exact immutable canonical source-lowered scene state") } });
    expect(resolveGeneric).not.toHaveBeenCalled();
  });

  it.each(["browser", "native"] as const)("refuses marked packages before %s final fallback resources", async (frameLane) => {
    marker.mockReturnValue(true); resolvePbr.mockReset(); resolveGeneric.mockReset();
    await expect(renderStreamingFinalUnpublished({ pkg, frameLane, outputPath: "/unused.mp4" })).resolves.toMatchObject({
      ok: false,
      error: { code: "gltf_pbr_final_direct_final_only" },
    });
    expect(resolvePbr).not.toHaveBeenCalled();
    expect(resolveGeneric).not.toHaveBeenCalled();
  });
});
