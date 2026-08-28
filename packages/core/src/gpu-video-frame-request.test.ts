import { describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "./canonical-json";
import { compileGpuScene2dPlan, type GpuScene2dVideoResource } from "./gpu-scene-2d-plan";
import { compileGpuSceneStaticPlan } from "./gpu-scene-static-plan";
import { compileGpuVideoFrameRequests, gpuVideoFrameRequestProblem, type GpuVideoFrameRequest, type GpuVideoSourceSnapshot } from "./gpu-video-frame-request";
import type { MotionDocument, MotionLayer } from "./types";

const HASH = "a".repeat(64), DECODE = "b".repeat(64), RGBA = "c".repeat(64);

function document(layers: MotionLayer[]): MotionDocument {
  return { schema: "shellx-motion/motion@1", id: "video-request", name: "Video request", durationMs: 2_000, fps: 30, width: 160, height: 90, background: "#102030", assets: [], provenance: { sourceApp: "test", createdBy: "gpu-video-frame-request.test" }, layers };
}
function video(id: string, extra: Partial<MotionLayer> = {}): MotionLayer {
  return { id, type: "video", assetRef: `assets/${id}.mp4`, startMs: 0, durationMs: 1_000, ...extra };
}
function snapshots(...layers: MotionLayer[]): ReadonlyMap<string, GpuVideoSourceSnapshot> {
  return new Map(layers.map((layer) => [layer.id, { assetRef: layer.assetRef ?? "", sourceSnapshotSha256: HASH, durationUs: 1_000_000, width: 80, height: 45, decodeContractSha256: DECODE }]));
}
function requestAt(motion: MotionDocument, atUs: number, sourceSnapshots = snapshots(...motion.layers.filter((layer) => layer.type === "video"))): GpuVideoFrameRequest[] {
  const result = compileGpuVideoFrameRequests({ motion, atUs, snapshots: sourceSnapshots });
  expect(result).toMatchObject({ ok: true });
  return result.ok ? [...result.requests] : [];
}
function exactResources(requests: readonly GpuVideoFrameRequest[]): { videos: ReadonlyMap<string, GpuScene2dVideoResource>; videoRequests: ReadonlyMap<string, GpuVideoFrameRequest> } {
  return {
    videoRequests: new Map(requests.map((request) => [request.layerId, request])),
    videos: new Map(requests.map((request) => [request.layerId, {
      layerId: request.layerId, resourceId: `frame-${request.layerId}`, assetRef: request.assetRef, width: request.width, height: request.height,
      sha256: RGBA, decodedRgbaSha256: RGBA, sourceSnapshotSha256: request.sourceSnapshotSha256, decodeContractSha256: request.decodeContractSha256,
      sourceAtUs: request.sourceAtUs, sourceAtMs: request.sourceAtMs, requestFingerprint: request.requestFingerprint,
    }])),
  };
}

describe("V25-B1 exact-time video request authority", () => {
  it("uses parent-local group clocks then layer-local elapsed microseconds, including fractional scrubs", () => {
    const top = video("top", { startMs: 480, trimStartMs: 100, trimDurationMs: 400, playbackRate: 1.5 });
    const topRequest = requestAt(document([top]), 580_500)[0];
    expect(topRequest).toMatchObject({ atUs: 580_500, sourceAtUs: 250_750, sourceAtMs: 250.75, trimStartUs: 100_000, trimDurationUs: 400_000, playbackRate: 1.5 });

    const nested = document([
      { id: "outer", type: "group", startMs: 100, durationMs: 1_000, childLayerIds: ["inner"] },
      { id: "inner", type: "group", startMs: 50, durationMs: 800, childLayerIds: ["nested"] },
      video("nested", { startMs: 25, durationMs: 600, trimStartMs: 100, trimDurationMs: 400, playbackRate: 1.5 }),
      video("hidden", { visible: false }), video("later", { startMs: 700, durationMs: 100 }),
    ]);
    const request = requestAt(nested, 300_250)[0];
    // root 300.250 -> outer 200.250 -> inner 150.250 -> video elapsed 125.250; * 1.5 + trim 100 = 287.875ms.
    expect(request).toMatchObject({ layerId: "nested", atUs: 300_250, sourceAtUs: 287_875, sourceAtMs: 287.875 });
    expect(requestAt(nested, 300_250)).toHaveLength(1);
  });

  it("validates trim only against an immutable duration, loops modulo its trim, and refuses the non-loop half-open end", () => {
    const layer = video("clip", { trimStartMs: 100, trimDurationMs: 200 });
    const motion = document([layer]);
    expect(requestAt(motion, 199_999)[0]).toMatchObject({ sourceAtUs: 299_999 });
    expect(compileGpuVideoFrameRequests({ motion, atUs: 200_000, snapshots: snapshots(layer) })).toMatchObject({ ok: false, failure: { layerId: "clip", message: expect.stringContaining("half-open end") } });
    layer.loop = true;
    expect(requestAt(motion, 300_000)[0]).toMatchObject({ sourceAtUs: 200_000, sourceAtMs: 200 });
    layer.loop = false; layer.trimStartMs = 900; layer.trimDurationMs = 200;
    expect(compileGpuVideoFrameRequests({ motion, atUs: 0, snapshots: snapshots(layer) })).toMatchObject({ ok: false, failure: { layerId: "clip", message: expect.stringContaining("exceeds immutable source duration") } });
  });

  it("accepts only scalar playbackRate within (0, 16] and explicitly refuses keyframes in B1", () => {
    for (const playbackRate of [0, -0.1, 16.000_001, Number.POSITIVE_INFINITY]) {
      const layer = video("clip", { playbackRate });
      expect(compileGpuVideoFrameRequests({ motion: document([layer]), atUs: 0, snapshots: snapshots(layer) })).toMatchObject({ ok: false, failure: { layerId: "clip", message: expect.stringContaining("within (0, 16]") } });
    }
    const keyed = video("keyed", { playbackRate: 1, keyframes: { playbackRate: [{ atMs: 0, value: 1 }] } });
    expect(compileGpuVideoFrameRequests({ motion: document([keyed]), atUs: 0, snapshots: snapshots(keyed) })).toMatchObject({ ok: false, failure: { layerId: "keyed", message: expect.stringContaining("keyframed playbackRate") } });
  });

  it("creates stable canonical request fingerprints independent of source-map insertion order", () => {
    const first = video("first", { startMs: 10 }), second = video("second", { startMs: 20 });
    const motion = document([first, second]);
    const left = requestAt(motion, 30_250, new Map([["first", snapshots(first).get("first")!], ["second", snapshots(second).get("second")!]]));
    const right = requestAt(motion, 30_250, new Map([["second", snapshots(second).get("second")!], ["first", snapshots(first).get("first")!]]));
    expect(right).toEqual(left);
    expect(left.map((request) => request.requestFingerprint)).toEqual(right.map((request) => request.requestFingerprint));
  });

  it("rejects a canonically fingerprinted request whose trim interval overflows safe integer microseconds", () => {
    const original = requestAt(document([video("clip")]), 0)[0]!;
    const unsigned = {
      ...original,
      sourceAtUs: Number.MAX_SAFE_INTEGER - 1,
      sourceAtMs: (Number.MAX_SAFE_INTEGER - 1) / 1_000,
      trimStartUs: Number.MAX_SAFE_INTEGER - 1,
      trimDurationUs: 2,
    };
    const { requestFingerprint: _oldFingerprint, sourceAtMs: _derivedMilliseconds, ...fingerprintPayload } = unsigned;
    const forged = { ...unsigned, requestFingerprint: canonicalJsonSha256(fingerprintPayload) };
    expect(gpuVideoFrameRequestProblem(forged)).toBe("trim interval must remain within safe integer microseconds");
  });

  it("caps total visible video layers and sources during static planning while ignoring hidden layers", () => {
    const visible = Array.from({ length: 8 }, (_, index) => video(`v${index}`, { startMs: index * 100, durationMs: 50 }));
    expect(compileGpuSceneStaticPlan(document(visible))).toMatchObject({ ok: true });
    expect(compileGpuSceneStaticPlan(document([...visible, video("ninth", { startMs: 900, durationMs: 50 })]))).toMatchObject({ ok: false, failure: { code: "gpu_resource_refused", layerId: "ninth", message: expect.stringContaining("at most 8 visible video") } });
    expect(compileGpuSceneStaticPlan(document([...visible, video("hidden-ninth", { visible: false })]))).toMatchObject({ ok: true });
  });

  it("requires the full B1 resource identity before preview lowering, while preserving the legacy final path without request authority", () => {
    const layer = video("clip", { startMs: 480, trimStartMs: 100, trimDurationMs: 400 });
    const motion = document([layer]);
    const requests = requestAt(motion, 580_500), exact = exactResources(requests);
    expect(compileGpuScene2dPlan(motion, 580.5, exact)).toMatchObject({ ok: true, plan: { videoCount: 1 } });
    const legacy = exact.videos.get("clip")!;
    expect(compileGpuScene2dPlan(motion, 580.5, { videos: new Map([["clip", { layerId: legacy.layerId, resourceId: legacy.resourceId, assetRef: legacy.assetRef, width: legacy.width, height: legacy.height, sha256: legacy.sha256, sourceAtMs: legacy.sourceAtMs }]]) })).toMatchObject({ ok: true });
    const request = requests[0];
    const mutations: Array<[string, Partial<GpuScene2dVideoResource>]> = [
      ["layer", { layerId: "other" }], ["asset", { assetRef: "assets/other.mp4" }], ["source snapshot", { sourceSnapshotSha256: "d".repeat(64) }],
      ["rgba", { decodedRgbaSha256: "d".repeat(64) }], ["dimensions", { width: 81 }], ["source time", { sourceAtUs: request.sourceAtUs + 1 }],
      ["decode contract", { decodeContractSha256: "d".repeat(64) }], ["fingerprint", { requestFingerprint: "d".repeat(64) }],
    ];
    for (const [name, mutation] of mutations) {
      const result = compileGpuScene2dPlan(motion, 580.5, { videoRequests: exact.videoRequests, videos: new Map([["clip", { ...legacy, ...mutation }]]) });
      expect(result, name).toMatchObject({ ok: false, failure: { layerId: "clip" } });
    }
  });
});
