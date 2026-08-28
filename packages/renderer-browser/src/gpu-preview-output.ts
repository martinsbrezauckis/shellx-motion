import { realpath, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { acquireDerivedOutputPublication, canonicalJsonSha256, createPreviewReceipt, OutputPathTopology, type DerivedOutputPublication, type GpuSceneBehaviorFramePlan, type GpuSceneBehaviorStaticPlan, type GpuSceneRelationsFramePlan, type GpuSceneRelationsStaticPlan, type LocalMotionJobEvidence, type MotionPackage, type OperationReceipt } from "@shellx-motion/core";
import { isCoreDerivedOutputPublication } from "@shellx-motion/core/internal/derived-output-publication-authenticity";
import { GPU_SCENE3D_ANIMATION_PREVIEW_LIMITS, type GpuScene3DAnimationFramePlan, type GpuScene3DAnimationPreviewLimits, type GpuScene3DAnimationStaticPlan } from "@shellx-motion/core/internal/scene3d-animation-gpu-preview";
import type { GpuRuntimeEvidence } from "./gpu-runtime-types";
import type { PreviewVideoReceiptEvidence } from "./gpu-preview-video-orchestration";
import type { GpuPreviewEffectModuleReceiptEvidence } from "./gpu-effect-module-use-authority";

export const GPU_RELATIONS_PREVIEW_RECEIPT_SCHEMA = "shellx-motion/gpu-relations-preview-receipt@1" as const;
export const GPU_SCENE3D_ANIMATION_PREVIEW_RECEIPT_SCHEMA = "shellx-motion/gpu-scene3d-animation-preview-receipt@1" as const;

/** Optional relation-only output namespace; absence preserves the legacy no-relation receipt. */
export interface GpuRelationsPreviewReceiptEvidence {
  schema: typeof GPU_RELATIONS_PREVIEW_RECEIPT_SCHEMA;
  staticWrapperFingerprint: string;
  sourceStaticFingerprint: string;
  sourceSha256: string;
  atUs: number;
  frameWrapperFingerprint: string;
  sourceFrameFingerprint: string;
  evaluatedLayerFingerprint: string;
  fingerprint: string;
}

/** Exact O6 wrapper facts only; it carries no hardware, installed, or pixel-quality claim. */
export interface GpuScene3DAnimationPreviewReceiptEvidence {
  schema: typeof GPU_SCENE3D_ANIMATION_PREVIEW_RECEIPT_SCHEMA;
  staticWrapperFingerprint: string;
  sourceStaticFingerprint: string;
  sourceSha256: string;
  atUs: number;
  frameWrapperFingerprint: string;
  sourceFrameFingerprint: string;
  targetLayerIds: readonly string[];
  limits: GpuScene3DAnimationPreviewLimits;
  fingerprint: string;
}

/** Derives receipt-visible facts only from the exact Core wrappers selected for this rendered frame. */
export function gpuRelationsPreviewReceiptEvidence(staticPlan: GpuSceneRelationsStaticPlan, framePlan: GpuSceneRelationsFramePlan): GpuRelationsPreviewReceiptEvidence {
  if (staticPlan.fingerprint !== framePlan.staticFingerprint
    || staticPlan.relationStaticFingerprint !== framePlan.relationFramePlan.staticFingerprint
    || framePlan.relationFramePlan.fingerprint !== framePlan.relationFrameFingerprint
    || typeof staticPlan.relationStaticPlan.relationSourceSha256 !== "string") {
    throw new Error("GPU relation receipt evidence does not match the Core-issued wrappers rendered for this frame.");
  }
  const payload = {
    schema: GPU_RELATIONS_PREVIEW_RECEIPT_SCHEMA,
    staticWrapperFingerprint: staticPlan.fingerprint,
    sourceStaticFingerprint: staticPlan.relationStaticFingerprint,
    sourceSha256: staticPlan.relationStaticPlan.relationSourceSha256,
    atUs: framePlan.atUs,
    frameWrapperFingerprint: framePlan.fingerprint,
    sourceFrameFingerprint: framePlan.relationFrameFingerprint,
    evaluatedLayerFingerprint: framePlan.evaluatedLayerFingerprint,
  };
  return Object.freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}

/** Derives receipt evidence only from the Core-issued O6 static/frame wrappers that rendered. */
export function gpuScene3dAnimationPreviewReceiptEvidence(staticPlan: GpuScene3DAnimationStaticPlan, framePlan: GpuScene3DAnimationFramePlan): GpuScene3DAnimationPreviewReceiptEvidence {
  if (staticPlan.fingerprint !== framePlan.staticFingerprint
    || staticPlan.animationStaticFingerprint !== framePlan.animationFramePlan.staticFingerprint
    || framePlan.animationFramePlan.fingerprint !== framePlan.animationFrameFingerprint
    || framePlan.animationFramePlan.atUs !== framePlan.atUs
    || framePlan.animationFramePlan.staticFingerprint !== staticPlan.animationStaticPlan.fingerprint) {
    throw new Error("GPU scene3d animation receipt evidence does not match the Core-issued wrappers rendered for this frame.");
  }
  const payload = {
    schema: GPU_SCENE3D_ANIMATION_PREVIEW_RECEIPT_SCHEMA,
    staticWrapperFingerprint: staticPlan.fingerprint,
    sourceStaticFingerprint: staticPlan.animationStaticFingerprint,
    sourceSha256: staticPlan.animationStaticPlan.sourceSha256,
    atUs: framePlan.atUs,
    frameWrapperFingerprint: framePlan.fingerprint,
    sourceFrameFingerprint: framePlan.animationFrameFingerprint,
    targetLayerIds: Object.freeze([...staticPlan.targetLayerIds]),
    limits: Object.freeze({ ...staticPlan.limits }),
  };
  return Object.freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}

/** Verifies the versioned optional namespace when a receipt is read or compared in a test. */
export function verifyGpuRelationsPreviewReceiptEvidence(value: unknown): GpuRelationsPreviewReceiptEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GPU relation receipt evidence must be an object.");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ["atUs", "evaluatedLayerFingerprint", "fingerprint", "frameWrapperFingerprint", "schema", "sourceFrameFingerprint", "sourceSha256", "sourceStaticFingerprint", "staticWrapperFingerprint"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error("GPU relation receipt evidence has an invalid schema shape.");
  if (record.schema !== GPU_RELATIONS_PREVIEW_RECEIPT_SCHEMA || !Number.isSafeInteger(record.atUs) || (record.atUs as number) < 0) throw new Error("GPU relation receipt evidence has an invalid schema or playhead.");
  const hashes = ["staticWrapperFingerprint", "sourceStaticFingerprint", "sourceSha256", "frameWrapperFingerprint", "sourceFrameFingerprint", "evaluatedLayerFingerprint", "fingerprint"];
  if (hashes.some((key) => typeof record[key] !== "string" || !/^[a-f0-9]{64}$/.test(record[key] as string))) throw new Error("GPU relation receipt evidence has an invalid fingerprint.");
  const { fingerprint, ...payload } = record as unknown as GpuRelationsPreviewReceiptEvidence;
  if (canonicalJsonSha256(payload) !== fingerprint) throw new Error("GPU relation receipt evidence fingerprint does not match its payload.");
  return Object.freeze({ ...payload, fingerprint });
}

