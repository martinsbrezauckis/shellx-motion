import { describe, expect, it } from "vitest";
import { buildGeneratedMotionHtml, createMotionBrowserRenderSession, loadHtmlComposition, preflightBrowserPackage, prepareGpuSceneResources, renderBrowserFrame } from "./index";
import type { MotionPackage } from "@shellx-motion/core";
import { resolveGpuEffectModuleStaticPlanForUse } from "./gpu-effect-module-use-authority";
import { createGpuPreviewSession, renderMotionGpuPreview } from "./gpu-points-preview";
import { createGpuStreamingFrameProducer } from "./gpu-streaming-producer";

describe("scene3dAnimation@1 Browser refusal", () => {
  it("refuses a present layout-gap root before Browser or GPU preview resource work", async () => {
    const pkg = browserPackage(animationStore());
    delete pkg.motion.scene3dAnimation;
    pkg.motion.layoutGapAnimation = { schema: "shellx-motion/layout-gap-animation@1", tracks: [] } as never;
    await expect(buildGeneratedMotionHtml(pkg, 0)).rejects.toThrow("Browser rendering does not yet support document layoutGapAnimation@1.");
    await expect(preflightBrowserPackage(pkg)).resolves.toEqual({ ok: false, htmlEntries: [], blockedOrigins: [], warnings: ["Browser rendering does not yet support document layoutGapAnimation@1."] });
    let opens = 0;
    const preview = createGpuPreviewSession(pkg, { openRuntime: async () => { opens += 1; throw new Error("GPU runtime must not open"); } });
    await expect(preview.renderFrame({ outDir: "/not-opened-layout-gap-gpu-output" })).resolves.toMatchObject({ ok: false, error: { code: "gpu_unsupported_feature", message: "GPU frame planning does not yet support document layoutGapAnimation@1." } });
    await preview.close();
    expect(opens).toBe(0);
  });

  it("refuses malformed and present roots before HTML lowering, fulfillment reads, or browser launch", async () => {
    for (const animation of [animationStore(), { schema: "shellx-motion/scene3d-animation@1", tracks: [] } as never]) {
      const pkg = browserPackage(animation);
      await expect(buildGeneratedMotionHtml(pkg, 0)).rejects.toThrow("Browser rendering does not yet support document scene3dAnimation@1.");
      await expect(preflightBrowserPackage(pkg)).resolves.toEqual({
        ok: false, htmlEntries: [], blockedOrigins: [], warnings: ["Browser rendering does not yet support document scene3dAnimation@1."],
      });
      await expect(renderBrowserFrame(pkg, { atMs: 0, outDir: "/not-opened-scene3d-animation-output" })).rejects.toThrow("Browser rendering does not yet support document scene3dAnimation@1.");
      let launches = 0;
      await expect(createMotionBrowserRenderSession(pkg, {
        launchBrowser: async () => { launches += 1; throw new Error("browser launch must not run"); },
      })).rejects.toThrow("Browser rendering does not yet support document scene3dAnimation@1.");
      expect(launches).toBe(0);
    }
  });

  it("treats an accessor root as present without reading it before fulfillment", async () => {
    let descriptorReads = 0, readerCalls = 0;
    const pkg = browserPackage(animationStore());
    Object.defineProperty(pkg.motion, "scene3dAnimation", { enumerable: true, get() { descriptorReads += 1; return animationStore(); } });
    await expect(loadHtmlComposition(pkg, {
      readPath: async () => { readerCalls += 1; throw new Error("HTML reader must not run"); },
    } as never)).rejects.toThrow("Browser rendering does not yet support document scene3dAnimation@1.");
    expect({ descriptorReads, readerCalls }).toEqual({ descriptorReads: 0, readerCalls: 0 });
  });

  it("keeps unsupported GPU Scene3D roots fail-closed before hashing, resources, runtime, or the descriptor getter", async () => {
    let descriptorReads = 0, manifestReads = 0, resourceReads = 0, opens = 0, preparations = 0;
    const pkg = browserPackage(animationStore());
    Object.defineProperty(pkg.motion, "scene3dAnimation", { enumerable: true, get() { descriptorReads += 1; return animationStore(); } });
    const manifest = pkg.manifest, root = pkg.root;
    Object.defineProperty(pkg, "manifest", { configurable: true, enumerable: true, get() { manifestReads += 1; return manifest; } });
    Object.defineProperty(pkg, "root", { enumerable: true, get() { resourceReads += 1; return root; } });
    await expect(prepareGpuSceneResources(pkg, [{ kind: "image", assetRef: "must-not-read.png" }])).rejects.toMatchObject({ code: "gpu_scene_resource_refused" });
    const preview = createGpuPreviewSession(pkg, {
      openRuntime: async () => { opens += 1; throw new Error("GPU runtime must not open"); },
      async prepareResourcesForTest() { preparations += 1; throw new Error("GPU resources must not prepare"); },
    });
    await expect(preview.renderFrame({ outDir: "/not-opened-scene3d-animation-gpu-output" })).resolves.toMatchObject({ ok: false, error: { code: "gpu_unsupported_feature" } });
    await preview.close();
    await expect(renderMotionGpuPreview(pkg, { outDir: "/not-opened-scene3d-animation-gpu-one-shot", sessionOptions: { openRuntime: async () => { opens += 1; throw new Error("GPU runtime must not open"); } } })).resolves.toMatchObject({ ok: false, error: { code: "gpu_unsupported_feature" } });
    await expect(resolveGpuEffectModuleStaticPlanForUse(pkg.motion, undefined)).resolves.toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature" } });
    // O6 descriptor/static admission is now ahead of every manifest read, including the static
    // glTF/PBR marker. No loaded-input hash, resource, descriptor getter, or runtime work follows.
    expect({ descriptorReads, manifestReads, resourceReads, opens, preparations }).toEqual({ descriptorReads: 0, manifestReads: 0, resourceReads: 0, opens: 0, preparations: 0 });
    Object.defineProperty(pkg, "manifest", { enumerable: true, get() { throw new Error("unsupported Scene3D refusal must not hash the manifest"); } });
    const producer = createGpuStreamingFrameProducer({ pkg, staticPlan: {} as never, openRuntime: async () => { opens += 1; throw new Error("GPU runtime must not open"); } });
    await expect(producer.produce({ async write() {} }, { admission: "pre-acquired", scratchRoot: "/not-opened-scene3d-animation-gpu-scratch", maxProcessTreeRssBytes: 1, signal: new AbortController().signal, watchProcess() {} })).rejects.toMatchObject({ code: "motion_scene3d_animation_unavailable" });
    expect({ descriptorReads, resourceReads, opens, preparations }).toEqual({ descriptorReads: 0, resourceReads: 0, opens: 0, preparations: 0 });
  });
});

function browserPackage(scene3dAnimation: NonNullable<MotionPackage["motion"]["scene3dAnimation"]>): MotionPackage {
  return {
    root: "/not-opened-scene3d-animation-package",
    manifest: { schema: "shellx-motion/package-manifest@1", id: "browser-scene3d-animation", name: "Browser scene3d animation", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["browser"], hosts: ["motion"] } },
    motion: {
      schema: "shellx-motion/motion@1", id: "browser-scene3d-animation", name: "Browser scene3d animation", durationMs: 1_000, fps: 30, width: 100, height: 50,
      assets: [], provenance: { sourceApp: "test", createdBy: "test" },
      layers: [{ id: "html", type: "html", source: "card.html", startMs: 0, durationMs: 1_000 }],
      scene3dAnimation,
    },
  };
}

function animationStore(): NonNullable<MotionPackage["motion"]["scene3dAnimation"]> {
  return { schema: "shellx-motion/scene3d-animation@1", tracks: [] } as never;
}
