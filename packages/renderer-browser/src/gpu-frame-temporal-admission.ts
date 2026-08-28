import type { InternalGpuFrameDraw } from "./gpu-runtime-types";

export interface GpuTemporalAdmission {
  readonly groupCount: number;
  readonly sampleCount: number;
  /** Actual fixed environment sample draws, not authored-layer cardinality. */
  readonly environmentDrawCount: number;
  /** Static environments plus one authored layer for each environment shutter group. */
  readonly authoredEnvironmentCount: number;
}

/**
 * Re-admits every temporal span after individual draws have been normalized.
 * Environment shutter groups are intentionally narrower than primitive groups:
 * one fixed environment draw for every declared shutter sample, with no mixed
 * source kinds or per-sample compositing.
 */
export function admitGpuTemporalGrammar(draws: readonly InternalGpuFrameDraw[]): GpuTemporalAdmission | null {
  let groupCount = 0;
  let sampleCount = 0;
  let environmentDrawCount = 0;
  let authoredEnvironmentCount = 0;
  for (let index = 0; index < draws.length; index += 1) {
    const start = draws[index];
    if (start.kind === "motionBlurEnd") return null;
    if (start.kind !== "motionBlurStart") {
      if (start.kind === "environment") authoredEnvironmentCount += 1;
      continue;
    }
    const endIndex = index + start.drawCount + 1;
    const end = draws[endIndex];
    if (!end || end.kind !== "motionBlurEnd" || end.groupId !== start.id) return null;
    const first = draws[index + 1];
    const environmentOnly = first?.kind === "environment";
    if (environmentOnly && start.drawCount !== start.sampleCount) return null;
    if (environmentOnly) authoredEnvironmentCount += 1;
    for (let childIndex = index + 1; childIndex < endIndex; childIndex += 1) {
      const child = draws[childIndex];
      if (!child || !("blendMode" in child) || child.blendMode !== "normal" || child.effects !== null || child.mask !== undefined) return null;
      if (environmentOnly) {
        if (child.kind !== "environment") return null;
        environmentDrawCount += 1;
        continue;
      }
      if (!(["rect", "image", "points", "text", "ellipse", "triangles", "coloredTriangles", "gradientRect", "styledRect"] as const).includes(child.kind as "rect" | "image" | "points" | "text" | "ellipse" | "triangles" | "coloredTriangles" | "gradientRect" | "styledRect")) return null;
    }
    groupCount += 1;
    sampleCount += start.sampleCount;
    index = endIndex;
  }
  return { groupCount, sampleCount, environmentDrawCount, authoredEnvironmentCount };
}
