export const GPU_MATERIAL_PRESETS = ["plasma", "hologram", "energy", "noise"] as const;
export type MotionGpuMaterialPreset = typeof GPU_MATERIAL_PRESETS[number];

export interface MotionGpuMaterial {
  preset: MotionGpuMaterialPreset;
  /** Base, secondary and accent colors consumed by Motion-owned WGSL. */
  colors: [string, string, string];
}

export const GPU_MATERIAL_UNIFORM_NAMES = [
  "u_speed", "u_scale", "u_intensity", "u_detail",
  "u_warp", "u_glow", "u_scanline", "u_phase"
] as const;
export type MotionGpuMaterialUniform = typeof GPU_MATERIAL_UNIFORM_NAMES[number];

const RULES: Record<MotionGpuMaterialUniform, readonly [minimum: number, maximum: number, fallback: number]> = {
  u_speed: [-4, 4, 1],
  u_scale: [0.1, 20, 4],
  u_intensity: [0, 2, 1],
  u_detail: [1, 4, 3],
  u_warp: [0, 2, 0.5],
  u_glow: [0, 2, 1],
  u_scanline: [0, 1, 0.5],
  u_phase: [-1_000, 1_000, 0]
};

export function isMotionGpuMaterialPreset(value: unknown): value is MotionGpuMaterialPreset {
  return typeof value === "string" && GPU_MATERIAL_PRESETS.includes(value as MotionGpuMaterialPreset);
}

export function isMotionGpuMaterialUniform(value: string): value is MotionGpuMaterialUniform {
  return GPU_MATERIAL_UNIFORM_NAMES.includes(value as MotionGpuMaterialUniform);
}

export function gpuMaterialUniformRule(name: MotionGpuMaterialUniform): readonly [number, number, number] {
  return RULES[name];
}

/** Converts authored named uniforms into the fixed eight-float GPU ABI. */
export function gpuMaterialUniformValues(uniforms: Readonly<Record<string, number>> | undefined): [number, number, number, number, number, number, number, number] | null {
  const values: number[] = [];
  for (const name of GPU_MATERIAL_UNIFORM_NAMES) {
    const [minimum, maximum, fallback] = RULES[name];
    const value = uniforms?.[name] ?? fallback;
    if (!Number.isFinite(value) || value < minimum || value > maximum) return null;
    values.push(value);
  }
  if (uniforms && Object.keys(uniforms).some((name) => !isMotionGpuMaterialUniform(name))) return null;
  return values as [number, number, number, number, number, number, number, number];
}
