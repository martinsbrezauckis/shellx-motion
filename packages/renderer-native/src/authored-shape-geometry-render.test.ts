import { describe, expect, it } from "vitest";
import { compileGpuScene2dPlan, matchRendererCapability, NATIVE_CAPABILITY, parseGpuSceneColor, type MotionDocument, type MotionPackage } from "@shellx-motion/core";
import { drawNativeAuthoredShapeGeometry, type NativeAuthoredShapeTransform } from "./native-authored-shape-geometry";
import { RgbaCanvas } from "./native-raster-canvas";

describe("native authored shape geometry", () => {
  it("rasterizes all six exact Core-lowered geometry kinds, including opacity and rotation", () => {
    const motion = geometryMotion();
    const plan = compileGpuScene2dPlan(motion, 0);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const draws = plan.plan.frame.draws.filter((draw) => draw.kind === "coloredTriangles");
    expect(matchRendererCapability(motion, NATIVE_CAPABILITY)).toEqual({ ok: true, lane: "native", unsupported: [] });
    expect(draws.map((draw) => draw.id)).toEqual(["line", "polyline", "polygon", "arc", "sector", "path"]);
    expect(draws.every((draw) => draw.vertices.length > 0 && draw.vertices.length <= 768)).toBe(true);
    const canvas = new RgbaCanvas(120, 80), pkg = { motion } as MotionPackage;
    for (const layer of motion.layers) draw(canvas, layer, pkg);
    expect(pixel(canvas, 15, 10)).toEqual([255, 0, 0, 255]);
    expect(pixel(canvas, 47, 12)).toEqual([0, 255, 0, 255]);
    expect(pixel(canvas, 95, 8)).toEqual([0, 0, 255, 128]);
    expect(pixel(canvas, 86, 4)).toEqual([0, 0, 0, 0]);
    expect(pixel(canvas, 15, 48)).toEqual([255, 255, 0, 255]);
    expect(pixel(canvas, 58, 42)).toEqual([0, 255, 255, 255]);
    expect(pixel(canvas, 95, 40)).toEqual([255, 0, 255, 255]);
  });

  it("uses Core's color/parser and open-stroke admission before native pixels are written", () => {
    const motion = geometryMotion(), canvas = new RgbaCanvas(120, 80), pkg = { motion } as MotionPackage;
    expect(parseGpuSceneColor("rebeccapurple")).toBeNull();
    const invalidColor = { ...motion.layers[5], style: { fill: "rebeccapurple" } };
    expect(() => draw(canvas, invalidColor, pkg)).toThrow(/unsupported fill/);
    const invalidOpen = { ...motion.layers[0], fill: "#ffffff" };
    expect(() => draw(canvas, invalidOpen, pkg)).toThrow(/stroke-only/);
    expect([...canvas.data]).toEqual(Array(canvas.data.length).fill(0));
  });

  it("uses the Core dash triangles for native pixels, including an odd array and offset", () => {
    const motion = geometryMotion(), canvas = new RgbaCanvas(120, 80), pkg = { motion } as MotionPackage;
    motion.layers[0] = { ...motion.layers[0], style: { stroke: "#ff0000", strokeWidth: 4, strokeLinecap: "butt", strokeLinejoin: "miter", strokeDasharray: [4, 2, 1], strokeDashoffset: 1 } };
    expect(matchRendererCapability(motion, NATIVE_CAPABILITY)).toEqual({ ok: true, lane: "native", unsupported: [] });
    draw(canvas, motion.layers[0], pkg);
    expect(pixel(canvas, 2, 10)).toEqual([255, 0, 0, 255]);
    expect(pixel(canvas, 6, 10)).toEqual([0, 0, 0, 0]);
  });

  it("clips canonical triangles before paint, so native geometry cannot bypass mask/wipe coverage", () => {
    const motion = geometryMotion(), canvas = new RgbaCanvas(120, 80), pkg = { motion } as MotionPackage;
    canvas.withClip({ x: 90, y: 35, width: 5, height: 5 }, () => draw(canvas, motion.layers[5], pkg));
    expect(pixel(canvas, 92, 37)).toEqual([255, 0, 255, 255]);
    expect(pixel(canvas, 96, 37)).toEqual([0, 0, 0, 0]);
  });
});

function geometryMotion(): MotionDocument {
  const viewBox = { x: 0, y: 0, width: 100, height: 100 }, base = { schema: "shellx-motion/shape-geometry@1", viewBox };
  const layer = (id: string, x: number, y: number, geometry: Record<string, unknown>, style: Record<string, unknown>) => ({ id, type: "shape", startMs: 0, durationMs: 1_000, transform: { x, y, width: 30, height: 20 }, geometry: { ...base, ...geometry }, style });
  return {
    schema: "shellx-motion/motion@1", id: "native_geometry", name: "Native geometry", durationMs: 1_000, fps: 30, width: 120, height: 80, background: "#00000000", assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [
      layer("line", 0, 0, { kind: "line", points: [{ x: 5, y: 50 }, { x: 95, y: 50 }] }, { stroke: "#ff0000", strokeWidth: 4, strokeLinecap: "butt", strokeLinejoin: "miter" }),
      layer("polyline", 40, 0, { kind: "polyline", points: [{ x: 10, y: 80 }, { x: 50, y: 20 }, { x: 90, y: 80 }] }, { stroke: "#00ff00", strokeWidth: 4, strokeLinecap: "butt", strokeLinejoin: "miter" }),
      { ...layer("polygon", 80, 0, { kind: "polygon", points: [{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 50, y: 90 }] }, { fill: "#0000ff" }), opacity: 0.5, transform: { x: 80, y: 0, width: 30, height: 20, rotation: 180, originX: 15, originY: 10 } },
      layer("arc", 0, 30, { kind: "arc", center: { x: 50, y: 50 }, radius: 40, startAngleDeg: 0, sweepAngleDeg: 180 }, { stroke: "#ffff00", strokeWidth: 4, strokeLinecap: "butt", strokeLinejoin: "miter" }),
      layer("sector", 40, 30, { kind: "sector", center: { x: 50, y: 50 }, radius: 40, startAngleDeg: 0, sweepAngleDeg: 90, innerRadius: 10 }, { fill: "#00ffff" }),
      layer("path", 80, 30, { kind: "path", data: "M 5 5 L 95 5 L 95 95 L 5 95 Z" }, { fill: "#ff00ff" })
    ]
  } as unknown as MotionDocument;
}

function draw(canvas: RgbaCanvas, layer: MotionDocument["layers"][number], pkg: MotionPackage): void {
  const raw = layer.transform as NativeAuthoredShapeTransform & { rotation?: number }, transform = { ...raw, scale: raw.scale ?? 1 }, rotation = raw.rotation ?? 0;
  if (rotation === 0) return drawNativeAuthoredShapeGeometry(canvas, layer, pkg, transform, layer.style ?? {}, String);
  const isolated = new RgbaCanvas(canvas.width, canvas.height);
  drawNativeAuthoredShapeGeometry(isolated, layer, pkg, transform, layer.style ?? {}, String);
  canvas.compositeRotated(isolated, transform.x + (transform.originX ?? transform.width! / 2), transform.y + (transform.originY ?? transform.height! / 2), rotation);
}

function pixel(canvas: RgbaCanvas, x: number, y: number): number[] { const offset = (y * canvas.width + x) * 4; return [...canvas.data.subarray(offset, offset + 4)]; }
