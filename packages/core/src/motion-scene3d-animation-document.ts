import { compileMotionScene3DAnimationPlan } from "./motion-scene3d-animation-plan";
import { readMotionScene3DAnimationDescriptor } from "./motion-scene3d-animation-read";
import type { MotionScene3DAnimationDescriptor } from "./motion-scene3d-animation-types";

export interface MotionScene3DAnimationDocumentIssue { path: string; message: string }
export type MotionScene3DAnimationDocumentValidation =
  | { ok: true; descriptor: MotionScene3DAnimationDescriptor | undefined }
  | { ok: false; issues: readonly MotionScene3DAnimationDocumentIssue[] };

/**
 * Validates the persisted descriptor against the existing document-owned scene3d layers.
 *
 * This admits bounded static authority only. It deliberately does not sample every continuous
 * time: combined position/target camera validity remains exact frame-time evaluator evidence.
 */
export function validateMotionScene3DAnimationDocument(
  value: unknown,
  context: { durationMs: unknown; layers: readonly unknown[] },
): MotionScene3DAnimationDocumentValidation {
  if (value === undefined) return { ok: true, descriptor: undefined };
  try {
    const descriptor = readMotionScene3DAnimationDescriptor(value);
    const durationUs = documentUs(context.durationMs);
    for (const [trackIndex, track] of descriptor.tracks.entries()) {
      for (const [keyframeIndex, keyframe] of track.keyframes.entries()) {
        if (keyframe.atUs > durationUs) {
          return fail(`/scene3dAnimation/tracks/${trackIndex}/keyframes/${keyframeIndex}/atUs`, "must fit the document duration exactly in microseconds");
        }
      }
    }
    const compiled = compileMotionScene3DAnimationPlan({ animation: descriptor, source: { layers: scene3dLayers(context.layers) } });
    if (!compiled.ok) return fail("/scene3dAnimation", compiled.message);
    return { ok: true, descriptor };
  } catch (error) {
    return fail("/scene3dAnimation", error instanceof Error ? error.message : "must be a valid scene3d animation descriptor");
  }
}

/** Package reads share the runtime graph authority and keep descriptor canonicalization centralized. */
export function readMotionScene3DAnimationDocumentRoot(
  value: unknown,
  context: { durationMs: unknown; layers: readonly unknown[] },
): MotionScene3DAnimationDescriptor | undefined {
  if (value === undefined) return undefined;
  const descriptor = readMotionScene3DAnimationDescriptor(value);
  const result = validateMotionScene3DAnimationDocument(descriptor, context);
  if (!result.ok) throw new Error(`Motion document scene3dAnimation is invalid: ${result.issues[0]!.message}`);
  return descriptor;
}

function documentUs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("requires a finite document durationMs");
  const result = value * 1_000;
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error("requires an exactly representable positive document duration in microseconds");
  return result;
}

/** Select by own data descriptor so source admission never evaluates a candidate layer getter. */
function scene3dLayers(layers: readonly unknown[]): unknown[] {
  const selected: unknown[] = [];
  for (const layer of layers) {
    if (typeof layer !== "object" || layer === null || Array.isArray(layer)) continue;
    const type = dataDescriptor(layer, "type");
    if (type !== "scene3d") continue;
    const source: Record<string, unknown> = {};
    for (const key of ["id", "type", "scene3d"] as const) {
      Object.defineProperty(source, key, { value: dataDescriptor(layer, key), enumerable: true, configurable: true, writable: true });
    }
    selected.push(source);
  }
  return selected;
}

function dataDescriptor(value: object, key: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try { descriptor = Object.getOwnPropertyDescriptor(value, key); }
  catch { throw new Error("scene3d layer reflection failed"); }
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error(`scene3d layer ${key} must be an enumerable data field`);
  return descriptor.value;
}

function fail(path: string, message: string): MotionScene3DAnimationDocumentValidation {
  return { ok: false, issues: Object.freeze([{ path, message }]) };
}
