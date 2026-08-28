import type { GpuDrawIntent, GpuGroupStartIntent } from "./gpu-frame-intent-types";

export const GPU_MAX_GROUPS = 64;
/** Four authored precomposition levels plus one internal camera/depth plane. */
export const GPU_MAX_GROUP_DEPTH = 5;

/** Reads one bounded isolated-precomposition marker. */
export function readGpuGroupStart(
  value: Record<string, unknown>, id: string,
  composite: Pick<GpuGroupStartIntent, "blendMode" | "effects" | "mask">,
  readCoordinate: (value: unknown, name: string) => number,
  readRotation: (value: unknown, name: string) => number,
  readUnit: (value: unknown, name: string) => number,
  refuse: (message: string) => never
): GpuGroupStartIntent {
  const drawCount = integer(value.drawCount, 0, 2_046, `${id}.drawCount`, refuse);
  const scale = finite(value.scale, `${id}.scale`, refuse);
  if (scale <= 0 || scale > 64) refuse(`${id}.scale must be finite in (0,64].`);
  return {
    kind: "groupStart", id, ...composite, drawCount,
    x: readCoordinate(value.x, `${id}.x`), y: readCoordinate(value.y, `${id}.y`), scale,
    rotationDeg: readRotation(value.rotationDeg, `${id}.rotationDeg`),
    pivotX: readCoordinate(value.pivotX, `${id}.pivotX`), pivotY: readCoordinate(value.pivotY, `${id}.pivotY`),
    opacity: readUnit(value.opacity, `${id}.opacity`)
  };
}

/** Validates exact nested group spans and returns bounded allocation depth. */
export function validateGpuGroups(draws: readonly GpuDrawIntent[], refuse: (message: string) => never): { groupCount: number; maxDepth: number } {
  let groupCount = 0; let maxDepth = 0; const stack: Array<{ id: string; endIndex: number }> = [];
  for (let index = 0; index < draws.length; index += 1) {
    const draw = draws[index];
    while (stack.length && index > stack[stack.length - 1].endIndex) refuse(`GPU group '${stack[stack.length - 1].id}' is missing its exact closing marker.`);
    if (draw.kind === "groupStart") {
      const endIndex = index + draw.drawCount + 1;
      if (endIndex >= draws.length) refuse(`GPU group '${draw.id}' exceeds the frame draw list.`);
      groupCount += 1; if (groupCount > GPU_MAX_GROUPS) refuse(`GPU frame exceeds ${GPU_MAX_GROUPS} isolated groups.`);
      stack.push({ id: draw.id, endIndex }); maxDepth = Math.max(maxDepth, stack.length);
      if (maxDepth > GPU_MAX_GROUP_DEPTH) refuse(`GPU group nesting exceeds depth ${GPU_MAX_GROUP_DEPTH}.`);
      continue;
    }
    if (draw.kind === "effectModule") { const open = stack[stack.length - 1], close = draws[index + 1]; if (stack.length !== 1 || !open || open.id !== draw.scopeGroupDrawId || close?.kind !== "groupEnd" || close.groupId !== open.id) refuse(`GPU effect module '${draw.id}' must be the final direct draw of its non-nested scoped isolated group.`); continue; }
    if (draw.kind !== "groupEnd") continue;
    const open = stack.pop();
    if (!open || open.endIndex !== index || open.id !== draw.groupId) refuse(`GPU group '${draw.groupId}' does not close its exact opener.`);
  }
  if (stack.length) refuse(`GPU group '${stack[stack.length - 1].id}' is missing its exact closing marker.`);
  return { groupCount, maxDepth };
}

function integer(value: unknown, minimum: number, maximum: number, name: string, refuse: (message: string) => never): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) refuse(`${name} must be an integer in ${minimum}..${maximum}.`);
  return value as number;
}
function finite(value: unknown, name: string, refuse: (message: string) => never): number {
  if (typeof value !== "number" || !Number.isFinite(value)) refuse(`${name} must be finite.`);
  return value as number;
}
