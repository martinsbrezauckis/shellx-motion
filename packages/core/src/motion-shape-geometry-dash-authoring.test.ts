import { describe, expect, it } from "vitest";
import { removeMotionShapeGeometryDash, setMotionShapeGeometryDash } from "./motion-shape-geometry-dash-authoring";
import type { MotionDocument, MotionLayer } from "./types";

function layer(style: Record<string, unknown> = { stroke: "#ffffff", strokeWidth: 2 }): MotionLayer {
  return {
    id: "line", type: "shape", startMs: 0, durationMs: 100, style,
    geometry: { schema: "shellx-motion/shape-geometry@1", kind: "line", viewBox: { x: 0, y: 0, width: 100, height: 100 }, points: [{ x: 0, y: 50 }, { x: 100, y: 50 }] }
  };
}

function motion(value = layer()): MotionDocument {
  return { schema: "shellx-motion/motion@1", id: "dash", name: "Dash", durationMs: 100, fps: 30, width: 100, height: 100, layers: [value], assets: [], provenance: { sourceApp: "test", createdBy: "test" } };
}

describe("typed shape geometry dash authoring", () => {
  it("sets a canonical pair, refuses semantic no-op, and removes both fields", () => {
    const source = motion(); const original = structuredClone(source);
    const set = setMotionShapeGeometryDash(source, { layerId: "line", strokeDasharray: [4, 2, 1], strokeDashoffset: -1 });
    expect(source).toEqual(original);
    expect(set.layer.style).toMatchObject({ strokeDasharray: [4, 2, 1, 4, 2, 1], strokeDashoffset: 13 });
    expect(set.changedPaths).toEqual(["/layers/line/style/strokeDasharray", "/layers/line/style/strokeDashoffset"]);
    expect(() => setMotionShapeGeometryDash(set.motion, { layerId: "line", strokeDasharray: [4, 2, 1, 4, 2, 1], strokeDashoffset: 13 })).toThrow(/did not change/);
    const removed = removeMotionShapeGeometryDash(set.motion, { layerId: "line" });
    expect(removed.layer.style).toEqual({ stroke: "#ffffff", strokeWidth: 2 });
    expect(() => removeMotionShapeGeometryDash(removed.motion, { layerId: "line" })).toThrow(/already absent/);
  });

  it("refuses malformed input, missing visible stroke, legacy geometry, and locked ownership", () => {
    expect(() => setMotionShapeGeometryDash(motion(), { layerId: "line", strokeDasharray: [0] })).toThrow(/strokeDasharray\[0\]/);
    expect(() => setMotionShapeGeometryDash(motion(layer({ strokeWidth: 2 })), { layerId: "line", strokeDasharray: [2, 2] })).toThrow(/explicit supported visible stroke/);
    expect(() => setMotionShapeGeometryDash(motion({ ...layer(), geometry: undefined, shape: "path", "x-path": "M0 0 L100 100" }), { layerId: "line", strokeDasharray: [2, 2] })).toThrow(/valid v1 geometry/);
    expect(() => setMotionShapeGeometryDash(motion({ ...layer(), locked: true }), { layerId: "line", strokeDasharray: [2, 2] })).toThrow(/locked layer/);
    expect(() => setMotionShapeGeometryDash(motion(), { layerId: "line", strokeDasharray: [2, 2], extra: true } as never)).toThrow(/unknown field extra/);
  });
});
