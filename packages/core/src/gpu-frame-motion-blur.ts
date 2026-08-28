import type { GpuDrawIntent, GpuMotionBlurStartIntent } from "./gpu-frame-intent-types";

/** One authored shutter group can contribute at most eight fixed samples. */
export const GPU_MAX_TEMPORAL_SAMPLES = 8;

/** Reads one bounded control marker; sample primitives remain ordinary admitted draws. */
export function readGpuMotionBlurStart(
  value: Record<string, unknown>,
  id: string,
  composite: Pick<GpuMotionBlurStartIntent, "blendMode" | "effects" | "mask">,
  refuse: (message: string) => never
): GpuMotionBlurStartIntent {
  const sampleCount = integer(value.sampleCount, 2, GPU_MAX_TEMPORAL_SAMPLES, `${id}.sampleCount`, refuse);
  const drawCount = integer(value.drawCount, sampleCount, 256, `${id}.drawCount`, refuse);
  const shutterAngle = finiteRange(value.shutterAngle, 0, 360, `${id}.shutterAngle`, refuse, true);
  const shutterDurationMs = finiteRange(value.shutterDurationMs, 0, 1_000, `${id}.shutterDurationMs`, refuse, true);
  return { kind: "motionBlurStart", id, ...composite, sampleCount, drawCount, shutterAngle, shutterDurationMs };
}

/** Validates a flat, non-nestable group grammar before the plan is fingerprinted. */
export function validateGpuMotionBlurGroups(draws: readonly GpuDrawIntent[], refuse: (message: string) => never): { groupCount: number; sampleCount: number; environmentGroupCount: number; environmentDrawCount: number } {
  let groupCount = 0; let sampleCount = 0, environmentGroupCount = 0, temporalEnvironmentDrawCount = 0;
  for (let index = 0; index < draws.length; index += 1) {
    const start = draws[index];
    if (start.kind === "motionBlurEnd") refuse(`GPU temporal group '${start.groupId}' closes without an opener.`);
    if (start.kind !== "motionBlurStart") continue;
    const endIndex = index + start.drawCount + 1; const end = draws[endIndex];
    if (!end || end.kind !== "motionBlurEnd" || end.groupId !== start.id) refuse(`GPU temporal group '${start.id}' does not have an exact closing marker.`);
    let groupEnvironmentDrawCount = 0;
    for (let childIndex = index + 1; childIndex < endIndex; childIndex += 1) {
      const child = draws[childIndex];
      if (child.kind === "adjustment" || child.kind === "effectModule" || child.kind === "particleCompute" || child.kind === "scene3d" || child.kind === "material" || child.kind === "motionBlurStart" || child.kind === "motionBlurEnd" || child.kind === "groupStart" || child.kind === "groupEnd") refuse(`GPU temporal group '${start.id}' accepts only static-raster or fixed-environment sample draws.`);
      if (child.blendMode !== "normal" || child.effects !== null || child.mask !== undefined) refuse(`GPU temporal group '${start.id}' sample draws must be uncomposited.`);
      if (child.kind === "environment") groupEnvironmentDrawCount += 1;
    }
    if (groupEnvironmentDrawCount > 0 && (groupEnvironmentDrawCount !== start.sampleCount || start.drawCount !== start.sampleCount)) refuse(`GPU temporal environment group '${start.id}' requires exactly one fixed environment draw per shutter sample.`);
    if (groupEnvironmentDrawCount > 0) { environmentGroupCount += 1; temporalEnvironmentDrawCount += groupEnvironmentDrawCount; }
    groupCount += 1; sampleCount += start.sampleCount; index = endIndex;
  }
  return { groupCount, sampleCount, environmentGroupCount, environmentDrawCount: temporalEnvironmentDrawCount };
}

function integer(value: unknown, minimum: number, maximum: number, name: string, refuse: (message: string) => never): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) refuse(`${name} must be an integer in ${minimum}..${maximum}.`);
  return value as number;
}
function finiteRange(value: unknown, minimum: number, maximum: number, name: string, refuse: (message: string) => never, exclusiveMinimum = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || (exclusiveMinimum ? value <= minimum : value < minimum) || value > maximum) refuse(`${name} must be finite in ${exclusiveMinimum ? `(${minimum}` : `[${minimum}`},${maximum}].`);
  return value as number;
}