export async function resolveGpuPreviewOutputPath(packageInput: string | { manifest: Pick<MotionPackage["manifest"], "id"> }, options: { atMs?: number; outDir: string; outputPath?: string }): Promise<string> {
  const root = resolve(options.outDir);
  const packageId = typeof packageInput === "string" ? packageInput : packageInput.manifest.id;
  const generated = `${safeToken(packageId)}-gpu-${options.atMs ?? 0}.png`;
  const output = resolve(options.outputPath ?? `${root}/${generated}`);
  if (!inside(root, output)) throw new Error("GPU preview outputPath must be inside outDir.");
  const topology = await OutputPathTopology.acquire(output);
  await topology.assertCurrent();
  const canonicalRoot = await realpath(root);
  const canonicalParent = await realpath(dirname(output));
  if (!inside(canonicalRoot, canonicalParent)) throw new Error("GPU preview outputPath parent must not escape outDir through a symlink.");
  await topology.assertCurrent();
  return output;
}

export interface GpuPreviewStagedOutput {
  sha256: string;
  publish(): Promise<void>;
  abort(): Promise<void>;
}

/** Writes and verifies a private staging file; its caller owns the irreversible publish commit. */
export async function stageGpuPreviewOutput(outputPath: string, png: Buffer, privateOutputPublication?: DerivedOutputPublication): Promise<GpuPreviewStagedOutput> {
  if (privateOutputPublication) {
    if (!isCoreDerivedOutputPublication(privateOutputPublication)) {
      throw new Error("GPU private output publication requires a Core-minted publication.");
    }
    if (resolve(outputPath) !== resolve(privateOutputPublication.stagingPath)) {
      throw new Error("GPU private output publication does not match the requested staging path.");
    }
    await writeFile(privateOutputPublication.stagingPath, png);
    const evidence = await privateOutputPublication.verifyFile();
    return Object.freeze({
      sha256: evidence.sha256,
      // The CLI pair owns the irreversible public link after it has staged the matching receipt.
      publish: async () => undefined,
      abort: async () => { await privateOutputPublication.abort(); },
    });
  }
  const publication = await acquireDerivedOutputPublication({ outputPath, kind: "file" });
  try {
    await writeFile(publication.stagingPath, png);
    const evidence = await publication.verifyFile();
    return Object.freeze({
      sha256: evidence.sha256,
      publish: async () => { await publication.publishFile(evidence); },
      abort: async () => { await publication.abort(); },
    });
  } catch (error) {
    await publication.abort().catch(() => undefined);
    throw error;
  }
}

