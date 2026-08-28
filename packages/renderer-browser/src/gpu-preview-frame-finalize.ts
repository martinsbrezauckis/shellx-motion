import type { DerivedOutputPublication, LocalMotionJobEvidence, OperationReceipt } from "@shellx-motion/core";
import type { GpuScene3DAnimationFramePlan, GpuScene3DAnimationStaticPlan } from "@shellx-motion/core/internal/scene3d-animation-gpu-preview";
import { encodeGpuPng } from "./gpu-png";
import { createGpuPreviewReceipt, gpuRelationsPreviewReceiptEvidence, gpuScene3dAnimationPreviewReceiptEvidence } from "./gpu-preview-output";
import type { GpuPreviewPackageSnapshot } from "./gpu-preview-package-snapshot";
import { publishStagedGpuPreviewFrame, stageGpuPreviewFrame } from "./gpu-preview-staged-publication";
import type { GpuRuntimeEvidence } from "./gpu-runtime-types";
import type { GpuPreviewEffectModuleReceiptEvidence } from "./gpu-effect-module-use-authority";
import type { PreviewVideoReceiptEvidence } from "./gpu-preview-video-orchestration";

/** Final output/receipt join after the renderer has yielded one fully bound readback. */
export async function finalizeGpuPreviewFrame(input: {
  pkg: import("@shellx-motion/core").MotionPackage;
  snapshot: GpuPreviewPackageSnapshot;
  freshness?: () => ReturnType<typeof import("./gpu-preview-package-snapshot").gpuPreviewPackageSnapshotFreshness>;
  outputPath: string;
  rgba: Buffer;
  width: number;
  height: number;
  gpu: GpuRuntimeEvidence;
  resources: LocalMotionJobEvidence;
  resourceHashes: Readonly<Record<string, string>>;
  atMs: number;
  planFingerprint: string;
  externallyCancelled(): boolean;
  sessionCancelled(): boolean;
  finalizeCleanupBeforePublication: boolean;
  closeForPublication(): Promise<unknown>;
  now?: () => string;
  videoEvidence?: PreviewVideoReceiptEvidence;
  effectModuleEvidence?: GpuPreviewEffectModuleReceiptEvidence;
  behaviorEvidence?: { staticPlan: import("@shellx-motion/core").GpuSceneBehaviorStaticPlan; framePlan: import("@shellx-motion/core").GpuSceneBehaviorFramePlan };
  relationEvidence?: { staticPlan: import("@shellx-motion/core").GpuSceneRelationsStaticPlan; framePlan: import("@shellx-motion/core").GpuSceneRelationsFramePlan };
  scene3dAnimationEvidence?: { staticPlan: GpuScene3DAnimationStaticPlan; framePlan: GpuScene3DAnimationFramePlan };
  privateOutputPublication?: DerivedOutputPublication;
}): Promise<{ ok: true; sha256: string; receipt: OperationReceipt } | { ok: false; error: { code: string; message: string } }> {
  const png = encodeGpuPng({ rgba: input.rgba, width: input.width, height: input.height });
  const staged = await stageGpuPreviewFrame({
    pkg: input.pkg, snapshot: input.snapshot, outputPath: input.outputPath, png,
    ...(input.freshness ? { freshness: input.freshness } : {}),
    externallyCancelled: input.externallyCancelled, sessionCancelled: input.sessionCancelled,
    ...(input.privateOutputPublication ? { privateOutputPublication: input.privateOutputPublication } : {}),
  });
  if (!staged.ok) return staged;
  const abort = async (code: string, error: unknown) => {
    await staged.staged.abort().catch(() => undefined);
    return { ok: false as const, error: { code, message: error instanceof Error ? error.message : "GPU preview receipt preparation failed before output publication." } };
  };
  let cleanup: Readonly<Record<string, unknown>> | undefined;
  if (input.finalizeCleanupBeforePublication) {
    try { cleanup = verifiedGpuPreviewCleanup(await input.closeForPublication()); }
    catch (error) { return await abort("gpu_execution_refused", error); }
  }
  let receipt: OperationReceipt;
  try {
    receipt = await createGpuPreviewReceipt({
      packageId: input.snapshot.packageId, inputHashes: input.snapshot.inputHashes, resourceHashes: input.resourceHashes,
      atMs: input.atMs, outputPath: input.outputPath, sha256: staged.staged.sha256, width: input.width, height: input.height,
      planFingerprint: input.planFingerprint, resources: input.resources, gpu: input.gpu, now: input.now,
      ...(cleanup ? { sessionCleanup: cleanup } : {}),
      ...(input.videoEvidence ? { videoEvidence: input.videoEvidence } : {}),
      ...(input.effectModuleEvidence ? { effectModuleEvidence: input.effectModuleEvidence } : {}),
      ...(input.behaviorEvidence ? { behaviorEvidence: input.behaviorEvidence } : {}),
      ...(input.relationEvidence ? { relationEvidence: gpuRelationsPreviewReceiptEvidence(input.relationEvidence.staticPlan, input.relationEvidence.framePlan) } : {}),
      ...(input.scene3dAnimationEvidence ? { scene3dAnimationEvidence: gpuScene3dAnimationPreviewReceiptEvidence(input.scene3dAnimationEvidence.staticPlan, input.scene3dAnimationEvidence.framePlan) } : {}),
    });
    verifyGpuPreviewReceipt(receipt, staged.staged.sha256, cleanup);
  } catch (error) { return await abort("gpu_execution_refused", error); }
  const published = await publishStagedGpuPreviewFrame({
    pkg: input.pkg, snapshot: input.snapshot, outputPath: input.outputPath, staged: staged.staged,
    ...(input.freshness ? { freshness: input.freshness } : {}),
    externallyCancelled: input.externallyCancelled, sessionCancelled: input.sessionCancelled, allowSessionCancellation: input.finalizeCleanupBeforePublication,
  });
  if (!published.ok) return published;
  return { ok: true, sha256: staged.staged.sha256, receipt };
}

function verifiedGpuPreviewCleanup(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GPU preview cleanup evidence must be an object.");
  const record = value as Record<string, unknown>;
  if (record.closed !== true || !("runtimeResources" in record) || !("provider" in record)) throw new Error("GPU preview cleanup evidence is incomplete.");
  return Object.freeze({ ...record });
}

function verifyGpuPreviewReceipt(receipt: OperationReceipt, sha256: string, cleanup: unknown): void {
  const output = receipt.output as Record<string, unknown> | null;
  if (receipt.operation !== "preview.gpu.frame" || receipt.status !== "passed" || output?.sha256 !== sha256) throw new Error("GPU preview receipt is incomplete before output publication.");
  if (cleanup !== undefined && output?.sessionCleanup !== cleanup) throw new Error("GPU preview receipt does not bind terminal cleanup evidence.");
}
