import { parseGpuSceneColor } from "./gpu-scene-color";
import type { GpuLayerMaskIntent, GpuPrimitiveIntent } from "./gpu-frame-intent";
import type { GpuComputeParticleFieldV2Intent, GpuComputeParticleIntent } from "./gpu-frame-particle-compute-intent";
import type { GpuScene2dFailure } from "./gpu-scene-2d-plan";
import { compileGpuSceneWipeMask } from "./gpu-scene-wipe-transition";
import type { MotionDocument, MotionLayer } from "./types";

type MaskResult = { ok: true; draw: GpuPrimitiveIntent; maskKind: "mask" | "matte" | null } | { ok: false; failure: GpuScene2dFailure };
type MaskablePrimitive = Exclude<GpuPrimitiveIntent, { kind: "points" }>;

/** Adds the one bounded canvas-space mask which the fixed GPU compositor can carry. */
export function compileGpuSceneLayerMask(motion: MotionDocument, layer: MotionLayer, draw: GpuPrimitiveIntent, atMs: number): MaskResult {
  if (layer.mask && layer.matte) return failure(layer, "GPU layers cannot combine a mask and track matte.");
  const wipe = compileGpuSceneWipeMask(layer, atMs);
  if (!wipe.ok) return failure(layer, wipe.message);
  if (wipe.mask) {
    if (layer.mask || layer.matte) return failure(layer, `GPU wipe transition on layer ${layer.id} cannot exactly coexist with an authored mask or track matte in the single-mask ABI.`);
    if (draw.kind === "points" || draw.kind === "particleCompute") return failure(layer, "GPU point and particle layers do not yet support masks, mattes, or wipe transitions.");
    return { ok: true, draw: { ...draw, mask: wipe.mask }, maskKind: "mask" };
  }
  if (!layer.mask && !layer.matte) return { ok: true, draw, maskKind: null };
  if (draw.kind === "points" || (draw.kind === "particleCompute" && !isV2Compute(draw))) return failure(layer, "GPU point and particle layers do not yet support masks or mattes.");
  const mask = layer.mask ? authoredMask(motion, layer, draw) : trackMatte(motion, layer, atMs);
  if (!mask.ok) return mask;
  return { ok: true, draw: { ...draw, mask: mask.mask }, maskKind: layer.mask ? "mask" : "matte" };
}

function authoredMask(motion: MotionDocument, layer: MotionLayer, draw: MaskablePrimitive): { ok: true; mask: GpuLayerMaskIntent } | { ok: false; failure: GpuScene2dFailure } {
  const mask = layer.mask!;
  if (mask.type !== "rect" && mask.type !== "rounded-rect") return failure(layer, `GPU scene supports rect and rounded-rect masks; layer ${layer.id} uses '${mask.type}'.`);
  const box = drawBounds(motion, draw); const inset = mask.inset ?? {};
  const top = nonNegative(inset.top ?? 0); const right = nonNegative(inset.right ?? 0); const bottom = nonNegative(inset.bottom ?? 0); const left = nonNegative(inset.left ?? 0);
  const radius = nonNegative(mask.radius ?? 0); const opacity = unit(mask.opacity ?? 1); const featherPx = range(mask.featherPx ?? 0, 0, 128); const expansionPx = range(mask.expansionPx ?? 0, -128, 128);
  if ([top, right, bottom, left, radius, opacity, featherPx, expansionPx].some((value) => value === null)) return failure(layer, `GPU scene layer ${layer.id} has invalid mask geometry.`);
  const x = box.x + left! - expansionPx!; const y = box.y + top! - expansionPx!;
  const width = box.width - left! - right! + expansionPx! * 2; const height = box.height - top! - bottom! + expansionPx! * 2;
  if (width <= 0 || height <= 0) return failure(layer, `GPU scene layer ${layer.id} mask insets collapse its layer bounds.`);
  const transform = maskTransform(motion, draw);
  return { ok: true, mask: { shape: "rect", x, y, width, height, radius: Math.min(radius!, width / 2, height / 2), ...transform, inverted: mask.inverted === true, opacity: opacity!, featherPx: featherPx! } };
}