export async function publishGpuPreviewOutput(outputPath: string, png: Buffer): Promise<string> {
  const staged = await stageGpuPreviewOutput(outputPath, png);
  try {
    await staged.publish();
    return staged.sha256;
  } catch (error) {
    await staged.abort().catch(() => undefined);
    throw error;
  }
}

export async function createGpuPreviewReceipt(input: {
  packageId: string; inputHashes: Readonly<Record<string, string>>; resourceHashes: Readonly<Record<string, string>>;
  atMs: number; outputPath: string; sha256: string; width: number; height: number; planFingerprint: string;
  resources: LocalMotionJobEvidence; gpu: GpuRuntimeEvidence; videoEvidence?: PreviewVideoReceiptEvidence;
  effectModuleEvidence?: GpuPreviewEffectModuleReceiptEvidence; now?: () => string;
  sessionCleanup?: Readonly<Record<string, unknown>>;
  behaviorEvidence?: { staticPlan: GpuSceneBehaviorStaticPlan; framePlan: GpuSceneBehaviorFramePlan };
  relationEvidence?: GpuRelationsPreviewReceiptEvidence;
  scene3dAnimationEvidence?: GpuScene3DAnimationPreviewReceiptEvidence;
}): Promise<OperationReceipt> {
  const behaviorHashes: Record<string, string> = input.behaviorEvidence ? {
    "gpu-behavior-static-plan": input.behaviorEvidence.staticPlan.fingerprint,
    "gpu-behavior-source": input.behaviorEvidence.staticPlan.behaviorSourceSha256,
    "gpu-behavior-frame-plan": input.behaviorEvidence.framePlan.fingerprint
  } : {};
  const scene3dAnimationHashes: Record<string, string> = input.scene3dAnimationEvidence ? {
    "gpu-scene3d-animation-static-plan": input.scene3dAnimationEvidence.staticWrapperFingerprint,
    "gpu-scene3d-animation-source": input.scene3dAnimationEvidence.sourceSha256,
    "gpu-scene3d-animation-frame-plan": input.scene3dAnimationEvidence.frameWrapperFingerprint
  } : {};
  const receipt = createPreviewReceipt({
    id: `receipt_gpu_preview_${input.sha256.slice(0, 16)}`, packageId: input.packageId, lane: "gpu",
    inputHashes: { ...input.inputHashes, ...input.resourceHashes, "gpu-frame-plan": input.planFingerprint, ...behaviorHashes, ...scene3dAnimationHashes },
    outputFrame: { path: input.outputPath, sha256: input.sha256, width: input.width, height: input.height, atMs: input.atMs }, warnings: []
  });
  receipt.operation = "preview.gpu.frame";
  receipt.createdAt = input.now?.() ?? receipt.createdAt;
  receipt.artifacts = [{ role: "preview_frame", path: input.outputPath, status: "available", mediaType: "image/png", primary: true }];
  receipt.output = {
    ...receipt.output as Record<string, unknown>, gpu: input.gpu, resources: input.resources,
    framePlanFingerprint: input.planFingerprint, resourceInputHashes: input.resourceHashes,
    ...(input.behaviorEvidence ? { gpuBehaviors: Object.freeze({
      staticFingerprint: input.behaviorEvidence.staticPlan.fingerprint,
      baseStaticFingerprint: input.behaviorEvidence.staticPlan.baseStaticFingerprint,
      behaviorStaticFingerprint: input.behaviorEvidence.staticPlan.behaviorStaticFingerprint,
      behaviorSourceSha256: input.behaviorEvidence.staticPlan.behaviorSourceSha256,
      targetLayerIds: input.behaviorEvidence.staticPlan.targetLayerIds,
      staticBudget: input.behaviorEvidence.staticPlan.budget,
      frameFingerprint: input.behaviorEvidence.framePlan.fingerprint,
      baseFrameFingerprint: input.behaviorEvidence.framePlan.baseFrameFingerprint,
      behaviorFrameFingerprint: input.behaviorEvidence.framePlan.behaviorFrameFingerprint,
      frameBudget: input.behaviorEvidence.framePlan.budget
    }) } : {}),
    ...(input.relationEvidence ? { gpuRelations: verifyGpuRelationsPreviewReceiptEvidence(input.relationEvidence) } : {}),
    ...(input.scene3dAnimationEvidence ? { gpuScene3dAnimation: verifyGpuScene3dAnimationPreviewReceiptEvidence(input.scene3dAnimationEvidence) } : {}),
    ...(input.videoEvidence ? { gpuVideoPreview: input.videoEvidence } : {}),
    ...(input.effectModuleEvidence ? { gpuEffectModules: input.effectModuleEvidence } : {}),
    ...(input.sessionCleanup ? { sessionCleanup: input.sessionCleanup } : {})
  };
  return receipt;
}

