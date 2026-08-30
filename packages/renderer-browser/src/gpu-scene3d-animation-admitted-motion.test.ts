import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@shellx-motion/core";
import type { MotionPackage } from "@shellx-motion/core";
import { describe, expect, it, vi } from "vitest";
import type { GpuFrameRenderSessionOpenResult } from "./gpu-frame-renderer";
import { renderMotionGpuPreview } from "./gpu-points-preview";
import type { GpuRuntimeEvidence } from "./gpu-runtime-types";

describe("O6 Browser admitted Motion transport", () => {
  it("uses the exact Core-admitted O6 snapshot for post-admission hashing, planning, and receipt evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-o6-admitted-snapshot-"));
    const pkg = scenePackage(root), source = pkg.motion;
    const expectedMotionHash = createHash("sha256").update(core.canonicalJson(source)).digest("hex");
    let reads = 0;
    pkg.motion = new Proxy(source, { get() { reads += 1; throw new Error("original O6 Motion must remain unread after admission"); } });
    const publication = vi.spyOn(core, "acquireDerivedOutputPublication").mockImplementation(async ({ outputPath }) => ({
      stagingPath: `${outputPath}.staging`,
      async verifyFile() { const bytes = await readFile(`${outputPath}.staging`); return { sha256: createHash("sha256").update(bytes).digest("hex") }; },
      async publishFile() {},
      async abort() {},
    } as never));
    try {
      const result = await renderMotionGpuPreview(pkg, { atMs: 500, outDir: join(root, "out"), sessionOptions: { openRuntime: async () => fakeRuntime() } });
      expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
      if (!result.ok) return;
      expect(reads).toBe(0);
      expect(result.receipt.inputHashes).toMatchObject({ "motion.json": expectedMotionHash });
      expect(result.receipt.inputHashes).toMatchObject({ "gpu-scene3d-animation-source": expect.stringMatching(/^[a-f0-9]{64}$/) });
    } finally {
      publication.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("re-admits transparent-proxy O6 Motion after draw and refuses a changed source before staging or receipt work", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-o6-admitted-stale-motion-"));
    const pkg = scenePackage(root), source = pkg.motion;
    let reads = 0;
    pkg.motion = new Proxy(source, { get() { reads += 1; throw new Error("original O6 Motion must remain unread after admission"); } });
    const publication = vi.spyOn(core, "acquireDerivedOutputPublication");
    try {
      const result = await renderMotionGpuPreview(pkg, {
        atMs: 500,
        outDir: join(root, "out"),
        sessionOptions: { openRuntime: async () => fakeRuntime(() => { source.name = "mutated after O6 admission"; }) },
      });
      expect(result).toMatchObject({ ok: false, error: { code: "gpu_resource_refused", message: expect.stringContaining("stale") } });
      expect({ reads }).toEqual({ reads: 0 });
      expect(publication).not.toHaveBeenCalled();
      await expect(stat(join(root, "out", "pkg_o6_scene-gpu-500.png"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      publication.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies F0 to Core's O6 snapshot before resource, runtime, or output work", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-o6-admitted-color-pipeline-"));
    const pkg = scenePackage(root), source = pkg.motion;
    source.colorPipeline = { schema: "shellx-motion/color-pipeline@1", intent: "linear-srgb-sdr@1" };
    let reads = 0, prepared = 0, opened = 0;
    pkg.motion = new Proxy(source, { get() { reads += 1; throw new Error("original O6 Motion must remain unread before F0 refusal"); } });
    try {
      const result = await renderMotionGpuPreview(pkg, {
        atMs: 500,
        outDir: join(root, "out"),
        sessionOptions: {
          async prepareResourcesForTest() { prepared += 1; throw new Error("resources must not prepare"); },
          async openRuntime() { opened += 1; return await fakeRuntime(); },
        },
      });
      expect(result).toMatchObject({ ok: false, error: { code: "color_pipeline_unsupported" } });
      expect({ reads, prepared, opened }).toEqual({ reads: 0, prepared: 0, opened: 0 });
      await expect(stat(join(root, "out", "pkg_o6_scene-gpu-500.png"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function scenePackage(root: string): MotionPackage {
  return {
    root,
    manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_o6_scene", name: "O6 scene", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } },
    motion: {
      schema: "shellx-motion/motion@1", id: "motion_o6_scene", name: "O6 scene", durationMs: 1_000, fps: 30, width: 16, height: 8,
      assets: [], provenance: { sourceApp: "test", createdBy: "test" },
      layers: [{
        id: "world", type: "scene3d", startMs: 0, durationMs: 1_000,
        scene3d: {
          schema: "shellx-motion/scene3d@1",
          camera: { position: [0, 2, 6], target: [0, 0, 0], fovDeg: 45, near: 0.1, far: 100 },
          lighting: { ambient: 0.25, direction: [0, -1, -1], intensity: 1, color: "#ffffff" },
          backgroundColor: "#101820",
          objects: [{ id: "beacon", primitive: "box", position: [0, 0, 0], rotationDeg: [0, 0, 0], scale: 1, color: "#00aaff", emissive: 0.1 }],
        },
      }],
      scene3dAnimation: {
        schema: "shellx-motion/scene3d-animation@1",
        tracks: [
          { id: "background", locator: { layerId: "world", scope: "background", property: "color" }, keyframes: [{ atUs: 0, value: "#000000" }] },
          { id: "intensity", locator: { layerId: "world", scope: "lighting", property: "intensity" }, keyframes: [{ atUs: 500_000, value: 1.5 }] },
        ],
      },
    },
  };
}

async function fakeRuntime(onRender?: (plan: unknown) => void): Promise<GpuFrameRenderSessionOpenResult> {
  return {
    ok: true,
    session: {
      browserProcess: { pid: 6_006, launcher: "playwright-launch-server", containment: null },
      async uploadImages(images) { return { ok: true, uploaded: images.length }; },
      async replaceDynamicImages(images) { return { ok: true, replaced: images.length }; },
      async render(plan) {
        onRender?.(plan);
        const frame = plan as { width: number; height: number };
        const rgba = Buffer.alloc(frame.width * frame.height * 4, 255);
        return { ok: true, frame: { rgba, sha256: createHash("sha256").update(rgba).digest("hex"), width: frame.width, height: frame.height, evidence: evidence() } };
      },
      async close() {},
    },
  };
}

function evidence(): GpuRuntimeEvidence {
  return {
    schema: "shellx-motion/gpu-runtime-evidence@1", backend: "webgpu-browser", browserSource: "test", webgpuFeatureStatus: "available", adapterFingerprint: "a".repeat(64),
    adapter: { cdpVendorId: 1, cdpDeviceId: 2, cdpVendor: "test", cdpDevice: "test", vendor: "test", device: "test", architecture: null, description: null },
    limits: { maxTextureDimension2D: 4096, maxBufferSize: 64 * 1024 * 1024, maxStorageBufferBindingSize: 64 * 1024 * 1024 },
  };
}
