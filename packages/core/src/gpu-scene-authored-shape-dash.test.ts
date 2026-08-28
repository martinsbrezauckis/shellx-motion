import { describe, expect, it } from "vitest";
import { compileGpuScene2dPlan } from "./gpu-scene-2d-plan";
import { compileGpuSceneStaticPlan } from "./gpu-scene-static-plan";
import { compileGpuSceneAuthoredShapeGeometry, tessellateGpuSceneAuthoredShapeGeometry } from "./gpu-scene-path-geometry";
import { matchRendererCapability, rendererCapabilityForLane, requiredLayerFeatures } from "./capabilities";
import { MOTION_SHAPE_GEOMETRY_SCHEMA } from "./motion-shape-geometry";
import { readGpuSceneStrokeDash } from "./gpu-scene-stroke-dash";
import type { MotionDocument, MotionLayer, MotionShapeGeometry } from "./types";

const VIEW_BOX = { x: 0, y: 0, width: 100, height: 100 };
const LINE = { schema: MOTION_SHAPE_GEOMETRY_SCHEMA, kind: "line", viewBox: VIEW_BOX, points: [{ x: 0, y: 50 }, { x: 100, y: 50 }] } satisfies MotionShapeGeometry;
const SQUARE = { schema: MOTION_SHAPE_GEOMETRY_SCHEMA, kind: "polygon", viewBox: VIEW_BOX, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }] } satisfies MotionShapeGeometry;

function document(layer: MotionLayer): MotionDocument {
  return { schema: "shellx-motion/motion@1", id: "dash", name: "dash", durationMs: 1_000, fps: 30, width: 100, height: 100, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [layer] };
}

function shape(id: string, geometry: MotionShapeGeometry, style: Record<string, unknown>, extras: Record<string, unknown> = {}): MotionLayer {
  return { id, type: "shape", startMs: 0, durationMs: 1_000, geometry, transform: { width: 100, height: 100 }, style, ...extras };
}

function triangles(motion: MotionDocument): Array<{ x: number; y: number; color: { r: number; g: number; b: number; a: number } }> {
  const plan = compileGpuScene2dPlan(motion, 0);
  expect(plan.ok).toBe(true);
  if (!plan.ok) return [];
  const draw = plan.plan.frame.draws[0];
  expect(draw?.kind).toBe("coloredTriangles");
  return draw?.kind === "coloredTriangles" ? draw.vertices : [];
}

