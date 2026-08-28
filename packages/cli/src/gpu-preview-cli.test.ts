import { afterEach, describe, expect, it, vi } from "vitest";
import type { DerivedOutputPublication, MotionPackage, OperationReceipt } from "@shellx-motion/core";
import type { GpuPreviewVideoFrameProvider } from "@shellx-motion/renderer-browser";
import type { GpuPreviewFfmpegRunner } from "@shellx-motion/renderer-ffmpeg";

const ffmpeg = vi.hoisted(() => ({ provider: vi.fn(), governedRunner: vi.fn() }));
const renderer = vi.hoisted(() => ({ render: vi.fn() }));
const rendererPublication = vi.hoisted(() => ({ bind: vi.fn((options: Record<string, unknown>) => ({ ...options })) }));
vi.mock("@shellx-motion/renderer-ffmpeg", () => ({
  createGpuPreviewVideoFrameProvider: ffmpeg.provider,
  createGovernedFfmpegRunner: ffmpeg.governedRunner
}));
vi.mock("@shellx-motion/renderer-browser", () => ({ renderMotionGpuPreview: renderer.render }));
vi.mock("@shellx-motion/renderer-browser/internal/private-output-publication", () => ({
  withRendererPrivateOutputPublication: rendererPublication.bind
}));
import { gpuPreviewSessionOptions, renderGpuPreviewCli } from "./gpu-preview-cli.js";

function packageWith(video?: "active" | "hidden"): MotionPackage {
  return {
    root: "/trusted/package",
    manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_gpu_preview", name: "GPU preview", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: [], hosts: [] } },
    motion: {
      schema: "shellx-motion/motion@1", id: "motion_gpu_preview", name: "GPU preview", durationMs: 100, fps: 30, width: 32, height: 32,
      assets: [], provenance: { sourceApp: "test", createdBy: "test" },
      layers: video ? [{ id: "video", type: "video", source: "assets/video.mp4", assetRef: "assets/video.mp4", fit: "fill", ...(video === "hidden" ? { visible: false } : {}), startMs: 0, durationMs: 100, transform: { x: 0, y: 0, width: 32, height: 32 } } as never] : []
    }
  } as MotionPackage;
}

const provider = {} as GpuPreviewVideoFrameProvider;

afterEach(() => { ffmpeg.provider.mockReset(); ffmpeg.governedRunner.mockReset(); renderer.render.mockReset(); rendererPublication.bind.mockClear(); });

describe("CLI GPU preview host integration", () => {
  it("refuses scene3dAnimation before renderer or sidecar output work", async () => {
    const pkg = packageWith() as MotionPackage;
    (pkg.motion as MotionPackage["motion"] & { scene3dAnimation?: unknown }).scene3dAnimation = { schema: "shellx-motion/scene3d-animation@1", tracks: [] };

    await expect(renderGpuPreviewCli(pkg, 0, "/trusted/preview")).resolves.toMatchObject({
      ok: false,
      error: {
        code: "motion_scene3d_animation_unavailable",
        message: expect.stringContaining("direct @shellx-motion/renderer-browser renderMotionGpuPreview API")
      }
    });
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it("leaves the receipt private when the CLI owns receipt-first paired publication", async () => {
    const outputPublication = { stagingPath: "/trusted/preview/.private/output.png" } as DerivedOutputPublication;
    renderer.render.mockResolvedValue({
      ok: true,
      frame: { path: outputPublication.stagingPath, sha256: "a".repeat(64) },
      receipt: { schema: "shellx-motion/receipt@1", id: "gpu", operation: "preview.gpu.frame", status: "passed", packageId: "pkg_gpu_preview", inputHashes: {}, createdAt: "2026-08-21T00:00:00.000Z", lane: "gpu", output: { path: outputPublication.stagingPath, sha256: "a".repeat(64) }, warnings: [] } as OperationReceipt
    });

    await expect(renderGpuPreviewCli(packageWith(), 0, "/trusted/preview", { outputPath: outputPublication.stagingPath, privateOutputPublication: outputPublication })).resolves.toMatchObject({ ok: true, receipt: { id: "gpu" } });
    expect(rendererPublication.bind).toHaveBeenCalledWith(expect.objectContaining({ outputPath: outputPublication.stagingPath }), outputPublication);
    expect(renderer.render).toHaveBeenCalledWith(packageWith(), expect.not.objectContaining({ privateOutputPublication: expect.anything() }));
  });

  it("refuses a direct GPU CLI output path that lacks the paired receipt publication authority", async () => {
    await expect(renderGpuPreviewCli(packageWith(), 0, "/trusted/preview")).resolves.toMatchObject({
      ok: false,
      error: { code: "gpu_preview_publication_required" }
    });
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it("does not allocate a video-provider seam for static GPU previews", () => {
    expect(gpuPreviewSessionOptions(packageWith(), "/trusted/preview", {})).toBeUndefined();
    expect(gpuPreviewSessionOptions(packageWith("hidden"), "/trusted/preview", {})).toBeUndefined();
  });

  it("injects an active-video provider with only the trusted host scratch root", async () => {
    const controller = new AbortController();
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    ffmpeg.provider.mockResolvedValue(provider);
    const options = gpuPreviewSessionOptions(packageWith("active"), "/trusted/preview", {
      callerId: "cli:workspace",
      signal: controller.signal,
      ffmpegRunner: runner
    });

    await expect(options!.openVideoProvider!({ pkg: packageWith("active"), signal: controller.signal })).resolves.toBe(provider);
    const input = ffmpeg.provider.mock.calls[0]![0];
    expect(input).toMatchObject({ scratchRoot: "/trusted/preview" });
    controller.abort(new Error("cancelled"));
    await input.runner({ executable: "ffprobe", args: ["-version"], shell: false }, controller.signal);
    expect(controller.signal.aborted).toBe(true);
    expect(runner).toHaveBeenCalledWith({ executable: "ffprobe", args: ["-version"], shell: false });
  });

  it("binds the production decoder runner to the caller, scratch root, and operation signal", async () => {
    const controller = new AbortController();
    const governed = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    let capturedRunner: GpuPreviewFfmpegRunner | undefined;
    ffmpeg.governedRunner.mockReturnValue(governed);
    ffmpeg.provider.mockImplementation(async (input: { runner: GpuPreviewFfmpegRunner }) => { capturedRunner = input.runner; return provider; });
    const options = gpuPreviewSessionOptions(packageWith("active"), "/trusted/preview", { callerId: "cli:workspace" });

    await options!.openVideoProvider!({ pkg: packageWith("active"), signal: controller.signal });
    await capturedRunner!({ executable: "ffmpeg", args: ["-version"], shell: false }, controller.signal);
    expect(ffmpeg.governedRunner).toHaveBeenCalledWith({ scratchRoot: "/trusted/preview", operation: "preview.gpu.decode", signal: controller.signal, callerId: "cli:workspace" });
    expect(governed).toHaveBeenCalledWith({ executable: "ffmpeg", args: ["-version"], shell: false });
  });
});