function trackMatte(motion: MotionDocument, consumer: MotionLayer, atMs: number): { ok: true; mask: GpuLayerMaskIntent } | { ok: false; failure: GpuScene2dFailure } {
  const matte = consumer.matte!; const inverted = matte.type === "alpha-inverted" || matte.type === "luma-inverted";
  if (!["alpha", "alpha-inverted", "luma", "luma-inverted"].includes(matte.type)) return failure(consumer, `GPU scene layer ${consumer.id} has unsupported matte type '${matte.type}'.`);
  if ((consumer.transform?.rotation ?? 0) !== 0 || (consumer.transform?.scale ?? 1) !== 1) return failure(consumer, `GPU matte consumer ${consumer.id} cannot use rotation or scale.`);
  const source = motion.layers.find((candidate) => candidate.id === matte.sourceLayerId);
  if (!source) return failure(consumer, `GPU scene layer ${consumer.id} references missing matte source ${matte.sourceLayerId}.`);
  if (!active(source, atMs)) return { ok: true, mask: constantMask(motion, inverted) };
  if (source.type !== "shape" || (source.shape !== "rect" && source.shape !== "ellipse" && source.shape !== "triangle")) return failure(consumer, `GPU track mattes currently require rect, ellipse, or triangle shape source ${source.id}.`);
  if (source.mask || source.matte || source.effects || source.blendMode || source.transitions || source.keyframes || source.label || source.visible === false) return failure(consumer, `GPU matte source ${source.id} must remain a static uncomposited shape.`);
  if (Object.keys(source.style ?? {}).some((key) => ["stroke", "shadow", "boxShadow", "borderRadius", "radius", "opacity"].includes(key))) return failure(consumer, `GPU matte source ${source.id} cannot use strokes, shadows, radii or style opacity.`);
  const transform = source.transform ?? {}; const scale = number(transform.scale ?? 1); const rotation = number(transform.rotation ?? 0); const opacity = number(transform.opacity ?? source.opacity ?? 1);
  if (scale !== 1 || rotation !== 0 || opacity !== 1) return failure(consumer, `GPU matte source ${source.id} cannot use scale, rotation or opacity.`);
  const width = positive(number(transform.width ?? source.width ?? styleNumber(source, "width") ?? 100)); const height = positive(number(transform.height ?? source.height ?? styleNumber(source, "height") ?? 100));
  const x = number(transform.x ?? 0); const y = number(transform.y ?? 0);
  if (width === null || height === null || x === null || y === null) return failure(consumer, `GPU matte source ${source.id} has invalid geometry.`);
  const fillValue = typeof source.style?.fill === "string" ? source.style.fill : "#ffffff"; const fill = parseGpuSceneColor(fillValue);
  if (!fill) return failure(consumer, `GPU matte source ${source.id} has unsupported fill '${fillValue}'.`);
  // SVG's `mask-type:luminance` uses the painted source's luminance multiplied by its
  // alpha.  The fixed mask pass applies the resulting scalar before premultiplied
  // compositing, so retaining the fill alpha here is required for browser/GPU parity.
  const strength = matte.type === "luma" || matte.type === "luma-inverted"
    ? (fill.r * 0.2126 + fill.g * 0.7152 + fill.b * 0.0722) * fill.a
    : 1;
  return { ok: true, mask: { shape: source.shape, x, y, width, height, radius: 0, rotationDeg: 0, pivotX: x + width / 2, pivotY: y + height / 2, inverted, opacity: strength, featherPx: 0 } };
}

function constantMask(motion: MotionDocument, inverted: boolean): GpuLayerMaskIntent { return { shape: "rect", x: 0, y: 0, width: motion.width, height: motion.height, radius: 0, rotationDeg: 0, pivotX: motion.width / 2, pivotY: motion.height / 2, inverted, opacity: 0, featherPx: 0 }; }
function drawBounds(motion: MotionDocument, draw: MaskablePrimitive): {x:number;y:number;width:number;height:number} {
  if (draw.kind === "scene3d") return {x:0,y:0,width:motion.width,height:motion.height};
  if (draw.kind === "particleCompute") return particleCanvasBounds(draw);
  if (draw.kind === "triangles" || draw.kind === "coloredTriangles") { const xs=draw.vertices.map((point)=>point.x),ys=draw.vertices.map((point)=>point.y),x=Math.min(...xs),y=Math.min(...ys);return{x,y,width:Math.max(...xs)-x,height:Math.max(...ys)-y}; }
  return { x: draw.x, y: draw.y, width: draw.width, height: draw.height };
}

/** Matches the fixed v2 compute placement before its rotation is applied. */
function particleCanvasBounds(draw: GpuComputeParticleIntent): { x: number; y: number; width: number; height: number } {
  return {
    x: draw.x + draw.originX - draw.originX * draw.scale,
    y: draw.y + draw.originY - draw.originY * draw.scale,
    width: draw.width * draw.scale,
    height: draw.height * draw.scale
  };
}

function maskTransform(motion: MotionDocument, draw: MaskablePrimitive): Pick<GpuLayerMaskIntent, "rotationDeg" | "pivotX" | "pivotY"> {
  if (draw.kind === "scene3d") return { rotationDeg: 0, pivotX: motion.width / 2, pivotY: motion.height / 2 };
  if (draw.kind === "particleCompute") return { rotationDeg: draw.rotationDeg, pivotX: draw.x + draw.originX, pivotY: draw.y + draw.originY };
  return { rotationDeg: draw.rotationDeg, pivotX: draw.pivotX, pivotY: draw.pivotY };
}

function isV2Compute(draw: Extract<GpuPrimitiveIntent, { kind: "particleCompute" }>): draw is GpuComputeParticleFieldV2Intent {
  return draw.schema === "shellx-motion/gpu-compute-particle-field@2";
}
function active(layer: MotionLayer, atMs: number): boolean { return atMs >= layer.startMs && atMs < layer.startMs + layer.durationMs; }
function styleNumber(layer: MotionLayer, key: string): number | null { const value=layer.style?.[key];return typeof value === "number" && Number.isFinite(value) ? value : null; }
function number(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function positive(value: number | null): number | null { return value !== null && value > 0 && value <= 4_096 ? value : null; }
function range(value: unknown, minimum: number, maximum: number): number | null { return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum ? value : null; }
function nonNegative(value: unknown): number | null { return range(value, 0, 4_096); }
function unit(value: unknown): number | null { return range(value, 0, 1); }
function failure(layer: MotionLayer, message: string): { ok: false; failure: GpuScene2dFailure } { return { ok: false, failure: { code: "gpu_unsupported_feature", message, layerId: layer.id } }; }
