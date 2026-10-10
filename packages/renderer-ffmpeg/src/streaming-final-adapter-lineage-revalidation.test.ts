import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMotionPackage } from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import type { FfmpegCommand, FfmpegProcessResult, StreamingFinalToolPolicy } from "./index";
import { renderStreamingFinal } from "./streaming-final-adapter";
import type { StreamingFfmpegProcessFactory } from "./streaming-process";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

describe("streamed-final adapter lineage revalidation", () => {
  it("keeps direct no-hook bytes unchanged and aborts an admitted Browser, Native, or GPU encoder before producer invocation", async () => {
    const direct = await fixture("direct");
    const directStats = processStats();
    const directResult = await rendered(direct.root, direct.anchor, "native", directStats.policy());
    expect(directResult, directResult.ok ? "" : directResult.error.message).toMatchObject({ ok: true });
    expect(directStats.starts).toBe(1);
    await expect(readFile(join(direct.root, "out.mp4"), "utf8")).resolves.toBe("encoded-media");

    for (const frameLane of ["browser", "native", "gpu"] as const) {
      const value = await fixture(frameLane);
      const stats = processStats();
      const policy = stats.policy();
      let gpuRenders = 0;
      if (frameLane === "gpu") policy.gpu = { openRuntime: gpuRuntime(() => { gpuRenders += 1; }) };
      let checks = 0;
      const result = await rendered(value.root, value.anchor, frameLane, policy, async () => {
        checks += 1;
        if (stats.starts > 0) throw new Error(`stable lineage changed before ${frameLane} producer`);
      });
      expect(result).toMatchObject({ ok: false, error: { code: "render_failed", message: `stable lineage changed before ${frameLane} producer` } });
      expect({ starts: stats.starts, aborts: stats.aborts }).toEqual({ starts: 1, aborts: 1 });
      expect(checks).toBeGreaterThanOrEqual(2);
      expect(gpuRenders).toBe(0);
      await expect(readFile(join(value.root, "out.mp4"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  }, 45_000);

  it("stops strict admitted GPU preparation before runtime opening or encoder launch", async () => {
    const value = await fixture("gpu-preparation");
    const stats = processStats();
    let gpuOpens = 0, checks = 0;
    const openRuntime = gpuRuntime();
    const policy = stats.policy();
    policy.gpu = { openRuntime: async (...args) => { gpuOpens += 1; return await openRuntime(...args); } };
    const result = await rendered(value.root, value.anchor, "gpu", policy, async () => {
      if (++checks === 2) throw new Error("stable lineage changed before strict GPU preparation");
    });
    expect(result).toMatchObject({ ok: false, error: { code: "render_failed", message: "stable lineage changed before strict GPU preparation" } });
    expect({ checks, gpuOpens, starts: stats.starts }).toEqual({ checks: 2, gpuOpens: 0, starts: 0 });
    await expect(readFile(join(value.root, "out.mp4"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function fixture(id: string) {
  const root = await mkdtemp(join(tmpdir(), `shellx-motion-streamed-lineage-${id}-`));
  roots.push(root);
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({ schema: "shellx-motion/package-manifest@1", id: `pkg_${id}`, name: id, motion: "motion.json", assets: [], sourceApp: "shellx-motion", compatibility: { lanes: ["native", "ffmpeg"], hosts: ["motion"] } })}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify({ schema: "shellx-motion/motion@1", id: `motion_${id}`, name: id, durationMs: 1_000, fps: 1, width: 16, height: 16, background: "#061a2c", assets: [], provenance: { sourceApp: "test", createdBy: "lineage" }, layers: [{ id: "background", type: "shape", shape: "rect", fill: "#061a2c", startMs: 0, durationMs: 1_000, transform: { x: 0, y: 0, width: 16, height: 16 } }, { id: "card", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000, transform: { x: 2, y: 2, width: 12, height: 12 } }] })}\n`);
  return { root, anchor: await createTrustedWorkspaceAnchor(root) };
}

async function rendered(root: string, anchor: Awaited<ReturnType<typeof createTrustedWorkspaceAnchor>>, frameLane: "browser" | "native" | "gpu", toolPolicy: StreamingFinalToolPolicy, revalidateLineage?: () => Promise<void>) {
  return await withTrustedWorkspaceAnchor(anchor, async () => await renderStreamingFinal({
    pkg: await loadMotionPackage(root), frameLane, outputPath: join(root, "out.mp4"), inputRoots: [root], outputRoots: [root], quality: { minDurationMs: 0 }, toolPolicy
  }, revalidateLineage ? { revalidateLineage } : {}));
}

function processStats() {
  let starts = 0, aborts = 0;
  const factory: StreamingFfmpegProcessFactory = async (input) => {
    starts += 1;
    input.reportProcessContainment({ schema: "shellx-motion/process-containment@1", mode: "unix-process-group", status: "enforced", killTree: true, memoryLimit: "rss-monitor" });
    let settled: FfmpegProcessResult | undefined;
    let resolveClosed!: (result: FfmpegProcessResult) => void;
    const closed = new Promise<FfmpegProcessResult>((resolve) => { resolveClosed = resolve; });
    const settle = (result: FfmpegProcessResult) => settled ?? (settled = result, resolveClosed(result), result);
    return {
      closed,
      write: async () => ({ backpressured: false, bufferedInputBytes: 0, inputHighWaterMarkBytes: 16_384 }),
      end: async () => { await writeFile(input.command.args.at(-1)!, "encoded-media"); return settle({ exitCode: 0, stdout: "", stderr: "" }); },
      abort: async () => { aborts += 1; return settle({ exitCode: 1, stdout: "", stderr: "aborted" }); }
    };
  };
  const runner = async (command: FfmpegCommand) => command.args.includes("-show_streams")
    ? { exitCode: 0, stdout: JSON.stringify({ streams: [{ codec_type: "video", codec_name: "h264", width: 16, height: 16, avg_frame_rate: "1/1", duration: "1", pix_fmt: "yuv420p", color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709", color_range: "tv" }], format: { duration: "1", format_name: "mov,mp4,m4a,3gp,3g2,mj2" } }), stderr: "" }
    : { exitCode: 0, stdout: "", stderr: "" };
  return { get starts() { return starts; }, get aborts() { return aborts; }, policy: (): StreamingFinalToolPolicy => ({ forceSoftwareEncode: true, runner, processFactory: factory }) };
}

type GpuOpenRuntime = NonNullable<NonNullable<StreamingFinalToolPolicy["gpu"]>["openRuntime"]>;
function gpuRuntime(observeRender: () => void = () => {}): GpuOpenRuntime {
  return async (_images, _fonts, options) => {
    let frames = 0;
    return { ok: true, session: {
      browserProcess: { pid: 4_242, launcher: "precontained-direct-chromium", containment: { rootPid: 4_242, mode: "unix-process-group", status: "enforced", killTree: true, memoryLimit: "rss-monitor", maxProcessTreeRssBytes: options.finalBrowser.maxProcessTreeRssBytes } },
      async uploadImages(images) { return { ok: true, uploaded: images.length }; },
      async resourceMetrics() { return resources(frames) as never; },
      async render(plan) {
        const frame = plan as { width: number; height: number }, rgba = Buffer.alloc(frame.width * frame.height * 4, 255), mappedBytesPerRow = Math.ceil((frame.width * 4) / 256) * 256;
        observeRender();
        frames += 1;
        return { ok: true, frame: { rgba, sha256: createHash("sha256").update(rgba).digest("hex"), width: frame.width, height: frame.height, evidence: { schema: "shellx-motion/gpu-runtime-evidence@1", backend: "webgpu-browser", browserSource: "test", webgpuFeatureStatus: "enabled", adapterFingerprint: "0".repeat(64), adapter: { cdpVendorId: 1, cdpDeviceId: 2, cdpVendor: "test", cdpDevice: "test", vendor: "test", device: "test", architecture: null, description: null }, limits: { maxTextureDimension2D: 4096, maxBufferSize: 1_000_000, maxStorageBufferBindingSize: 1_000_000 } }, readback: { schema: "shellx-motion/gpu-readback-frame@1", width: frame.width, height: frame.height, tightBytesPerRow: frame.width * 4, mappedBytesPerRow, gpuTextureToMappedReadbackBytes: mappedBytesPerRow * frame.height, cdpBase64PayloadBytes: Math.ceil((mappedBytesPerRow * frame.height) / 3) * 4, hostBase64DecodedBytes: mappedBytesPerRow * frame.height, allocations: { hostBase64Decode: 1, rowCompaction: mappedBytesPerRow === frame.width * 4 ? 0 : 1, straightAlpha: 0 }, copiedBytes: { rowCompaction: mappedBytesPerRow === frame.width * 4 ? 0 : frame.width * frame.height * 4, straightAlpha: 0 }, rowCompaction: mappedBytesPerRow === frame.width * 4 ? "bypassed-tight-stride" : "copied-padded-rows", straightAlpha: "in-place-owned-buffer", hostFrameElapsedNanoseconds: 0, hostClock: "node-process-hrtime", hostTimingScope: "admitted-frame-render-and-readback" } } };
      },
      async close() {}
    } };
  };
}
function resources(framesRendered: number) { return { schema: "shellx-motion/gpu-page-session-resources@1" as const, framesRendered, frameArenaReconfigurations: 1, frameTextureSlots: 1, frameTextureBytes: 4, depthTextureBytes: 0, readbackBytes: 4, frameArenaBytes: 8, frameTextureHighWaterSlots: 1, frameTextureHighWaterBytes: 8, frameArenaHighWaterBytes: 8, frameArenaReservations: framesRendered, frameArenaLateAllocationRefusals: 0, dynamicBufferSlots: 1, dynamicBufferBytes: 4, dynamicBufferHighWaterSlots: 1, dynamicBufferHighWaterBytes: 4, dynamicBufferReservations: framesRendered, dynamicBufferLateAllocationRefusals: 0, environmentUniformCapacitySlots: 0, environmentUniformBytes: 0, environmentUniformHighWaterSlots: 0, environmentUniformHighWaterBytes: 0, environmentUniformLateAllocationRefusals: 0 }; }
