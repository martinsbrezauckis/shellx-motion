import type { GpuEffectModuleBinding } from "./effect-module";
import type { GpuEffectModuleIntent } from "./gpu-frame-intent-types";

/** Lowers only the already-resolved fixed intrinsic; package data never carries shader code. */
export function compileGpuSceneEffectModule(binding: GpuEffectModuleBinding): GpuEffectModuleIntent { return { kind: "effectModule", id: binding.drawId, blendMode: "normal", effects: null, ...binding }; }
