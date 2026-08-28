import {
  GPU_EFFECT_MODULE_UNIFORM_BYTES,
  MOTION_AFTERIMAGE_STACK_INTRINSIC,
  MOTION_AFTERIMAGE_STACK_PARAMETER_SCHEMA,
  GPU_EFFECT_MODULE_RENDERER_ABI,
  gpuEffectModuleBindingProblem,
  type GpuEffectModuleBinding,
  type GpuEffectModuleEcho
} from "@shellx-motion/core";
import { MAX_EFFECT_MODULE_MANIFEST_BYTES, safeEffectModuleId } from "../effect-module-manifest";
import {
  GPU_PAGE_AFTERIMAGE_STACK_PIPELINE_IMPLEMENTATION_SHA256,
  GPU_PAGE_AFTERIMAGE_STACK_RESOURCE_CEILING_SHA256
} from "../gpu-page-afterimage-stack-contract";

/**
 * Browser-owned transport for the fixed afterimage intrinsic. Core will map
 * its typed draw into this closed shape; this is deliberately not a general
 * effect-module or shader descriptor.
 */
export const GPU_PAGE_AFTERIMAGE_STACK_SCHEMA = "shellx-motion/gpu-page-afterimage-stack@1" as const;
export const GPU_PAGE_AFTERIMAGE_STACK_INTRINSIC = MOTION_AFTERIMAGE_STACK_INTRINSIC;
export const GPU_PAGE_AFTERIMAGE_STACK_RENDERER_ABI = GPU_EFFECT_MODULE_RENDERER_ABI;
export const GPU_PAGE_AFTERIMAGE_STACK_PARAMETER_SCHEMA = MOTION_AFTERIMAGE_STACK_PARAMETER_SCHEMA;
export const GPU_PAGE_AFTERIMAGE_STACK_UNIFORM_BYTES = GPU_EFFECT_MODULE_UNIFORM_BYTES;

const MAX_DIMENSION = 4_096;
const MAX_PIXELS = 16_777_216;

export type GpuPageAfterimageStackEcho = GpuEffectModuleEcho;

export interface GpuPageAfterimageStackDescriptor extends GpuEffectModuleBinding {
  readonly schema: typeof GPU_PAGE_AFTERIMAGE_STACK_SCHEMA;
  readonly width: number;
  readonly height: number;
}

/**
 * Re-admits Core's fixed intrinsic payload before it crosses into the page.
 * It deliberately returns a fresh frozen value so callers cannot alter a
 * validated descriptor before serializing it into Chromium.
 */
export function admitGpuPageAfterimageStackDescriptor(value: unknown): GpuPageAfterimageStackDescriptor | null {
  if (!recordWithExactKeys(value, ["schema", "layerId", "drawId", "scopeGroupId", "scopeGroupDrawId", "moduleId", "version", "manifestSha256", "manifestByteLength", "registryEntrySha256", "installationProvenanceSha256", "pipelineImplementationSha256", "resourceCeilingSha256", "intrinsic", "rendererAbi", "parameterSchema", "referenceFingerprint", "width", "height", "echoes", "amountQ16", "uniformBytes", "textureLoadCount", "passCount", "retainedTextureCount", "descriptorFingerprint", "bindingFingerprint"])) return null;
  const width = readInteger(value.width, 1, MAX_DIMENSION), height = readInteger(value.height, 1, MAX_DIMENSION);
  const { schema, width: _width, height: _height, ...binding } = value;
  if (
    schema !== GPU_PAGE_AFTERIMAGE_STACK_SCHEMA ||
    width === null ||
    height === null ||
    width * height > MAX_PIXELS ||
    gpuEffectModuleBindingProblem(binding) !== null
  ) return null;
  const coreBinding = binding as unknown as GpuEffectModuleBinding;
  if (
    !safeEffectModuleId(coreBinding.moduleId) ||
    coreBinding.manifestByteLength > MAX_EFFECT_MODULE_MANIFEST_BYTES ||
    coreBinding.pipelineImplementationSha256 !== GPU_PAGE_AFTERIMAGE_STACK_PIPELINE_IMPLEMENTATION_SHA256 ||
    coreBinding.resourceCeilingSha256 !== GPU_PAGE_AFTERIMAGE_STACK_RESOURCE_CEILING_SHA256
  ) return null;
  const echoes: GpuPageAfterimageStackEcho[] = [];
  for (const rawEcho of coreBinding.echoes) {
    echoes.push(Object.freeze({ dxPx: rawEcho.dxPx, dyPx: rawEcho.dyPx, rgba8: Object.freeze([rawEcho.rgba8[0], rawEcho.rgba8[1], rawEcho.rgba8[2], rawEcho.rgba8[3]]) as GpuPageAfterimageStackEcho["rgba8"], opacityQ16: rawEcho.opacityQ16 }));
  }
  return Object.freeze({ ...coreBinding, schema: GPU_PAGE_AFTERIMAGE_STACK_SCHEMA, width, height, echoes: Object.freeze(echoes) });
}

/**
 * WGSL layout (160 bytes): u32 dimensions/count (16), four vec4<i32>
 * offset/opacity records (64), four vec4<f32> colours (64), and Q16 amount
 * normalized in the final vec4<f32> (16).
 */
export function packGpuPageAfterimageStackUniform(value: GpuPageAfterimageStackDescriptor): ArrayBuffer {
  const descriptor = admitGpuPageAfterimageStackDescriptor(value);
  if (!descriptor) throw new Error("GPU afterimage stack requires an admitted fixed descriptor.");
  const bytes = new ArrayBuffer(GPU_PAGE_AFTERIMAGE_STACK_UNIFORM_BYTES);
  const words = new Uint32Array(bytes, 0, 4);
  words.set([descriptor.width, descriptor.height, descriptor.echoes.length, 0]);
  const offsets = new Int32Array(bytes, 16, 16);
  const colors = new Float32Array(bytes, 80, 16);
  for (let index = 0; index < 4; index += 1) {
    const echo = descriptor.echoes[index];
    if (!echo) continue;
    offsets.set([echo.dxPx, echo.dyPx, echo.opacityQ16, 0], index * 4);
    colors.set([echo.rgba8[0] / 255, echo.rgba8[1] / 255, echo.rgba8[2] / 255, echo.rgba8[3] / 255], index * 4);
  }
  new Float32Array(bytes, 144, 4).set([descriptor.amountQ16 / 65_535, 0, 0, 0]);
  return bytes;
}

function recordWithExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function readInteger(value: unknown, minimum: number, maximum: number): number | null {
  return integer(value, minimum, maximum) ? value : null;
}
