import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@shellx-motion/core";
import type { GpuVideoFrameRequest, MotionPackage } from "@shellx-motion/core";
import { describe, expect, it, vi } from "vitest";
import type { GpuFrameRenderSessionOpenResult } from "./gpu-frame-renderer";
import { createGpuPreviewSession } from "./gpu-points-preview";
import type { GpuPreviewVideoFrameProvider } from "./gpu-preview-video-frame-provider";

describe("GPU preview recoverable video request failures", () => {
  it("keeps the same provider and runtime usable after an out-of-trim Core refusal", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-trim-reuse-"));
    const provider = providerFixture();
    let providerOpens = 0, runtimeOpens = 0;
    const publication = vi.spyOn(core, "acquireDerivedOutputPublication").mockImplementation(async ({ outputPath }) => ({ stagingPath: `${outputPath}.staging`, async verifyFile() { const bytes = await readFile(`${outputPath}.staging`); return { sha256: createHash("sha256").update(bytes).digest("hex") }; }, async publishFile() {}, async abort() {} } as never));
    const session = createGpuPreviewSession(videoPackage(root), { openVideoProvider: async () => { providerOpens += 1; return provider; }, openRuntime: async () => { runtimeOpens += 1; return fakeRuntime(); } });
    try {
      await expect(session.renderFrame({ atMs: 0, outDir: join(root, "out") })).resolves.toMatchObject({ ok: true });
      await expect(session.renderFrame({ atMs: 500, outDir: join(root, "out") })).resolves.toMatchObject({ ok: false, error: { code: "gpu_resource_refused" } });
      await expect(session.renderFrame({ atMs: 50, outDir: join(root, "out") })).resolves.toMatchObject({ ok: true });
      expect({ providerOpens, runtimeOpens }).toEqual({ providerOpens: 1, runtimeOpens: 1 });
    } finally { await session.close(); publication.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });
});

function videoPackage(root: string): MotionPackage {
  return { root, manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_trim_reuse", name: "Trim reuse", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } }, motion: { schema: "shellx-motion/motion@1", id: "motion_trim_reuse", name: "Trim reuse", durationMs: 1_000, fps: 30, width: 2, height: 2, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [{ id: "clip", type: "video", assetRef: "assets/clip.mp4", startMs: 0, durationMs: 1_000, trimDurationMs: 100 }] } };
}

function providerFixture(): GpuPreviewVideoFrameProvider {
  const sourceSnapshotSha256 = "a".repeat(64), decodeContractSha256 = "b".repeat(64);
  const evidence = { schema: "shellx-motion/gpu-preview-video-frame-provider@1" as const, surface: "preview-visual-only" as const, sourceCount: 1, decodedFrameCount: 0, cache: { hits: 0, misses: 0, evictions: 0, deduplicated: 0, entries: 0, bytes: 0, highWaterEntries: 0, highWaterBytes: 0, capacityEntries: 32, capacityBytes: 128 * 1024 * 1024, inFlightBytes: 0, inFlightHighWaterBytes: 0 } };
  return {
    inputHashes: { "assets/clip.mp4": sourceSnapshotSha256 }, evidence,
    async probe() { return { snapshots: new Map([["clip", { assetRef: "assets/clip.mp4", sourceSnapshotSha256, durationUs: 1_000_000, width: 2, height: 2, decodeContractSha256 }]]), slots: [{ layerId: "clip", assetRef: "assets/clip.mp4", resourceId: "video-clip", width: 2, height: 2, sourceSnapshotSha256, decodeContractSha256 }] }; },
    async framesFor(requests) { evidence.decodedFrameCount += requests.length; evidence.cache.misses += requests.length; evidence.cache.entries = 1; evidence.cache.bytes = 16; evidence.cache.highWaterEntries = 1; evidence.cache.highWaterBytes = 16; return { atUs: requests[0]?.atUs ?? 0, frames: requests.map((request) => videoFrame(request, sourceSnapshotSha256, decodeContractSha256)) }; },
    async close() { return { closed: true, releasedFrames: evidence.cache.entries, releasedSources: 1, privateScratchReleased: true }; }
  };
}

function videoFrame(request: GpuVideoFrameRequest, sourceSnapshotSha256: string, decodeContractSha256: string) {
  const rgba = Buffer.from([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]);
  const decodedRgbaSha256 = createHash("sha256").update(rgba).digest("hex");
  return { request, resource: { layerId: request.layerId, assetRef: request.assetRef, resourceId: "video-clip", width: 2, height: 2, sha256: decodedRgbaSha256, sourceAtUs: request.sourceAtUs, sourceAtMs: request.sourceAtMs, sourceSnapshotSha256, decodedRgbaSha256, decodeContractSha256, requestFingerprint: request.requestFingerprint }, selection: { policy: "cfr-floor-request-sourceAtUs-to-stream-pts" as const, decodedPts: String(Math.floor(request.sourceAtUs / 1_000)), timeBase: "1/1000", frameDurationPts: "1", decodedPtsUs: String(request.sourceAtUs) }, upload: { id: "video-clip", width: 2, height: 2, rgba, sha256: sourceSnapshotSha256, decodedSha256: decodedRgbaSha256 } };
}

async function fakeRuntime(): Promise<GpuFrameRenderSessionOpenResult> {
  let writes = 0, closed = false;
  return { ok: true, session: { browserProcess: { pid: 4_242, launcher: "playwright-launch-server", containment: null }, async uploadImages(images) { return { ok: true, uploaded: images.length }; }, async replaceDynamicImages(images) { writes += images.length; return { ok: true, replaced: images.length }; }, async render() { const rgba = Buffer.from([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]); return { ok: true, frame: { rgba, sha256: createHash("sha256").update(rgba).digest("hex"), width: 2, height: 2, evidence: { schema: "shellx-motion/gpu-runtime-evidence@1" } as never } }; }, async resourceMetrics() { return { schema: "shellx-motion/gpu-page-session-resources@1", dynamicImageTextureSlots: 1, dynamicImageTextureBytes: 16, dynamicImageTextureHighWaterSlots: 1, dynamicImageTextureHighWaterBytes: 16, dynamicImageTextureWrites: writes, dynamicImageTextureReplacements: writes, dynamicImageTextureLateRefusals: 0, dynamicImageTextureDestructions: closed ? 1 : 0 } as never; }, async close() { closed = true; } } };
}
