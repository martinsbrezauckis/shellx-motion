import { describe, expect, it } from "vitest";
import { GltfPbrFinalEntrypointError, gltfPbrFinalEntrypointRefusal } from "./gltf-pbr-final-entrypoint-refusal";
import { createGpuPreviewSession } from "./gpu-points-preview";
import { createMotionBrowserRenderSession, preflightBrowserPackage, renderMotionBrowserFrame } from "./index";

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

  it.each([
    ["data array", []],
    ["data scalar", "loader metadata"],
    ["adapter array", { adapter: [] }],
    ["adapter scalar", { adapter: "loader metadata" }],
    ["non-marker record", { adapter: {} }],
  ] as const)("keeps descriptor-safe %s manifest data on ordinary Browser and GPU routes", async (_kind, data) => {
    const browser = genericPackage(data);
    expect(gltfPbrFinalEntrypointRefusal(browser, "browser-preview")).toBeUndefined();
    await expect(preflightBrowserPackage(browser)).resolves.toMatchObject({ ok: true, htmlEntries: [], blockedOrigins: [], warnings: [] });

    const gpuPackage = genericPackage(data, true);
    let resourcePreparations = 0, runtimeOpens = 0, outputPathResolutions = 0;
    const gpu = createGpuPreviewSession(gpuPackage, {
      async prepareResourcesForTest() { resourcePreparations += 1; throw new Error("resources must not prepare"); },
      async openRuntime() { runtimeOpens += 1; throw new Error("runtime must not open"); },
      async resolveOutputPathForTest() { outputPathResolutions += 1; return "/never-created/output.png"; },
    });
    await expect(gpu.renderFrame({ atMs: 0, outDir: "/never-created" })).resolves.toMatchObject({
      ok: false,
      error: { code: "color_pipeline_unsupported" },
    });
    await gpu.close();
    expect({ resourcePreparations, runtimeOpens, outputPathResolutions }).toEqual({ resourcePreparations: 0, runtimeOpens: 0, outputPathResolutions: 0 });
  });

  it("blocks generic Browser preflight and both production render entrypoints before Motion or resource access", async () => {
    await expect(preflightBrowserPackage(marked)).resolves.toEqual({
      ok: false,
      htmlEntries: [],
      blockedOrigins: [],
      warnings: [expect.stringContaining("1280x720 static GPU direct-final")],
    });
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

  it.each(["manifest", "data", "adapter", "marker"] as const)("refuses a hostile %s marker getter without evaluating package authority", async (kind) => {
    const { pkg, reads } = hostileMarkerPackage(kind);
    let browserLaunches = 0, resourcePreparations = 0, runtimeOpens = 0, outputPathResolutions = 0;
    await expect(preflightBrowserPackage(pkg)).resolves.toEqual({
      ok: false,
      htmlEntries: [],
      blockedOrigins: [],
      warnings: [expect.stringContaining("direct-final")],
    });
    await expect(createMotionBrowserRenderSession(pkg, {
      async launchBrowser() { browserLaunches += 1; throw new Error("browser must not launch"); },
    })).rejects.toMatchObject({ code: "gltf_pbr_final_direct_final_only" });
    const gpu = createGpuPreviewSession(pkg, {
      async prepareResourcesForTest() { resourcePreparations += 1; throw new Error("resources must not prepare"); },
      async openRuntime() { runtimeOpens += 1; throw new Error("runtime must not open"); },
      async resolveOutputPathForTest() { outputPathResolutions += 1; return "/never-created/output.png"; },
    });
    await expect(gpu.renderFrame({ atMs: 0, outDir: "/never-created" })).resolves.toMatchObject({
      ok: false,
      error: { code: "gltf_pbr_final_direct_final_only" },
    });
    await gpu.close();
    expect(reads).toEqual({ manifest: 0, data: 0, adapter: 0, marker: 0, motion: 0 });
    expect({ browserLaunches, resourcePreparations, runtimeOpens, outputPathResolutions }).toEqual({ browserLaunches: 0, resourcePreparations: 0, runtimeOpens: 0, outputPathResolutions: 0 });
  });

  it.each(["revoked proxy", "reflection-hostile proxy"] as const)("fails closed for %s metadata without getter or allocation work", async (kind) => {
    const { pkg, reads } = hostileDataPackage(kind);
    let browserLaunches = 0, resourcePreparations = 0, runtimeOpens = 0, outputPathResolutions = 0;
    await expect(preflightBrowserPackage(pkg)).resolves.toMatchObject({ ok: false, warnings: [expect.stringContaining("descriptor-unsafe glTF PBR marker path")] });
    await expect(createMotionBrowserRenderSession(pkg, {
      async launchBrowser() { browserLaunches += 1; throw new Error("browser must not launch"); },
    })).rejects.toMatchObject({ code: "gltf_pbr_final_direct_final_only" });
    const gpu = createGpuPreviewSession(pkg, {
      async prepareResourcesForTest() { resourcePreparations += 1; throw new Error("resources must not prepare"); },
      async openRuntime() { runtimeOpens += 1; throw new Error("runtime must not open"); },
      async resolveOutputPathForTest() { outputPathResolutions += 1; return "/never-created/output.png"; },
    });
    await expect(gpu.renderFrame({ atMs: 0, outDir: "/never-created" })).resolves.toMatchObject({ ok: false, error: { code: "gltf_pbr_final_direct_final_only" } });
    await gpu.close();
    expect(reads).toMatchObject({ motion: 0, gets: 0 });
    if (kind === "revoked proxy") expect(reads.reflections).toBe(0);
    else expect(reads.reflections).toBeGreaterThan(0);
    expect({ browserLaunches, resourcePreparations, runtimeOpens, outputPathResolutions }).toEqual({ browserLaunches: 0, resourcePreparations: 0, runtimeOpens: 0, outputPathResolutions: 0 });
  });
});

