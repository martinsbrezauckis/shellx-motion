import { createHash } from "node:crypto";
import {
  canonicalJson,
  compareCodeUnits,
  type GpuFrameBudget,
  type MotionDocument
} from "@shellx-motion/core";

const SHA256 = /^[a-f0-9]{64}$/;
const CATALOG_ID = /^[a-z][a-z0-9.-]{0,63}$/;
const INPUT_KEY = /^[A-Za-z0-9._/@:+-]{1,512}$/;
const MAX_PIPELINES = 64;
const MAX_INPUT_HASHES = 4_128;
const MAX_CANONICAL_FRAMES = 216_000;

export const GPU_PIPELINE_CATALOG_SCHEMA = "shellx-motion/gpu-pipeline-catalog@1" as const;
export const GPU_STATIC_SCENE_FINGERPRINT_SCHEMA = "shellx-motion/gpu-static-scene-fingerprint@1" as const;
export const GPU_RESOURCE_BUDGET_EVIDENCE_SCHEMA = "shellx-motion/gpu-resource-budget-evidence@1" as const;

export interface GpuPipelineCatalogEvidence {
  schema: typeof GPU_PIPELINE_CATALOG_SCHEMA;
  entries: ReadonlyArray<{ id: string; implementationSha256: string }>;
  sha256: string;
}

export interface GpuStaticSceneFingerprintEvidence {
  schema: typeof GPU_STATIC_SCENE_FINGERPRINT_SCHEMA;
  pipelineCatalogSha256: string;
  inputHashesSha256: string;
  sha256: string;
}

export interface GpuResourceBudgetEvidence {
  schema: typeof GPU_RESOURCE_BUDGET_EVIDENCE_SCHEMA;
  expectedFrames: number;
  observedFrames: number;
  maxima: Readonly<GpuFrameBudget>;
  sha256: string;
}

const BUDGET_FIELDS = [
  "rectangleCount", "pointCount", "computeParticleFieldCount", "computeParticleCount", "triangleVertexCount", "imageCount", "chromaKeyCount", "chromaMatteCleanupCount", "chromaMatteCleanupPassCount", "textCount",
  "textUtf8Bytes", "textSurfacePixels", "scene3dCount", "scene3dObjectCount",
  "scene3dVertexCount", "scene3dIndexCount", "environmentCount", "materialCount",
  "gradientStopCount", "pointBufferBytes", "computeParticleBufferBytes", "computeParticleComputeDispatchCount", "computeParticleRasterPassCount", "triangleBufferBytes", "imageVertexBufferBytes", "chromaKeyUniformBytes", "chromaMatteCleanupUniformBytes",
  "textVertexBufferBytes", "scene3dVertexBufferBytes", "scene3dIndexBufferBytes",
  "scene3dUniformBytes", "environmentUniformBytes", "materialUniformBytes",
  "gradientUniformBytes", "styledRectangleUniformBytes", "blendModeCount", "colorEffectCount",
  "blurEffectCount", "glowEffectCount", "maskCount", "blurPassCount", "adjustmentCount",
  "motionBlurGroupCount", "motionBlurSampleCount", "groupCount", "groupMaxDepth",
  "compositeCount", "compositeUniformBytes", "blurUniformBytes", "glowUniformBytes",
  "maskUniformBytes", "adjustmentUniformBytes", "chromaMatteCleanupIntermediateTextureBytes", "compositeIntermediateTextureBytes",
  "estimatedPlanBytes"
] as const satisfies readonly (keyof GpuFrameBudget)[];
const EFFECT_MODULE_BUDGET_FIELDS = ["effectModuleCount", "effectModuleUniformBytes", "effectModuleTextureLoadCount", "effectModulePassCount"] as const satisfies readonly (keyof GpuFrameBudget)[];
const ADMITTED_BUDGET_FIELDS = [...BUDGET_FIELDS, ...EFFECT_MODULE_BUDGET_FIELDS] as const;

/** Fingerprint the exact JavaScript functions serialized into the GPU page session. */
export function fingerprintGpuPipelineCatalog(
  implementations: ReadonlyArray<{ id: string; implementation: string | ((...args: never[]) => unknown) }>
): GpuPipelineCatalogEvidence {
  if (implementations.length < 1 || implementations.length > MAX_PIPELINES) {
    throw new Error(`GPU pipeline catalog must contain 1..${MAX_PIPELINES} implementations.`);
  }
  const seen = new Set<string>();
  const entries = implementations.map(({ id, implementation }) => {
    if (!CATALOG_ID.test(id) || seen.has(id)
      || (typeof implementation !== "function" && (typeof implementation !== "string" || implementation.length < 1 || implementation.length > 65_536))) {
      throw new Error("GPU pipeline catalog identifiers and implementations must be unique and bounded.");
    }
    seen.add(id);
    return { id, implementationSha256: sha256(String(implementation)) };
  }).sort((left, right) => compareCodeUnits(left.id, right.id));
  return Object.freeze({
    schema: GPU_PIPELINE_CATALOG_SCHEMA,
    entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
    sha256: sha256(canonicalJson({ schema: GPU_PIPELINE_CATALOG_SCHEMA, entries }))
  });
}

