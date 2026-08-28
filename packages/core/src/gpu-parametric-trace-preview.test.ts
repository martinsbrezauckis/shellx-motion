import { describe, expect, it, vi } from "vitest";
import {
  compileGpuParametricTracePreviewFramePlan,
  compileGpuParametricTracePreviewStaticPlan,
  readGpuParametricTracePreviewUpload,
  GPU_PARAMETRIC_TRACE_TOPOLOGY_ABI,
  GPU_PARAMETRIC_TRACE_VERTEX_ABI,
  GPU_PARAMETRIC_TRACE_VERTEX_STRIDE_BYTES,
} from "./gpu-parametric-trace-preview";
import type { MotionDocument } from "./types";

describe("private GPU parametric trace preview authority", () => {
  it("binds a frozen opaque static/frame wrapper to one authority and rejects forged, stale, and cross-plan use", () => {
    const motion = authorityMotion();
    const source = descriptor([drawer("line", "line", { kind: "full-clip", maxSamples: 5 })]);
    const staticResult = compileGpuParametricTracePreviewStaticPlan(motion, source);
    expect(staticResult).toMatchObject({ ok: true }); if (!staticResult.ok) return;
    expect(Object.isFrozen(staticResult.plan)).toBe(true);
    expect(() => { (staticResult.plan as { fingerprint: string }).fingerprint = "0".repeat(64); }).toThrow();
    const frame = compileGpuParametricTracePreviewFramePlan(motion, staticResult.plan, 2_000);
    expect(frame).toMatchObject({ ok: true }); if (!frame.ok) return;
    expect(Object.isFrozen(frame.plan)).toBe(true);
    expect(() => { (frame.plan as { atUs: number }).atUs = 0; }).toThrow();
    expect(() => readGpuParametricTracePreviewUpload(staticResult.plan, structuredClone(frame.plan))).toThrow("exact Core-issued");
    expect(compileGpuParametricTracePreviewFramePlan(motion, structuredClone(staticResult.plan), 2_000)).toMatchObject({ ok: false, failure: { code: "gpu_resource_refused" } });
    const revised = structuredClone(motion); revised.name = "changed";
    expect(compileGpuParametricTracePreviewFramePlan(revised, staticResult.plan, 2_000)).toMatchObject({ ok: false, failure: { code: "gpu_resource_refused", message: expect.stringContaining("stale") } });
    const other = compileGpuParametricTracePreviewStaticPlan(motion, descriptor([drawer("points", "points", { kind: "full-clip", maxSamples: 5 })]));
    expect(other).toMatchObject({ ok: true }); if (!other.ok) return;
    expect(other.plan.fingerprint).not.toBe(staticResult.plan.fingerprint);
    expect(() => readGpuParametricTracePreviewUpload(other.plan, frame.plan)).toThrow("matching exact");
    const identical = compileGpuParametricTracePreviewStaticPlan(motion, source);
    expect(identical).toMatchObject({ ok: true }); if (!identical.ok) return;
    expect(identical.plan).not.toBe(staticResult.plan);
    expect(identical.plan.fingerprint).toBe(staticResult.plan.fingerprint);
    const identicalFrame = compileGpuParametricTracePreviewFramePlan(motion, identical.plan, 2_000);
    expect(identicalFrame).toMatchObject({ ok: true }); if (!identicalFrame.ok) return;
    expect(() => readGpuParametricTracePreviewUpload(staticResult.plan, identicalFrame.plan)).toThrow("matching exact");
  });

  it("requires an admitted schedule point and selects retained full-clip and bounded tails exactly", () => {
    const source = descriptor([drawer("full", "line", { kind: "full-clip", maxSamples: 5 }), drawer("tail", "ribbon", { kind: "last-samples", samples: 2 })]);
    const motion = authorityMotion(), staticResult = compileGpuParametricTracePreviewStaticPlan(motion, source);
    expect(staticResult).toMatchObject({ ok: true }); if (!staticResult.ok) return;
    expect(compileGpuParametricTracePreviewFramePlan(motion, staticResult.plan, 1_500)).toMatchObject({ ok: false, failure: { code: "gpu_invalid_time" } });
    const selected = compileGpuParametricTracePreviewFramePlan(motion, staticResult.plan, 4_000);
    expect(selected).toMatchObject({ ok: true }); if (!selected.ok) return;
    expect(selected.plan.drawers.map((item) => ({ id: item.drawerId, samples: item.window.sampleCount, vertices: item.window.vertexCount }))).toEqual([
      { id: "full", samples: 5, vertices: 5 }, { id: "tail", samples: 2, vertices: 4 },
    ]);
    expect(selected.plan.budget).toMatchObject({ samples: 7, vertices: 9, packedVertexBytes: 9 * GPU_PARAMETRIC_TRACE_VERTEX_STRIDE_BYTES });
    expect(selected.plan.budget.packedVertexBytes).toBeLessThanOrEqual(selected.plan.budget.selectedWindowBytes);
    expect(selected.plan.budget.combinedPeakBytes).toBe(selected.plan.budget.storageBytes + selected.plan.budget.selectedWindowBytes);
  });

  it("packs all four source modes, including 3D ribbon/tube positions, through one fixed ABI", () => {
    const source = descriptor([
      drawer("line", "line", { kind: "full-clip", maxSamples: 5 }), drawer("points", "points", { kind: "full-clip", maxSamples: 5 }),
      drawer("ribbon", "ribbon", { kind: "full-clip", maxSamples: 5 }), drawer("tube", "tube", { kind: "full-clip", maxSamples: 5 }),
    ]);
    const motion = authorityMotion(), staticResult = compileGpuParametricTracePreviewStaticPlan(motion, source);
    expect(staticResult).toMatchObject({ ok: true }); if (!staticResult.ok) return;
    const frame = compileGpuParametricTracePreviewFramePlan(motion, staticResult.plan, 2_000);
    expect(frame).toMatchObject({ ok: true }); if (!frame.ok) return;
    expect(frame.plan.vertexAbi).toBe(GPU_PARAMETRIC_TRACE_VERTEX_ABI);
    expect(frame.plan.topologyAbi).toBe(GPU_PARAMETRIC_TRACE_TOPOLOGY_ABI);
    expect(frame.plan.drawers.map((item) => [item.mode, item.window.vertexCount, item.vertexByteLength])).toEqual([
      ["line", 3, 60], ["points", 3, 60], ["ribbon", 6, 120], ["tube", 24, 480],
    ]);
    expect(frame.plan.drawers.map((item) => [item.topology.primitive, item.topology.fetch, item.topology.drawVertexInvocations])).toEqual([
      ["line-strip", "sequential-sample@1", 3], ["point-list", "sequential-sample@1", 3], ["triangle-strip", "sequential-ribbon-pairs@1", 6], ["triangle-list", "ring8-segment-vertex-fetch@1", 96],
    ]);
    const upload = readGpuParametricTracePreviewUpload(staticResult.plan, frame.plan);
    const tube = upload.drawers.find((item) => item.drawerId === "tube")!.vertexBytes;
    expect(f32(tube, 8)).not.toBe(0);
  });

  it("defines a bounded two-sample tube triangle-list draw and refuses one work unit below its combined source/topology requirement", () => {
    const motion = authorityMotion();
    const source = descriptor([drawer("tube", "tube", { kind: "full-clip", maxSamples: 2 })]);
    source.clip = { durationUs: 1_000, sampleIntervalUs: 1_000 };
    source.caps.perDrawer.maxWorkUnits = 74;
    source.caps.aggregate.maxWorkUnits = 74;
    const staticResult = compileGpuParametricTracePreviewStaticPlan(motion, source);
    expect(staticResult).toMatchObject({ ok: true }); if (!staticResult.ok) return;
    expect(compileGpuParametricTracePreviewFramePlan(motion, staticResult.plan, 1_000)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature", message: expect.stringContaining("topology work") } });
    source.caps.perDrawer.maxWorkUnits = 75;
    source.caps.aggregate.maxWorkUnits = 75;
    const admitted = compileGpuParametricTracePreviewStaticPlan(motion, source);
    expect(admitted).toMatchObject({ ok: true }); if (!admitted.ok) return;
    const frame = compileGpuParametricTracePreviewFramePlan(motion, admitted.plan, 1_000);
    expect(frame).toMatchObject({ ok: true }); if (!frame.ok) return;
    expect(frame.plan.drawers[0]!.topology).toMatchObject({ primitive: "triangle-list", bufferBinding: { slot: 0, strideBytes: GPU_PARAMETRIC_TRACE_VERTEX_STRIDE_BYTES }, fetch: "ring8-segment-vertex-fetch@1", ringVertices: 8, segmentVertexInvocations: 48, drawVertexInvocations: 48, workUnits: 48 });
    expect(frame.plan.budget).toMatchObject({ windowWorkUnits: 27, topologyWorkUnits: 48, combinedWorkUnits: 75 });
  });

  it("refuses aggregate topology work before any packed vertex allocation", () => {
    const motion = authorityMotion(), source = descriptor([drawer("left", "tube", { kind: "full-clip", maxSamples: 2 }), drawer("right", "tube", { kind: "full-clip", maxSamples: 2 })]);
    source.clip = { durationUs: 1_000, sampleIntervalUs: 1_000 };
    source.caps.perDrawer.maxWorkUnits = 1_000;
    source.caps.aggregate.maxWorkUnits = 149; // 2 × (27 retained source work + 48 fixed topology work) - 1
    const staticResult = compileGpuParametricTracePreviewStaticPlan(motion, source);
    expect(staticResult).toMatchObject({ ok: true }); if (!staticResult.ok) return;
    const allocations = vi.spyOn(Buffer, "alloc");
    try {
      expect(compileGpuParametricTracePreviewFramePlan(motion, staticResult.plan, 1_000)).toMatchObject({ ok: false, failure: { code: "gpu_resource_refused", message: expect.stringContaining("aggregate") } });
      expect(allocations).not.toHaveBeenCalled();
    } finally { allocations.mockRestore(); }
    source.caps.aggregate.maxWorkUnits = 150;
    const admitted = compileGpuParametricTracePreviewStaticPlan(motion, source);
    expect(admitted).toMatchObject({ ok: true }); if (admitted.ok) expect(compileGpuParametricTracePreviewFramePlan(motion, admitted.plan, 1_000)).toMatchObject({ ok: true, plan: { budget: { combinedWorkUnits: 150 } } });
  });

  it("uses age/speed/drawer signals before Browser upload and refuses relation schedules off the existing whole-ms bridge", () => {
    const age = drawer("age", "points", { kind: "full-clip", maxSamples: 5 }); age.output = output("points", { source: "age", from: 0, to: 10 }, { source: "drawer", from: 0, to: 1 }, { source: "age", from: 1, to: 0 });
    const speed = drawer("speed", "points", { kind: "full-clip", maxSamples: 5 }); speed.output = output("points", { source: "speed", from: 1, to: 9 }, { source: "drawer", from: 0, to: 1 }, { source: "constant", from: 1, to: 1 });
    const motion = authorityMotion(), staticResult = compileGpuParametricTracePreviewStaticPlan(motion, descriptor([age, speed]));
    expect(staticResult).toMatchObject({ ok: true }); if (!staticResult.ok) return;
    const frame = compileGpuParametricTracePreviewFramePlan(motion, staticResult.plan, 4_000);
    expect(frame).toMatchObject({ ok: true }); if (!frame.ok) return;
    const upload = readGpuParametricTracePreviewUpload(staticResult.plan, frame.plan), ageBytes = upload.drawers[0]!.vertexBytes, speedBytes = upload.drawers[1]!.vertexBytes;
    expect(f32(ageBytes, 4 * GPU_PARAMETRIC_TRACE_VERTEX_STRIDE_BYTES + 12)).toBe(0); // newest age is 0, width source from=0
    expect(u8(ageBytes, 16)).toBe(0); // first drawer maps to normalized greyscale 0
    expect(u8(speedBytes, 16)).toBe(255); // second drawer maps to normalized greyscale 1
    expect(f32(speedBytes, 4 * GPU_PARAMETRIC_TRACE_VERTEX_STRIDE_BYTES + 12)).toBeGreaterThan(0); // speed is evaluated by Core plan, not Browser
    const thin = drawer("thin", "line", { kind: "full-clip", maxSamples: 5 }); thin.output = output("line", { source: "constant", from: 1, to: 1 });
    const thinStatic = compileGpuParametricTracePreviewStaticPlan(motion, descriptor([thin]));
    expect(thinStatic).toMatchObject({ ok: true }); if (thinStatic.ok) {
      const thinFrame = compileGpuParametricTracePreviewFramePlan(motion, thinStatic.plan, 1_000);
      expect(thinFrame).toMatchObject({ ok: true }); if (thinFrame.ok) expect(f32(readGpuParametricTracePreviewUpload(thinStatic.plan, thinFrame.plan).drawers[0]!.vertexBytes, 12)).toBe(1);
    }
    const relation: any = drawer("relation", "line", { kind: "full-clip", maxSamples: 9 }); relation.driver = { kind: "relation", targetLayerId: "related" };
    const halfMs = { ...descriptor([relation]), clip: { durationUs: 4_000, sampleIntervalUs: 500 } }; halfMs.caps.perDrawer.maxSamples = 16;
    expect(compileGpuParametricTracePreviewStaticPlan(motion, halfMs)).toMatchObject({ ok: false, failure: { message: expect.stringContaining("whole-millisecond") } });
  });
});

function descriptor(drawers: any[]) { return { schema: "shellx-motion/private-parametric-trace@1", clip: { durationUs: 4_000, sampleIntervalUs: 1_000 }, drawers, caps: { perDrawer: { maxSamples: 8, maxVertices: 256, maxWorkUnits: 20_000, maxBytes: 100_000 }, aggregate: { maxSamples: 64, maxVertices: 1_000, maxWorkUnits: 80_000, maxBytes: 1_000_000 } } }; }
function output(mode: "line" | "ribbon" | "tube" | "points", width = { source: "constant", from: 4, to: 4 }, colour = { source: "constant", from: 0.5, to: 0.5 }, opacity = { source: "constant", from: 1, to: 1 }) { return { mode, width, colour, opacity, speedLimit: 100 }; }
function drawer(id: string, mode: "line" | "ribbon" | "tube" | "points", retention: unknown) { return { id, driver: movingGraph(), retention, output: output(mode) }; }
function movingGraph() { return { kind: "parametric-graph", graph: { nodes: [{ id: "t", kind: "time-us" }, { id: "scale", kind: "constant", value: 0.001 }, { id: "x", kind: "multiply", left: "t", right: "scale" }, { id: "z", kind: "constant", value: 2 }, { id: "zero", kind: "constant", value: 0 }], output: { x: "x", y: "zero", z: "z" } } }; }
function authorityMotion(): MotionDocument { return { schema: "shellx-motion/motion@1", id: "trace-authority", name: "Trace authority", durationMs: 4, fps: 30, width: 64, height: 64, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [{ id: "source", type: "shape", shape: "rect", startMs: 0, durationMs: 4, transform: { x: 5, y: 5, width: 1, height: 1 } }, { id: "related", type: "shape", shape: "rect", startMs: 0, durationMs: 4, transform: { x: 0, y: 0, width: 1, height: 1 } }], relations: { schema: "shellx-motion/relations@1", bindings: [{ id: "follow", enabled: true, kind: "attach", source: { layerId: "source", anchor: { x: 0, y: 0 } }, target: { layerId: "related", anchor: { x: 0, y: 0 } }, startUs: 0, durationUs: 4_000, mode: "follow", offset: { space: "world", x: 0, y: 0, rotationDeg: 0, scale: 1 } }] } }; }
function f32(bytes: Uint8Array, offset: number): number { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(offset, true); }
function u8(bytes: Uint8Array, offset: number): number { return bytes[offset]!; }
