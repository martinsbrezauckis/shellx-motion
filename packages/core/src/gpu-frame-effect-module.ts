import { gpuEffectModuleBindingProblem, type GpuEffectModuleBinding } from "./effect-module";
import type { GpuEffectModuleIntent } from "./gpu-frame-intent-types";

/** Re-admits a closed Core binding before fixed renderer code can select its one intrinsic. */
export function readGpuEffectModuleIntent(value: Record<string, unknown>, id: string, refuse: (message: string) => never): GpuEffectModuleIntent {
  const { kind: _kind, id: _id, blendMode, effects, mask, ...binding } = value;
  const problem = gpuEffectModuleBindingProblem(binding);
  if (problem || binding.drawId !== id || blendMode !== "normal" || effects !== null || mask !== undefined) refuse(`GPU effect module ${id} ${problem ?? "does not match its fixed terminal shape"}.`);
  return { kind: "effectModule", id, blendMode: "normal", effects: null, ...(binding as unknown as GpuEffectModuleBinding) };
}
