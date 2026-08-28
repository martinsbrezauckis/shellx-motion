import { describe, expect, it } from "vitest";
import {
  GPU_SCENE_STROKE_DASH_MAX_AUTHORED_ITEMS,
  GPU_SCENE_STROKE_DASH_MAX_OFFSET,
  GPU_SCENE_STROKE_DASH_SCHEMA,
  readGpuSceneStrokeDash,
  segmentGpuSceneStrokeDash,
} from "./gpu-scene-stroke-dash";

const open = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];

function dash(style: unknown) {
  const result = readGpuSceneStrokeDash(style, "dash test");
  expect(result.ok).toBe(true);
  if (!result.ok || result.dash === null) throw new Error("dash test expected a dash record");
  return result.dash;
}

function xs(vertices: readonly { x: number; y: number }[]): Array<[number, number]> {
  return vertices.map((vertex) => [vertex.x, vertex.y]);
}

describe("GPU scene stroke dash ABI", () => {
  it("treats absent data as solid and retains a closed source contour", () => {
    expect(readGpuSceneStrokeDash(undefined)).toEqual({ ok: true, dash: null });
    const result = segmentGpuSceneStrokeDash({ vertices: square, closed: true, dash: null });
    expect(result).toMatchObject({ ok: true, segmentation: { schema: GPU_SCENE_STROKE_DASH_SCHEMA, sourceClosed: true, dashed: false, segments: [{ closed: true }] } });
    if (!result.ok) return;
    expect(xs(result.segmentation.segments[0].vertices)).toEqual(xs(square));
  });

  it("uses SVG's odd-array repetition rule and canonical SVG-positive offset phase", () => {
    const odd = dash({ strokeDasharray: [3, 2, 1], strokeDashoffset: -0 });
    expect(odd).toEqual({ schema: GPU_SCENE_STROKE_DASH_SCHEMA, pattern: [3, 2, 1, 3, 2, 1], offset: 0 });

    // Positive offset moves the dash pattern backwards: offset 1 begins in the
    // final one-unit gap, then emits [1,4] and [6,9] along the open path.
    const result = segmentGpuSceneStrokeDash({ vertices: open, closed: false, dash: dash({ strokeDasharray: [3, 2], strokeDashoffset: 1 }) });
    expect(result).toMatchObject({ ok: true, segmentation: { dashed: true, sourceClosed: false, segments: [{ closed: false }, { closed: false }] } });
    if (!result.ok) return;
    expect(result.segmentation.segments.map((segment) => xs(segment.vertices))).toEqual([
      [[1, 0], [4, 0]],
      [[6, 0], [9, 0]],
    ]);
  });

  it("refuses malformed, hostile, and silently-ignored authored dash data", () => {
    const cases: Array<[unknown, string]> = [
      [{ strokeDashoffset: 1 }, "requires strokeDasharray"],
      [{ strokeDasharray: [] }, "non-empty numeric array"],
      [{ strokeDasharray: [0] }, "finite and in"],
      [{ strokeDasharray: [0.0000001] }, "collapses to zero"],
      [{ strokeDasharray: [Number.POSITIVE_INFINITY] }, "finite and in"],
      [{ strokeDasharray: Array.from({ length: GPU_SCENE_STROKE_DASH_MAX_AUTHORED_ITEMS + 1 }, () => 1) }, "at most"],
      [{ strokeDasharray: [4_096, 4_096, 4_096, 4_096, 1] }, "normalized strokeDasharray total"],
      [{ strokeDasharray: [1, 1], strokeDashoffset: GPU_SCENE_STROKE_DASH_MAX_OFFSET + 1 }, "strokeDashoffset"],
    ];
    for (const [style, message] of cases) {
      expect(readGpuSceneStrokeDash(style, "dash test")).toEqual({ ok: false, message: expect.stringContaining(message) });
    }
  });

  it("refuses zero-length canonical contour edges and quantization collapse", () => {
    const pattern = dash({ strokeDasharray: [2, 2] });
    expect(segmentGpuSceneStrokeDash({ vertices: [{ x: 0, y: 0 }, { x: 0, y: 0 }], closed: false, dash: pattern })).toEqual({ ok: false, message: expect.stringContaining("zero-length edge") });
    expect(segmentGpuSceneStrokeDash({ vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }], closed: true, dash: pattern })).toEqual({ ok: false, message: expect.stringContaining("zero-length closing edge") });
    expect(segmentGpuSceneStrokeDash({ vertices: [{ x: 0, y: 0 }, { x: 0.0000001, y: 0 }], closed: false, dash: pattern })).toEqual({ ok: false, message: expect.stringContaining("zero-length edge") });
  });

  it("merges a painted closed-contour wrap into one cap-safe open run", () => {
    const result = segmentGpuSceneStrokeDash({
      vertices: square,
      closed: true,
      dash: dash({ strokeDasharray: [10, 10], strokeDashoffset: 15 })
    });
    expect(result).toMatchObject({ ok: true, segmentation: { segments: [{ closed: false }, { closed: false }] } });
    if (!result.ok) return;
    expect(result.segmentation.segments.map((segment) => xs(segment.vertices))).toEqual([
      [[0, 5], [0, 0], [5, 0]],
      [[10, 5], [10, 10], [5, 10]],
    ]);
  });

  it("retains the closed topology when one dash covers the whole loop", () => {
    const result = segmentGpuSceneStrokeDash({ vertices: square, closed: true, dash: dash({ strokeDasharray: [100, 1] }) });
    expect(result).toMatchObject({ ok: true, segmentation: { segments: [{ closed: true }] } });
  });

  it("refuses a hostile dash frequency before emitting unbounded output", () => {
    const result = segmentGpuSceneStrokeDash({ vertices: [{ x: 0, y: 0 }, { x: 1, y: 0 }], closed: false, dash: dash({ strokeDasharray: [0.000001, 0.000001] }) });
    expect(result).toEqual({ ok: false, message: expect.stringContaining("256-segment ceiling") });
  });
});
