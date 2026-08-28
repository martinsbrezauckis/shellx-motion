import type { CapabilityMatch, MotionDocument, RendererCapability, RendererCapabilityCard, RendererCapabilityMatchOptions } from "./types";

/** T2B2 geometry execution is an opaque preview-only GPU wrapper, never transferable capability text. */
export function geometryKeyframesLegacyCapabilityMatch(motion: MotionDocument, capability: RendererCapability): CapabilityMatch | undefined {
  const unsupported = motion.layers.flatMap((layer) => layer.visible !== false && layer.geometryKeyframes !== undefined
    ? [{ layerId: layer.id, feature: "shape.geometry.keyframes", reason: `Lane ${capability.lane} does not support shape.geometry.keyframes on layer ${layer.id}.` }]
    : []);
  return unsupported.length === 0 ? undefined : { ok: false, lane: capability.lane, unsupported };
}

/** Explicit final/segmented refusal: Browser's selected preview producer is the sole T2B2 executor. */
export function gpuGeometryKeyframesTargetUnsupported(motion: MotionDocument, card: RendererCapabilityCard, options: RendererCapabilityMatchOptions): CapabilityMatch["unsupported"] {
  return card.lane === "gpu" && options.target !== undefined && options.target !== "preview"
    ? motion.layers.flatMap((layer) => layer.visible !== false && layer.geometryKeyframes !== undefined
      ? [{ layerId: layer.id, feature: "shape.geometry.keyframes", reason: "Lane gpu supports shape.geometry.keyframes only through the strict Browser GPU preview producer." }]
      : [])
    : [];
}