function genericPackage(data: unknown, strict = false) {
  return {
    root: "/never-created",
    manifest: { id: "generic-marker-probe", data },
    motion: {
      assets: [],
      layers: [],
      ...(strict ? { colorPipeline: { schema: "shellx-motion/color-pipeline@1", intent: "linear-srgb-sdr@1" } } : {}),
    },
  } as never;
}

function hostileMarkerPackage(kind: "manifest" | "data" | "adapter" | "marker") {
  const reads = { manifest: 0, data: 0, adapter: 0, marker: 0, motion: 0 };
  const manifest: Record<string, unknown> = {};
  const motion = {};
  const pkg = { root: "/never-created", manifest, motion } as never;
  if (kind === "manifest") {
    Object.defineProperty(pkg, "manifest", { configurable: true, enumerable: true, get() { reads.manifest += 1; return manifest; } });
  } else if (kind === "data") {
    Object.defineProperty(manifest, "data", { configurable: true, enumerable: true, get() { reads.data += 1; return { adapter: {} }; } });
  } else {
    const data: Record<string, unknown> = {};
    Object.defineProperty(manifest, "data", { configurable: true, enumerable: true, value: data });
    if (kind === "adapter") {
      Object.defineProperty(data, "adapter", { configurable: true, enumerable: true, get() { reads.adapter += 1; return {}; } });
    } else {
      const adapter: Record<string, unknown> = {};
      Object.defineProperty(data, "adapter", { configurable: true, enumerable: true, value: adapter });
      Object.defineProperty(adapter, "scene3dGltfPbrFinal", { configurable: true, enumerable: true, get() { reads.marker += 1; return {}; } });
    }
  }
  Object.defineProperty(pkg, "motion", { configurable: true, enumerable: true, get() { reads.motion += 1; return motion; } });
  return { pkg, reads };
}

function hostileDataPackage(kind: "revoked proxy" | "reflection-hostile proxy") {
  const reads = { motion: 0, gets: 0, reflections: 0 };
  let data: object;
  if (kind === "revoked proxy") {
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    data = revocable.proxy;
  } else {
    data = new Proxy({}, {
      get() { reads.gets += 1; throw new Error("metadata getters must not run"); },
      getPrototypeOf() { reads.reflections += 1; throw new Error("metadata reflection is hostile"); },
    });
  }
  const motion = {};
  const pkg = { root: "/never-created", manifest: { data }, motion } as never;
  Object.defineProperty(pkg, "motion", { configurable: true, enumerable: true, get() { reads.motion += 1; return motion; } });
  return { pkg, reads };
}