describe("GPU v1 authored shape dash lowering", () => {
  it("uses canonical odd-array and SVG-positive offset segmentation in one Core triangle plan", () => {
    const output = triangles(document(shape("odd", LINE, { stroke: "#ffffff", strokeWidth: 2, strokeLinejoin: "miter", strokeLinecap: "butt", strokeDasharray: [20, 10, 5], strokeDashoffset: 5 })));
    expect(output).toHaveLength(24);
    expect(output[0]).toMatchObject({ x: 5, y: 49 });
    expect(output[6]).toMatchObject({ x: 35, y: 49 });
  });

  it("uses transform-scaled rendered-length dashes after viewBox mapping", () => {
    const layer = shape("scaled", LINE, { stroke: "#ffffff", strokeWidth: 2, strokeLinejoin: "miter", strokeLinecap: "butt", strokeDasharray: [10, 10], strokeDashoffset: 5 });
    const compiled = compileGpuSceneAuthoredShapeGeometry(layer);
    const dash = readGpuSceneStrokeDash(layer.style, "dash test");
    expect(compiled.ok && dash.ok && dash.dash).toBeTruthy();
    if (!compiled.ok || !dash.ok || !dash.dash) return;
    const output = tessellateGpuSceneAuthoredShapeGeometry({ geometry: compiled.geometry, box: VIEW_BOX, fill: null, stroke: { r: 1, g: 1, b: 1, a: 1 }, strokeWidth: 4, dash: dash.dash, dashScale: 2 });
    expect(output[0]).toMatchObject({ x: 10, y: 48 });
    expect(output).toHaveLength(18);
  });

  it("binds canonical dash data into immutable geometry, static, and frame identities", () => {
    const first = shape("identity", LINE, { stroke: "#ffffff", strokeWidth: 2, strokeLinejoin: "miter", strokeLinecap: "butt", strokeDasharray: [10, 5], strokeDashoffset: 0 });
    const second = { ...first, style: { ...first.style, strokeDashoffset: 1 } };
    const one = compileGpuSceneAuthoredShapeGeometry(first), two = compileGpuSceneAuthoredShapeGeometry(second);
    expect(one.ok && two.ok).toBe(true);
    if (!one.ok || !two.ok) return;
    expect(one.geometry.strokeDash).toMatchObject({ pattern: [10, 5], offset: 0 });
    expect(two.geometry.strokeDash).toMatchObject({ pattern: [10, 5], offset: 1 });
    expect(one.geometry.fingerprint).not.toBe(two.geometry.fingerprint);
    const firstMotion = document(first), secondMotion = document(second);
    const firstFrame = compileGpuScene2dPlan(firstMotion, 0), secondFrame = compileGpuScene2dPlan(secondMotion, 0);
    const firstStatic = compileGpuSceneStaticPlan(firstMotion), secondStatic = compileGpuSceneStaticPlan(secondMotion);
    expect(firstFrame.ok && secondFrame.ok && firstStatic.ok && secondStatic.ok).toBe(true);
    if (!firstFrame.ok || !secondFrame.ok || !firstStatic.ok || !secondStatic.ok) return;
    expect(firstFrame.plan.frame.fingerprint).not.toBe(secondFrame.plan.frame.fingerprint);
    expect(firstStatic.plan.fingerprint).not.toBe(secondStatic.plan.fingerprint);
  });

  it("advertises dash only for the v1 triangle path and keeps legacy path dash refused", () => {
    const v1 = document(shape("v1-dash", LINE, { stroke: "#ffffff", strokeWidth: 2, strokeLinejoin: "miter", strokeLinecap: "butt", strokeDasharray: [2, 2] }));
    expect(matchRendererCapability(v1, rendererCapabilityForLane("gpu"))).toEqual({ ok: true, lane: "gpu", unsupported: [] });
    const legacy = document({ id: "legacy-dash", type: "shape", shape: "path", startMs: 0, durationMs: 1_000, "x-path": "M 0 0 L 100 0 L 100 100 L 0 100 Z", "x-path-viewBox": "0 0 100 100", style: { stroke: "#ffffff", strokeWidth: 2, strokeLinejoin: "miter", strokeLinecap: "butt", strokeDasharray: [2, 2] } });
    expect(requiredLayerFeatures(legacy.layers[0])).toContain("shape.stroke.dash.legacy");
    expect(matchRendererCapability(legacy, rendererCapabilityForLane("gpu"))).toMatchObject({ ok: false, lane: "gpu", unsupported: [{ layerId: "legacy-dash", feature: "gpu.scene.eligibility" }] });
  });

  it("keeps one closed seam run connected while retaining fill plus dashed stroke", () => {
    const output = triangles(document(shape("seam", SQUARE, { stroke: "#00ff00", strokeWidth: 2, strokeLinejoin: "miter", strokeLinecap: "butt", strokeDasharray: [100, 100], strokeDashoffset: 150 }, { fill: "#ff0000" })));
    expect(output).toHaveLength(30);
    expect(output.slice(0, 6).every((vertex) => vertex.color.r === 1 && vertex.color.g === 0)).toBe(true);
    expect(output.slice(6).every((vertex) => vertex.color.r === 0 && vertex.color.g === 1)).toBe(true);
    expect(output.filter((vertex) => vertex.x === 0 && vertex.y === 0)).toHaveLength(2);
  });

  it("refuses absent strokes and hostile dash frequency instead of treating either as solid", () => {
    const noStroke = compileGpuScene2dPlan(document(shape("no-stroke", SQUARE, { strokeDasharray: [2, 2] })), 0);
    expect(noStroke).toMatchObject({ ok: false, failure: { layerId: "no-stroke", message: expect.stringContaining("requires an explicit supported visible stroke") } });
    const invisibleStroke = compileGpuScene2dPlan(document(shape("invisible-stroke", LINE, { stroke: "#ffffff00", strokeWidth: 2, strokeLinejoin: "miter", strokeLinecap: "butt", strokeDasharray: [2, 2] })), 0);
    expect(invisibleStroke).toMatchObject({ ok: false, failure: { layerId: "invisible-stroke", message: expect.stringContaining("requires an explicit supported visible stroke") } });
    const hostile = compileGpuScene2dPlan(document(shape("hostile", LINE, { stroke: "#ffffff", strokeWidth: 2, strokeLinejoin: "miter", strokeLinecap: "butt", strokeDasharray: [0.000001, 0.000001] })), 0);
    expect(hostile).toMatchObject({ ok: false, failure: { layerId: "hostile", message: expect.stringContaining("256-segment ceiling") } });
    const scaleOverflow = compileGpuScene2dPlan(document(shape("scale-overflow", LINE, { stroke: "#ffffff", strokeWidth: 2, strokeLinejoin: "miter", strokeLinecap: "butt", strokeDasharray: [2, 2] }, { transform: { width: 100, height: 100, scale: 4097 } })), 0);
    expect(scaleOverflow).toMatchObject({ ok: false, failure: { layerId: "scale-overflow", message: expect.stringContaining("strokeDasharray[0]") } });
    const staticScaleOverflow = compileGpuSceneStaticPlan(document(shape("static-scale-overflow", LINE, { stroke: "#ffffff", strokeWidth: 2, strokeLinejoin: "miter", strokeLinecap: "butt", strokeDasharray: [2, 2] }, { transform: { width: 100, height: 100, scale: 4097 } })));
    expect(staticScaleOverflow).toMatchObject({ ok: false, failure: { layerId: "static-scale-overflow", message: expect.stringContaining("strokeDasharray[0]") } });
  });

  it("reserves the dash stroke ceiling during static planning before frame lowering", () => {
    const layers = Array.from({ length: 11 }, (_, index) => shape(`reserve-${index}`, SQUARE, { stroke: "#ffffff", strokeWidth: 2, strokeLinejoin: "miter", strokeLinecap: "butt", strokeDasharray: [100, 1] }));
    const result = compileGpuSceneStaticPlan({ ...document(layers[0]), layers });
    expect(result).toMatchObject({ ok: false, failure: { code: "gpu_resource_refused", message: expect.stringContaining("65535 authored shape triangle vertices") } });
  });
});
