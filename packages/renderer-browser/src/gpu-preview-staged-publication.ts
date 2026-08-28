import type { DerivedOutputPublication, MotionPackage } from "@shellx-motion/core";
import { stageGpuPreviewOutput, type GpuPreviewStagedOutput } from "./gpu-preview-output";
import { gpuPreviewPackageSnapshotFreshness, type GpuPreviewPackageSnapshot } from "./gpu-preview-package-snapshot";

export type GpuPreviewStagedPublicationResult =
  | { ok: true; staged: GpuPreviewStagedOutput }
  | { ok: false; error: { code: "gpu_cancelled" | "gpu_execution_refused" | "gpu_resource_refused"; message: string } };

interface GpuPreviewStagedPublicationInput {
  pkg: MotionPackage;
  snapshot: GpuPreviewPackageSnapshot;
  freshness?: () => ReturnType<typeof gpuPreviewPackageSnapshotFreshness>;
  outputPath: string;
  externallyCancelled(): boolean;
  sessionCancelled(): boolean;
  privateOutputPublication?: DerivedOutputPublication;
}

/** Stages only a fresh, uncancelled PNG; receipt assembly owns the later irreversible commit. */
export async function stageGpuPreviewFrame(input: GpuPreviewStagedPublicationInput & { png: Buffer }): Promise<GpuPreviewStagedPublicationResult> {
  const precommit = (includeSession: boolean): Exclude<GpuPreviewStagedPublicationResult, { ok: true }> | undefined => {
    const freshness = input.freshness?.() ?? gpuPreviewPackageSnapshotFreshness(input.pkg, input.snapshot);
    if (!freshness.ok) return { ok: false, error: { code: "gpu_resource_refused", message: freshness.message } };
    if (input.externallyCancelled() || (includeSession && input.sessionCancelled())) {
      return { ok: false, error: { code: "gpu_cancelled", message: "The GPU preview request was cancelled before irreversible output publication." } };
    }
    return undefined;
  };
  const beforeStage = precommit(true); if (beforeStage) return beforeStage;
  const staged = await stageGpuPreviewOutput(input.outputPath, input.png, input.privateOutputPublication);
  const abort = async (result: GpuPreviewStagedPublicationResult) => { await staged.abort().catch(() => undefined); return result; };
  const afterStage = precommit(true); if (afterStage) return await abort(afterStage);
  return { ok: true, staged };
}

/** The terminal commit is deliberately separate so a complete verified receipt can exist first. */
export async function publishStagedGpuPreviewFrame(input: GpuPreviewStagedPublicationInput & { staged: GpuPreviewStagedOutput; allowSessionCancellation: boolean }): Promise<GpuPreviewStagedPublicationResult> {
  const precommit = (): Exclude<GpuPreviewStagedPublicationResult, { ok: true }> | undefined => {
    const freshness = input.freshness?.() ?? gpuPreviewPackageSnapshotFreshness(input.pkg, input.snapshot);
    if (!freshness.ok) return { ok: false, error: { code: "gpu_resource_refused", message: freshness.message } };
    if (input.externallyCancelled() || (!input.allowSessionCancellation && input.sessionCancelled())) {
      return { ok: false, error: { code: "gpu_cancelled", message: "The GPU preview request was cancelled before irreversible output publication." } };
    }
    return undefined;
  };
  const abort = async (result: GpuPreviewStagedPublicationResult) => { await input.staged.abort().catch(() => undefined); return result; };
  const beforePublish = precommit(); if (beforePublish) return await abort(beforePublish);
  try { await input.staged.publish(); return { ok: true, staged: input.staged }; }
  catch (error) { await input.staged.abort().catch(() => undefined); throw error; }
}
