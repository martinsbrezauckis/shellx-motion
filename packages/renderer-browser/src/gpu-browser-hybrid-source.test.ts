import { compileGpuScene2dPlan, type MotionPackage } from "@shellx-motion/core";
import { describe, expect, it } from "vitest";
import type { BrowserPackageFulfillment } from "./browser-package-fulfillment";
import { openGpuHybridBrowserCapture } from "./gpu-browser-hybrid";
import type { GpuFrameRenderSession } from "./gpu-frame-renderer";
import type { GpuStreamingJobContext } from "./gpu-process-containment";
import { loadHtmlComposition } from "./index";

describe("GPU hybrid browser source selection", () => {
  it("reads only the declared browser source while GPU separately composes native layers", async () => {
    const pkg: MotionPackage = {
      root: "/retained/package",
      manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_hybrid_source", name: "Hybrid source", motion: "motion.json", assets: ["surface.html"], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } },
      motion: { schema: "shellx-motion/motion@1", id: "motion_hybrid_source", name: "Hybrid source", durationMs: 1_000, fps: 1, width: 16, height: 16, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [
        { id: "native-back", type: "shape", shape: "rect", fill: "#ff0000", startMs: 0, durationMs: 1_000, transform: { width: 16, height: 16 } },
        { id: "browser-card", type: "html", source: "surface.html", startMs: 0, durationMs: 1_000, transform: { width: 16, height: 16 } },
        { id: "native-front", type: "shape", shape: "rect", fill: "#00ff00", startMs: 0, durationMs: 1_000, transform: { width: 16, height: 16 } }
      ] }
    };

    const readPaths: string[] = [];
    const browserHtml = Buffer.from("<!doctype html><body data-composition-id=\"surface\"><main data-layer-id=\"browser-dom\" data-start=\"0\" data-duration=\"1000\">browser-only</main></body>");
    const fulfillment: BrowserPackageFulfillment = {
      rootPath: pkg.root,
      canFulfillFileUrl: () => false,
      async readPath(path) {
        readPaths.push(path);
        if (path !== "/retained/package/surface.html") throw new Error(`unexpected package read: ${path}`);
        return { bytes: Buffer.from(browserHtml), sha256: "a".repeat(64), byteLength: browserHtml.byteLength, relativePath: "surface.html", contentType: "text/html; charset=utf-8" };
      },
      async readFileUrl() { throw new Error("the hybrid source contract never opens arbitrary file URLs"); },
      inputHashes: () => ({ "browser-package/surface.html": "a".repeat(64) })
    };
    await expect(loadHtmlComposition(pkg, fulfillment)).resolves.toEqual(expect.objectContaining({ source: "surface.html", sourceLayerId: "browser-card", layers: [{ id: "browser-dom", startMs: 0, durationMs: 1_000 }] }));
    expect(readPaths).toEqual(["/retained/package/surface.html"]);
    const compiled = compileGpuScene2dPlan(pkg.motion, 0, { browserSurfaces: new Map([["browser-card", { resourceId: "browser-surface", assetRef: "surface.html", width: 16, height: 16, sha256: "a".repeat(64) }]]) });
    expect(compiled.ok).toBe(true); if (!compiled.ok) return;
    expect(compiled.plan.frame.draws.map((draw) => `${draw.kind}:${draw.id}`)).toEqual(["rect:native-back", "image:browser-card", "rect:native-front"]);
  });

  it("refuses a hidden browser source that the shared session would otherwise select first", async () => {
    const pkg: MotionPackage = {
      root: "/retained/package", manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_hybrid_hidden", name: "Hybrid hidden", motion: "motion.json", assets: ["hidden.html", "visible.html"], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } },
      motion: { schema: "shellx-motion/motion@1", id: "motion_hybrid_hidden", name: "Hybrid hidden", durationMs: 1_000, fps: 1, width: 16, height: 16, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [
        { id: "hidden", type: "html", visible: false, source: "hidden.html", startMs: 0, durationMs: 1_000 },
        { id: "visible", type: "html", source: "visible.html", startMs: 0, durationMs: 1_000 }
      ] }
    };
    await expect(openGpuHybridBrowserCapture({ pkg, runtime: { borrowGpuBrowser() { throw new Error("must not borrow"); } } as unknown as GpuFrameRenderSession, job: { admission: "pre-acquired", scratchRoot: "/retained/scratch", maxProcessTreeRssBytes: 1, signal: new AbortController().signal, watchProcess() {} } as GpuStreamingJobContext })).rejects.toMatchObject({ code: "gpu_hybrid_capture_refused", message: expect.stringContaining("first browser surface") });
  });

  it("uses an exact Core-selected browser layer despite an earlier hidden sibling", async () => {
    const pkg: MotionPackage = {
      root: "/retained/package", manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_hybrid_selected", name: "Hybrid selected", motion: "motion.json", assets: ["hidden.html", "visible.html"], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } },
      motion: { schema: "shellx-motion/motion@1", id: "motion_hybrid_selected", name: "Hybrid selected", durationMs: 1_000, fps: 1, width: 16, height: 16, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [
        { id: "hidden", type: "html", visible: false, source: "hidden.html", startMs: 0, durationMs: 1_000 },
        { id: "visible", type: "html", source: "visible.html", startMs: 0, durationMs: 1_000 }
      ] }
    };
    await expect(openGpuHybridBrowserCapture({ pkg, layerId: "visible", runtime: {} as GpuFrameRenderSession, job: { admission: "pre-acquired", scratchRoot: "/retained/scratch", maxProcessTreeRssBytes: 1, signal: new AbortController().signal, watchProcess() {} } as GpuStreamingJobContext })).rejects.toMatchObject({ code: "gpu_hybrid_capture_refused", message: expect.stringContaining("existing GPU runtime browser capability") });
  });
});
