import { describe, expect, it } from "vitest";
import { debugCommandContract } from "../command-metadata.js";
import { dispatchRenderPreviewBasicCommand, debugGpuPreviewFailure, debugPreviewPublicationFailure } from "./render-preview-basic";
import { PublicationCommitUncertainError } from "@shellx-motion/core";

describe("motion.preview.frame gpu lane", () => {
  it("preserves deterministic renderer post-link uncertainty for both direct GPU and browser preview routes", () => {
    const postLink = new PublicationCommitUncertainError({
      publicPath: "/governed/preview.png",
      kind: "file",
      expectedIdentity: { dev: 11, ino: 12 },
      expected: { sha256: "e".repeat(64), byteLength: 44 }
    }, new Error("injected post-link output verification failure"));
    expect(debugPreviewPublicationFailure(postLink)).toMatchObject({
      ok: false,
      error: { code: "publication_commit_uncertain", detail: { possiblyCommitted: true, publicPaths: ["/governed/preview.png"], expectedPublications: [{ expected: { sha256: "e".repeat(64), byteLength: 44 } }] } },
      result: { possiblyCommitted: true, publicPaths: ["/governed/preview.png"] }
    });
    expect(debugGpuPreviewFailure({
      code: "publication_commit_uncertain",
      message: postLink.message,
      possiblyCommitted: true,
      publicPaths: ["/governed/preview.png"],
      expectedPublications: [postLink.evidence]
    })).toMatchObject({
      ok: false,
      error: { code: "publication_commit_uncertain", detail: { expectedPublications: [{ publicPath: "/governed/preview.png" }] } },
      result: { possiblyCommitted: true, publicPaths: ["/governed/preview.png"] }
    });
  });

  it("refuses scene3dAnimation from the generic Action/Debug preview surface before renderer setup", async () => {
    let loaderCalls = 0;
    const result = await dispatchRenderPreviewBasicCommand("motion.preview.frame", {
      packageRoot: "/trusted/package", lane: "gpu", outDir: "/trusted/out"
    }, {
      packageLoader: async () => {
        loaderCalls += 1;
        return {
          root: "/trusted/package",
          manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_o6_debug", name: "O6 Debug", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } },
          motion: {
            schema: "shellx-motion/motion@1", id: "motion_o6_debug", name: "O6 Debug", durationMs: 100, fps: 30, width: 32, height: 32,
            assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [],
            scene3dAnimation: { schema: "shellx-motion/scene3d-animation@1", tracks: [] },
          }
        } as never;
      }
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "motion_scene3d_animation_unavailable", message: expect.stringContaining("direct @shellx-motion/renderer-browser renderMotionGpuPreview API") }
    });
    expect(loaderCalls).toBe(1);
  });

  it("refuses unsupported effects before a browser/GPU renderer can be opened", async () => {
    const result = await dispatchRenderPreviewBasicCommand("motion.preview.frame", {
      packageRoot: "/trusted/package",
      lane: "gpu",
      outDir: "/trusted/out",
      atMs: 0
    }, {
      packageLoader: async () => ({
        root: "/trusted/package",
        manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_gpu_refusal", name: "GPU refusal", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: [], hosts: [] } },
        motion: {
          schema: "shellx-motion/motion@1", id: "motion_gpu_refusal", name: "GPU refusal", durationMs: 100, fps: 30, width: 32, height: 32,
          assets: [], provenance: { sourceApp: "test", createdBy: "test" },
          layers: [{
            id: "points", type: "points", startMs: 0, durationMs: 100,
            pointCloud: { points: [{ x: 4, y: 4 }] },
            effects: { vignette: { amount: 0.5, softness: 0.5, color: "#000000" } }
          }]
        }
      })
    });
    expect(result).toMatchObject({ ok: false, error: { code: "gpu_unsupported_effect" } });
  });

  it("refuses browser workflow inputs instead of silently ignoring them", async () => {
    const result = await dispatchRenderPreviewBasicCommand("motion.preview.frame", {
      packageRoot: "/trusted/package",
      lane: "gpu",
      outDir: "/trusted/out",
      workflowPath: "/trusted/package/workflow.json"
    }, {});
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_args", message: expect.stringContaining("does not accept browser workflow") } });
  });

  it("refuses video preview without a host capability and exposes no provider controls in args", async () => {
    const result = await dispatchRenderPreviewBasicCommand("motion.preview.frame", {
      packageRoot: "/trusted/package", lane: "gpu", outDir: "/trusted/out"
    }, {
      packageLoader: async () => ({
        root: "/trusted/package",
        manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_gpu_video", name: "GPU video", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: [], hosts: [] } },
        motion: { schema: "shellx-motion/motion@1", id: "motion_gpu_video", name: "GPU video", durationMs: 100, fps: 30, width: 32, height: 32, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [{ id: "video", type: "video", source: "assets/video.mp4", assetRef: "assets/video.mp4", fit: "fill", startMs: 0, durationMs: 100, transform: { x: 0, y: 0, width: 32, height: 32 } }] }
      }) as never
    });
    expect(result).toMatchObject({ ok: false, error: { code: "capability_unavailable", message: expect.stringContaining("host-owned debug scratch") } });
    const properties = debugCommandContract("motion.preview.frame")?.argsSchema?.properties;
    expect(properties).not.toHaveProperty("videoProvider");
    expect(properties).not.toHaveProperty("ffmpegRunner");
    expect(properties).not.toHaveProperty("scratchRoot");
    expect(properties).not.toHaveProperty("effectModuleAuthority");
    expect(properties).not.toHaveProperty("effectModulesRoot");
  });

  it("fails closed for a module-bearing preview before any resource or browser can open without host authority", async () => {
    const result = await dispatchRenderPreviewBasicCommand("motion.preview.frame", {
      packageRoot: "/trusted/package", lane: "gpu", outDir: "/trusted/out"
    }, {
      packageLoader: async () => ({
        root: "/trusted/package",
        manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_gpu_module", name: "GPU module", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: [], hosts: [] } },
        motion: {
          schema: "shellx-motion/motion@1", id: "motion_gpu_module", name: "GPU module", durationMs: 100, fps: 30, width: 32, height: 32,
          assets: [], provenance: { sourceApp: "test", createdBy: "test" },
          layers: [
            { id: "group", type: "group", startMs: 0, durationMs: 100, childLayerIds: ["plate", "afterimage"] },
            { id: "plate", type: "shape", shape: "rect", startMs: 0, durationMs: 100, fill: "#ffffffff", width: 32, height: 32 },
            { id: "afterimage", type: "adjustment", startMs: 0, durationMs: 100, effectModule: {
              schema: "shellx-motion/effect-module-ref@1", moduleId: "motion.afterimage-stack", version: "1.0.0",
              parameters: { amountQ16: 32768, echoes: [{ dxPx: 2, dyPx: -1, color: "#C04080C0", opacityQ16: 32768 }] }
            } }
          ]
        }
      }) as never
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "gpu_resource_refused", message: expect.stringContaining("trusted host preview authority") }
    });
  });

  it("documents the host-owned visual-only active-video contract without exposing its controls", () => {
    const lane = debugCommandContract("motion.preview.frame")?.argsSchema?.properties?.lane;
    expect(lane?.description).toContain("host-owned provider");
    expect(lane?.description).toContain("Core exact-microsecond requests");
    expect(lane?.description).toContain("stable dynamic textures");
    expect(lane?.description).toContain("visual-only preview");
    expect(lane?.description).toContain("no audio, final-video staging, encoding, or mux claim");
    expect(lane?.description).not.toContain("currently refuse");
  });
});
