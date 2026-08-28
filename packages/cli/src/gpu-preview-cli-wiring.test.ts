import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const gpuPreview = vi.hoisted(() => ({ render: vi.fn(async () => ({ ok: false, command: "preview" as const, lane: "gpu", error: { code: "test", message: "stub" } })) }));
const core = vi.hoisted(() => ({
  pkg: {
    root: "/trusted/package",
    manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_gpu_preview", name: "GPU preview", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: [], hosts: [] } },
    motion: { schema: "shellx-motion/motion@1", id: "motion_gpu_preview", name: "GPU preview", durationMs: 100, fps: 30, width: 32, height: 32, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [] }
  }
}));
vi.mock("./gpu-preview-cli.js", () => ({ renderGpuPointsPreviewCli: gpuPreview.render }));
vi.mock("@shellx-motion/core", async (importOriginal) => ({ ...(await importOriginal()), loadMotionPackage: async () => core.pkg }));
import { runCli } from "./main.js";

const roots: string[] = [];
afterEach(async () => {
  gpuPreview.render.mockClear();
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("CLI GPU preview option wiring", () => {
  it("passes caller identity, cancellation, scratch, and the injected runner into the trusted helper", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-preview-cli-"));
    roots.push(outDir);
    const controller = new AbortController();
    const runner = async () => ({ exitCode: 0, stdout: "", stderr: "" });

    await runCli(["preview", "/trusted/package", "--lane", "gpu", "--out", outDir], {
      callerId: "cli:workspace", signal: controller.signal, scratchRoot: "/trusted/scratch", ffmpegRunner: runner
    });

    expect(gpuPreview.render).toHaveBeenCalledWith(expect.anything(), 0, outDir, expect.objectContaining({
      callerId: "cli:workspace", signal: controller.signal, scratchRoot: "/trusted/scratch", ffmpegRunner: runner
    }));
  });

  it("refuses scene3dAnimation before creating the requested output directory or invoking the renderer helper", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-preview-cli-refusal-"));
    roots.push(root);
    const outputDir = join(root, "must-not-exist");
    (core.pkg.motion as Record<string, unknown>).scene3dAnimation = { schema: "shellx-motion/scene3d-animation@1", tracks: [] };
    try {
      await expect(runCli(["preview", "/trusted/package", "--lane", "gpu", "--out", outputDir])).resolves.toMatchObject({
        ok: false,
        error: { code: "motion_scene3d_animation_unavailable", message: expect.stringContaining("direct @shellx-motion/renderer-browser renderMotionGpuPreview API") }
      });
      expect(gpuPreview.render).not.toHaveBeenCalled();
      await expect(stat(outputDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      delete (core.pkg.motion as Record<string, unknown>).scene3dAnimation;
    }
  });
});
