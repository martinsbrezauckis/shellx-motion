import type { MotionPackage } from "@shellx-motion/core";
import type { GpuPreviewFrameOptions, GpuPreviewResult, GpuPreviewSession, GpuPreviewSessionOptions } from "./gpu-points-preview";
import {
  assertNoStructuralPrivatePublication,
  resolveRendererPrivateOutputPublication,
  withRendererPrivateOutputPublication
} from "./private-output-publication";

/** One-frame caller contract; the reusable session seam remains renderer-owned and host-owned. */
export interface GpuPreviewOneShotOptions extends GpuPreviewFrameOptions {
  sessionOptions?: GpuPreviewSessionOptions;
}

/** Owns the terminal close and binds its exact cleanup evidence only to a successful receipt. */
export async function renderGpuPreviewOneShot(
  pkg: MotionPackage,
  options: GpuPreviewOneShotOptions,
  createSession: (pkg: MotionPackage, options?: GpuPreviewSessionOptions) => GpuPreviewSession,
): Promise<GpuPreviewResult> {
  try {
    assertNoStructuralPrivatePublication(options);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "gpu_private_output_publication_refused",
        message: error instanceof Error ? error.message : "GPU private output publication is not renderer-minted."
      }
    };
  }
  const privateOutputPublication = resolveRendererPrivateOutputPublication(options);
  const { sessionOptions, ...publicFrameOptions } = options;
  const frameOptions = privateOutputPublication
    ? withRendererPrivateOutputPublication(publicFrameOptions, privateOutputPublication)
    : publicFrameOptions;
  const session = createSession(pkg, sessionOptions);
  let result: GpuPreviewResult | undefined;
  try {
    result = await session.renderFrame(frameOptions);
  } finally {
    try {
      await session.close();
    } catch (error) {
      // A staged one-shot has already aborted its private file on this path. Do not leak a
      // successful result if a legacy/custom session reports cleanup failure only at close.
      if (!result?.ok) return result ?? { ok: false, error: { code: "gpu_execution_refused", message: error instanceof Error ? error.message : "GPU preview cleanup failed." } };
      return { ok: false, error: { code: "gpu_execution_refused", message: error instanceof Error ? error.message : "GPU preview cleanup failed." } };
    }
  }
  return result!;
}
