import type { MotionDocument } from "./types";

/**
 * Closed GPU admission vocabulary: these document authorities are either lowered by an explicit
 * wrapper that removes them from its Core source, or they must refuse before generic GPU planning.
 * `relations` and `behaviors` keep their existing dedicated sentinels; metadata/inverse roots are
 * not executable render authority. `x-compositing-compile` is paired compositing metadata, so its
 * owning `compositing` root is the only compositing entry in this closed set.
 */
export const GPU_UNLOWERED_ROOT_AUTHORITIES = Object.freeze(["relationships", "compositing"] as const);
export type GpuUnloweredRootAuthority = typeof GPU_UNLOWERED_ROOT_AUTHORITIES[number];

export function gpuUnloweredRootAuthorityRefusal(
  motion: MotionDocument,
  lane: "static" | "frame" | "scene3d-animation" | "capability",
): string | undefined {
  // GPU plans bind plain parsed Motion data only. Inherited fields and exotic prototypes can
  // carry authority that canonical JSON omits; inspect the prototype without reading a field.
  try {
    if (Object.getPrototypeOf(motion) !== Object.prototype) {
      return `GPU ${laneLabel(lane)} requires a plain Motion document with no inherited root authority before planning.`;
    }
  } catch {
    return `GPU ${laneLabel(lane)} cannot safely inspect the Motion document prototype before planning.`;
  }
  for (const root of GPU_UNLOWERED_ROOT_AUTHORITIES) {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(motion, root); }
    catch { return `GPU ${laneLabel(lane)} cannot safely inspect document relationships/compositing authority before planning.`; }
    if (descriptor !== undefined && (!("value" in descriptor) || descriptor.value !== undefined)) {
      return `GPU ${laneLabel(lane)} does not yet lower document ${root} authority; it refuses the root before assets, layers, resources, runtime, or output work.`;
    }
  }
  return undefined;
}

function laneLabel(lane: "static" | "frame" | "scene3d-animation" | "capability"): string {
  if (lane === "static") return "static planning";
  if (lane === "frame") return "frame planning";
  if (lane === "capability") return "capability matching";
  return "scene3d animation preview";
}