export function verifyGpuScene3dAnimationPreviewReceiptEvidence(value: unknown): GpuScene3DAnimationPreviewReceiptEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GPU scene3d animation receipt evidence must be an object.");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ["atUs", "fingerprint", "frameWrapperFingerprint", "limits", "schema", "sourceFrameFingerprint", "sourceSha256", "sourceStaticFingerprint", "staticWrapperFingerprint", "targetLayerIds"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error("GPU scene3d animation receipt evidence has an invalid schema shape.");
  if (record.schema !== GPU_SCENE3D_ANIMATION_PREVIEW_RECEIPT_SCHEMA || !Number.isSafeInteger(record.atUs) || (record.atUs as number) < 0) throw new Error("GPU scene3d animation receipt evidence has an invalid schema or playhead.");
  const hashes = ["staticWrapperFingerprint", "sourceStaticFingerprint", "sourceSha256", "frameWrapperFingerprint", "sourceFrameFingerprint", "fingerprint"];
  if (hashes.some((key) => typeof record[key] !== "string" || !/^[a-f0-9]{64}$/.test(record[key] as string))) throw new Error("GPU scene3d animation receipt evidence has an invalid fingerprint.");
  if (!Array.isArray(record.targetLayerIds) || record.targetLayerIds.length === 0 || record.targetLayerIds.some((entry) => typeof entry !== "string")) throw new Error("GPU scene3d animation receipt evidence has invalid target layers.");
  const limits = record.limits as Record<string, unknown>;
  const limitKeys = Object.keys(GPU_SCENE3D_ANIMATION_PREVIEW_LIMITS).sort();
  if (!limits || Array.isArray(limits) || Object.keys(limits).sort().length !== limitKeys.length || Object.keys(limits).sort().some((key, index) => key !== limitKeys[index]) || limitKeys.some((key) => limits[key] !== GPU_SCENE3D_ANIMATION_PREVIEW_LIMITS[key as keyof GpuScene3DAnimationPreviewLimits])) throw new Error("GPU scene3d animation receipt evidence has invalid strict preview limits.");
  const { fingerprint, ...payload } = record as unknown as GpuScene3DAnimationPreviewReceiptEvidence;
  if (canonicalJsonSha256(payload) !== fingerprint) throw new Error("GPU scene3d animation receipt evidence fingerprint does not match its payload.");
  return Object.freeze({ ...payload, targetLayerIds: Object.freeze([...payload.targetLayerIds]), limits: Object.freeze({ ...payload.limits }), fingerprint });
}

function inside(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith("..") && !value.includes("../") && !value.includes("..\\"));
}
function safeToken(value: string): string {
  const token = basename(value).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return token || "motion";
}
