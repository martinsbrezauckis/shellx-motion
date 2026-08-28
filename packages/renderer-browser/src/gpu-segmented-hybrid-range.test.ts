import { createHash } from "node:crypto";
import {
  compileGpuHybridTextureRequests,
  compileGpuSceneStaticPlan,
  streamingFrameTimestampMs,
  type MotionPackage,
} from "@shellx-motion/core";
import { describe, expect, it, vi } from "vitest";
import { bindGpuSegmentedHybridPrivateState, prepareGpuSegmentedHybridAdmission } from "./gpu-segmented-hybrid-admission";
import { openGpuSegmentedHybridRangeCapture } from "./gpu-segmented-hybrid-range";
import { GpuSegmentedHybridAdmission, type GpuSegmentedHybridPreparation } from "./gpu-segmented-hybrid-types";

const SOURCE = Buffer.from("vec4 motionMain(vec2 uv) { return vec4(uv.x, uv.y, 0.0, 1.0); }");
const SOURCE_SHA256 = createHash("sha256").update(SOURCE).digest("hex");
const hash = "a".repeat(64);

vi.mock("@shellx-motion/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@shellx-motion/core")>(),
  readVerifiedPackageAsset: async () => ({ bytes: Buffer.from(SOURCE), byteLength: SOURCE.byteLength, canonicalPath: "/opaque/source.glsl", sha256: SOURCE_SHA256 }),
}));

describe("GPU segmented hybrid range schedule", () => {
  it("refuses empty, shifted, skipped, and wrong-time active request schedules before borrowed browser capture", async () => {
    const preparation = await prepare();
    const admission = finalized(preparation);
    const range = { index: 3, startFrameIndex: 0, endFrameIndexExclusive: 2 };
    const schedule = canonicalSchedule(preparation, range);
    expect(schedule).toHaveLength(2);

    for (const hostile of [
      [],
      [...schedule].reverse(),
      [schedule[0]!],
      [{ ...schedule[0]!, request: { ...schedule[0]!.request, atUs: schedule[0]!.request.atUs + 1 } }, schedule[1]!],
    ]) {
      expect(() => openGpuSegmentedHybridRangeCapture({ admission, runtime: runtime(), job: job(), range, schedule: hostile })).toThrow(/schedule|forged|canonical/i);
    }
  });

  it("permits a nonzero zero-active range without allocating a browser context or dynamic replacement", async () => {
    const preparation = await prepare({ startMs: 500, durationMs: 500 });
    const admission = finalized(preparation);
    const range = { index: 1, startFrameIndex: 0, endFrameIndexExclusive: 1 };
    const capture = openGpuSegmentedHybridRangeCapture({ admission, runtime: runtime(), job: job(), range, schedule: [] });
    expect(capture.finish()).toMatchObject({ expectedCaptureCount: 0, captureCount: 0, startFrameIndex: 0, endFrameIndexExclusive: 1 });
    await expect(capture.close()).resolves.toMatchObject({ captureContext: "not-opened", scratch: "not-opened" });
  });
});

async function prepare(timing: { startMs?: number; durationMs?: number } = {}): Promise<GpuSegmentedHybridPreparation> {
  const pkg = testPackage(timing);
  const compiled = compileGpuSceneStaticPlan(pkg.motion);
  if (!compiled.ok) throw new Error(compiled.failure.message);
  return await prepareGpuSegmentedHybridAdmission({
    pkg,
    staticPlan: compiled.plan,
    browser: { name: "chromium", executableSha256: hash, runtimePolicy: "borrowed-precontained-chromium-data-only-no-network" },
  });
}

function finalized(preparation: GpuSegmentedHybridPreparation): GpuSegmentedHybridAdmission {
  const admission = new GpuSegmentedHybridAdmission({
    schema: "shellx-motion/gpu-segmented-hybrid-admission@1",
    staticPlanFingerprint: preparation.identity.staticPlanFingerprint,
    descriptor: preparation.identity.descriptor,
    sourceSnapshot: preparation.identity.sourceSnapshot,
    captureContractSha256: preparation.identity.captureContractSha256,
    browser: { ...preparation.identity.browser, version: "123.0.0" },
    dynamicTexture: preparation.identity.dynamicTexture,
    policy: preparation.identity.policy,
    bootstrap: { index: 0, atMs: 0, atUs: 0, requestFingerprint: hash, resourceId: preparation.dynamicTexture.id, width: preparation.dynamicTexture.width, height: preparation.dynamicTexture.height, pngSha256: hash, decodedRgbaSha256: hash, cleanup: { captureContext: "closed", scratch: "released", dynamicTexture: preparation.dynamicTexture } },
  }, preparation.dynamicTexture);
  bindGpuSegmentedHybridPrivateState(admission, preparation);
  return admission;
}

function canonicalSchedule(preparation: GpuSegmentedHybridPreparation, range: { startFrameIndex: number; endFrameIndexExclusive: number; index: number }) {
  const motion = testPackage().motion;
  return Array.from({ length: range.endFrameIndexExclusive - range.startFrameIndex }, (_, offset) => {
    const index = range.startFrameIndex + offset;
    const atMs = streamingFrameTimestampMs(index, motion.fps, motion.durationMs);
    const planned = compileGpuHybridTextureRequests({ motion, atUs: Math.round(atMs * 1_000), snapshots: new Map([[preparation.identity.sourceSnapshot.layerId, preparation.identity.sourceSnapshot]]) });
    if (!planned.ok || planned.requests.length !== 1) throw new Error("test did not mint one active Core request");
    return { index, atMs, request: planned.requests[0]! };
  });
}

function runtime() {
  return {
    browserVersion: "123.0.0",
    borrowGpuBrowser: () => ({}) as never,
    replaceDynamicImages: async () => ({ ok: true as const, replaced: 1 }),
  } as never;
}

function job() {
  return { admission: "pre-acquired", scratchRoot: "/opaque/scratch", maxProcessTreeRssBytes: 1, signal: new AbortController().signal, watchProcess() {} } as never;
}

function testPackage(timing: { startMs?: number; durationMs?: number } = {}): MotionPackage {
  return {
    root: "/opaque/package-root",
    manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_b2_range_test", name: "B2 range test", motion: "motion.json", assets: ["assets/surface.glsl"], sourceApp: "shellx-motion", compatibility: { lanes: ["gpu"], hosts: ["motion"] } },
    motion: {
      schema: "shellx-motion/motion@1", id: "motion_b2_range_test", name: "B2 range test", durationMs: 1_000, fps: 30, width: 1600, height: 900, background: "#000000",
      layers: [{ id: "shader-surface", type: "shader", startMs: timing.startMs ?? 0, durationMs: timing.durationMs ?? 1_000, transform: { x: 0, y: 0, width: 1600, height: 900 }, shader: { schema: "shellx-motion/shader-plugin@1", language: "glsl-es-100-expression", fragmentAssetId: "surface-fragment", seed: 7, fallbackColor: "#000000" } }],
      assets: [{ id: "surface-fragment", type: "shader", source: { path: "assets/surface.glsl", mimeType: "text/x-shellx-motion-glsl" } }],
    },
  } as MotionPackage;
}