/** Bind the immutable document, exact admitted input bytes and executing pipeline catalog. */
export function fingerprintGpuStaticScene(input: {
  motion: MotionDocument;
  loadedInputHashes: Readonly<Record<string, string>>;
  resourceInputHashes: Readonly<Record<string, string>>;
  pipelineCatalogSha256: string;
}): GpuStaticSceneFingerprintEvidence {
  if (!SHA256.test(input.pipelineCatalogSha256)) throw new Error("GPU pipeline catalog hash is invalid.");
  const hashes = mergeInputHashes(input.loadedInputHashes, input.resourceInputHashes);
  const inputHashesSha256 = sha256(canonicalJson(hashes));
  const payload = {
    schema: GPU_STATIC_SCENE_FINGERPRINT_SCHEMA,
    motion: input.motion,
    pipelineCatalogSha256: input.pipelineCatalogSha256,
    inputHashesSha256
  };
  return Object.freeze({
    schema: GPU_STATIC_SCENE_FINGERPRINT_SCHEMA,
    pipelineCatalogSha256: input.pipelineCatalogSha256,
    inputHashesSha256,
    sha256: sha256(canonicalJson(payload))
  });
}

/** Accumulate the maximum admitted resource decision over one canonical frame sequence. */
export function createGpuResourceBudgetAccumulator(expectedFrames: number): {
  observe(budget: GpuFrameBudget): void;
  finish(): GpuResourceBudgetEvidence;
} {
  if (!Number.isSafeInteger(expectedFrames) || expectedFrames < 1 || expectedFrames > MAX_CANONICAL_FRAMES) {
    throw new Error(`GPU provenance supports 1..${MAX_CANONICAL_FRAMES} canonical frames.`);
  }
  const maxima = Object.fromEntries(BUDGET_FIELDS.map((field) => [field, 0])) as unknown as GpuFrameBudget;
  let observedFrames = 0;
  let finished = false;
  let sawEffectModuleBudget = false;
  return {
    observe(budget) {
      if (finished || observedFrames >= expectedFrames) throw new Error("GPU budget evidence received an unexpected frame.");
      const record = budget as unknown as Record<string, unknown>;
      const effectFieldCount = EFFECT_MODULE_BUDGET_FIELDS.filter((field) => field in record).length;
      if (
        (effectFieldCount !== 0 && effectFieldCount !== EFFECT_MODULE_BUDGET_FIELDS.length) ||
        Object.keys(record).length !== BUDGET_FIELDS.length + effectFieldCount ||
        Object.keys(record).some((key) => !ADMITTED_BUDGET_FIELDS.includes(key as never))
      ) {
        throw new Error("GPU frame budget shape is invalid.");
      }
      for (const field of BUDGET_FIELDS) {
        const value = budget[field];
        if (!Number.isSafeInteger(value) || value < 0) throw new Error(`GPU frame budget ${field} is invalid.`);
        maxima[field] = Math.max(maxima[field], value);
      }
      if (effectFieldCount) {
        const effectModuleCount = budget.effectModuleCount;
        const effectModuleUniformBytes = budget.effectModuleUniformBytes;
        const effectModuleTextureLoadCount = budget.effectModuleTextureLoadCount;
        const effectModulePassCount = budget.effectModulePassCount;
        if (effectModuleCount !== 1 || effectModuleUniformBytes !== 160 || typeof effectModuleTextureLoadCount !== "number" || !Number.isSafeInteger(effectModuleTextureLoadCount) || effectModuleTextureLoadCount < 2 || effectModuleTextureLoadCount > 5 || effectModulePassCount !== 1) {
          throw new Error("GPU effect-module budget is invalid.");
        }
        maxima.effectModuleCount = Math.max(maxima.effectModuleCount ?? 0, effectModuleCount);
        maxima.effectModuleUniformBytes = Math.max(maxima.effectModuleUniformBytes ?? 0, effectModuleUniformBytes);
        maxima.effectModuleTextureLoadCount = Math.max(maxima.effectModuleTextureLoadCount ?? 0, effectModuleTextureLoadCount);
        maxima.effectModulePassCount = Math.max(maxima.effectModulePassCount ?? 0, effectModulePassCount);
        sawEffectModuleBudget = true;
      }
      observedFrames += 1;
    },
    finish() {
      if (finished) throw new Error("GPU budget evidence was already finalized.");
      finished = true;
      if (observedFrames !== expectedFrames) throw new Error("GPU budget evidence does not cover the canonical frame sequence.");
      const frozenMaxima = Object.freeze({ ...maxima });
      const payload = { schema: GPU_RESOURCE_BUDGET_EVIDENCE_SCHEMA, expectedFrames, observedFrames, maxima: frozenMaxima };
      return Object.freeze({ ...payload, sha256: sha256(canonicalJson(payload)) });
    }
  };
}

function mergeInputHashes(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
  const entries = [...Object.entries(left), ...Object.entries(right)];
  if (entries.length > MAX_INPUT_HASHES) throw new Error(`GPU provenance supports at most ${MAX_INPUT_HASHES} input hashes.`);
  const merged = new Map<string, string>();
  for (const [key, value] of entries) {
    if (!INPUT_KEY.test(key) || !SHA256.test(value)) throw new Error("GPU provenance input hash evidence is invalid.");
    const previous = merged.get(key);
    if (previous && previous !== value) throw new Error(`GPU provenance input hash '${key}' conflicts.`);
    merged.set(key, value);
  }
  return Object.freeze(Object.fromEntries([...merged.entries()].sort(([leftKey], [rightKey]) => compareCodeUnits(leftKey, rightKey))));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
