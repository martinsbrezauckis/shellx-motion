import { canonicalJson, hashBuffer, motionLayoutGapAnimationLaneRefusal, motionScene3DAnimationLaneRefusal, type MotionPackage } from "@shellx-motion/core";
import { cutRelationUnsupported } from "./relation-admission.js";

/** Root-store admission stays outside Cut's layer-lowering catalogue until a receiver lowers it. */
export function cutScene3DAnimationUnsupported(pkg: MotionPackage) {
  const refusal = motionScene3DAnimationLaneRefusal(pkg.motion, "cut");
  return refusal ? [{
    layerId: "__scene3d_animation__",
    feature: refusal.feature,
    reason: refusal.message,
  }] : undefined;
}

export function cutLayoutGapAnimationUnsupported(pkg: MotionPackage) {
  const refusal = motionLayoutGapAnimationLaneRefusal(pkg.motion, "cut");
  return refusal ? [{
    layerId: "__layout_gap_animation__",
    feature: refusal.feature,
    reason: refusal.message,
  }] : undefined;
}

/** Both persisted roots are outside Cut's current lowering catalogue. */
export function cutRootStoreUnsupported(pkg: MotionPackage) {
  return cutLayoutGapAnimationUnsupported(pkg) ?? cutScene3DAnimationUnsupported(pkg) ?? cutRelationUnsupported(pkg);
}

export interface CutRootStoreRefusalInput {
  pkg: MotionPackage;
  rootDescriptorEvidence?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

const ROOT_STORES = ["layoutGapAnimation", "scene3dAnimation", "relations"] as const;

/** A refusal receipt preserves only enumerable data roots, never an obscured optional root. */
export function cutRootStoreRefusalInput(pkg: MotionPackage): CutRootStoreRefusalInput {
  const evidence: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const root of ROOT_STORES) {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(pkg.motion, root); }
    catch { return fallback(pkg, { ...evidence, [root]: descriptorEvidence("reflection-failed") }); }
    if (descriptor && !("value" in descriptor)) evidence[root] = descriptorEvidence("accessor", descriptor);
    else if (descriptor && !descriptor.enumerable) evidence[root] = descriptorEvidence("non-enumerable-data", descriptor);
  }
  if (Object.keys(evidence).length === 0) return { pkg };
  try {
    const motion = Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(pkg.motion))
      .flatMap(([key, descriptor]) => key in evidence || !descriptor.enumerable || !("value" in descriptor) ? [] : [[key, descriptor.value]]));
    return { pkg: { ...pkg, motion: motion as MotionPackage["motion"] }, rootDescriptorEvidence: Object.freeze(evidence) };
  } catch {
    return fallback(pkg, evidence);
  }
}

/** Descriptor evidence is canonical and explicitly named instead of pretending to hash the motion document. */
export function cutRootStoreRefusalInputHashes(evidence: NonNullable<CutRootStoreRefusalInput["rootDescriptorEvidence"]>): Record<string, string> {
  return Object.fromEntries(Object.entries(evidence).map(([root, descriptor]) => [`${root}.rootDescriptor`, hashBuffer(Buffer.from(canonicalJson(descriptor)))]));
}

function descriptorEvidence(kind: "accessor" | "non-enumerable-data" | "reflection-failed", descriptor?: PropertyDescriptor): Readonly<Record<string, unknown>> {
  return Object.freeze({ schema: "shellx-motion/cut-motion-root-descriptor@1", kind, ...(descriptor ? { enumerable: descriptor.enumerable, configurable: descriptor.configurable, hasGet: typeof descriptor.get === "function", hasSet: typeof descriptor.set === "function" } : {}) });
}

function fallback(pkg: MotionPackage, evidence: Record<string, Readonly<Record<string, unknown>>>): CutRootStoreRefusalInput {
  return { pkg: { ...pkg, motion: { schema: "shellx-motion/motion@1", id: "unavailable", name: "Unavailable", durationMs: 1, fps: 1, width: 1, height: 1, assets: [], provenance: { sourceApp: "unavailable", createdBy: "unavailable" }, layers: [] } }, rootDescriptorEvidence: Object.freeze(evidence) };
}
