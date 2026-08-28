import { afterEach, describe, expect, it, vi } from "vitest";
import type { MotionPackage } from "@shellx-motion/core";
import type { GpuPreviewVideoFrameProvider } from "@shellx-motion/renderer-browser";
import { createDebugGpuPreviewSessionOptions, type DebugGpuPreviewVideoProviderFactory, type DebugGpuPreviewVideoProviderInput } from "./debug-gpu-preview-video-provider.js";

const ffmpeg = vi.hoisted(() => ({ governedRunner: vi.fn() }));
vi.mock("@shellx-motion/renderer-ffmpeg", () => ({
  createGovernedFfmpegRunner: ffmpeg.governedRunner
}));

const pkg = {
  root: "/trusted/package",
  manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_gpu_preview", name: "GPU preview", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: [], hosts: [] } },
  motion: { schema: "shellx-motion/motion@1", id: "motion_gpu_preview", name: "GPU preview", durationMs: 100, fps: 30, width: 32, height: 32, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [] }
} as unknown as MotionPackage;

const provider = {
  inputHashes: {}, evidence: { schema: "shellx-motion/gpu-preview-video-frame-provider@1", surface: "preview-visual-only", sourceCount: 0, decodedFrameCount: 0, cache: { hits: 0, misses: 0, evictions: 0, entries: 0, bytes: 0, highWaterEntries: 0, highWaterBytes: 0 } },
  probe: async () => ({ snapshots: new Map(), slots: [] }), framesFor: async () => ({ atUs: 0, frames: [] }), close: async () => ({ closed: true as const, releasedFrames: 0 })
} as unknown as GpuPreviewVideoFrameProvider;

afterEach(() => { ffmpeg.governedRunner.mockReset(); });

describe("Debug GPU preview video host bridge", () => {
  it("fails closed when the host did not supply a scratch authority", () => {
    expect(createDebugGpuPreviewSessionOptions({})).toEqual({ ok: false, message: expect.stringContaining("host-owned debug scratch") });
  });

  it("binds dispatch scratch, caller, cancellation, and the injected bounded runner", async () => {
    const controller = new AbortController();
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const factory = vi.fn(async (input) => provider);
    const configured = createDebugGpuPreviewSessionOptions({ scratchRoot: "/trusted/scratch", callerId: "debug:workspace", signal: controller.signal, ffmpegRunner: runner, providerFactory: factory });

    expect(configured.ok).toBe(true);
    if (!configured.ok) throw new Error(configured.message);
    const opened = await configured.sessionOptions.openVideoProvider!({ pkg, signal: controller.signal });
    expect(opened).toBe(provider);
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ pkg, scratchRoot: "/trusted/scratch", callerId: "debug:workspace", signal: controller.signal }));
    controller.abort(new Error("cancelled"));
    expect(factory.mock.calls[0]![0].signal.aborted).toBe(true);
    const hostRunner = factory.mock.calls[0]![0].runner;
    await hostRunner({ executable: "ffprobe", args: ["-version"], shell: false }, controller.signal);
    expect(runner).toHaveBeenCalledWith({ executable: "ffprobe", args: ["-version"], shell: false });
  });

  it("keeps the module-free session hook byte-for-byte shape-compatible", () => {
    const configured = createDebugGpuPreviewSessionOptions({ scratchRoot: "/trusted/scratch" });
    expect(configured.ok).toBe(true);
    if (!configured.ok) throw new Error(configured.message);
    expect(Object.keys(configured.sessionOptions)).toEqual(["openVideoProvider"]);
    expect(configured.sessionOptions).not.toHaveProperty("effectModuleAuthority");
  });

  it("binds the production decoder runner to dispatch authority", async () => {
    const controller = new AbortController();
    const governed = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    let captured: DebugGpuPreviewVideoProviderInput | undefined;
    const factory: DebugGpuPreviewVideoProviderFactory = async (input) => { captured = input; return provider; };
    ffmpeg.governedRunner.mockReturnValue(governed);
    const configured = createDebugGpuPreviewSessionOptions({ scratchRoot: "/trusted/scratch", callerId: "debug:workspace", providerFactory: factory });

    if (!configured.ok) throw new Error(configured.message);
    await configured.sessionOptions.openVideoProvider!({ pkg, signal: controller.signal });
    await captured!.runner({ executable: "ffmpeg", args: ["-version"], shell: false }, controller.signal);
    expect(ffmpeg.governedRunner).toHaveBeenCalledWith({ scratchRoot: "/trusted/scratch", operation: "preview.gpu.decode", signal: controller.signal, callerId: "debug:workspace" });
    expect(governed).toHaveBeenCalledWith({ executable: "ffmpeg", args: ["-version"], shell: false });
  });
});
