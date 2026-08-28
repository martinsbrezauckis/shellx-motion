import type { MotionDocument, MotionPackage } from "@shellx-motion/core";
import { compileGpuScene3DAnimationStaticPlan, gpuScene3DAnimationAdmittedMotion, type GpuScene3DAnimationStaticPlan } from "@shellx-motion/core/internal/scene3d-animation-gpu-preview";
import { gpuPreviewPackageMotionData } from "./gpu-preview-package-motion-data";
import { gpuPreviewPackageSnapshotFreshness, type GpuPreviewPackageSnapshot } from "./gpu-preview-package-snapshot";

export interface GpuO6AdmittedMotionAuthority {
  motion: MotionDocument;
  staticPlan: GpuScene3DAnimationStaticPlan;
}

/** Reads the opaque Core authority only; it never returns source Motion data. */
export function gpuO6AdmittedMotionAuthority(staticPlan: GpuScene3DAnimationStaticPlan): GpuO6AdmittedMotionAuthority | undefined {
  const motion = gpuScene3DAnimationAdmittedMotion(staticPlan);
  return motion ? Object.freeze({ motion, staticPlan }) : undefined;
}

/**
 * Re-admits package Motion after an await through Core's descriptor-only boundary. A transparent
 * proxy can be materialized again, but an observed JSON change invalidates the original authority.
 */
export function refreshGpuO6AdmittedMotion(
  pkg: MotionPackage,
  staticPlan: GpuScene3DAnimationStaticPlan,
): { ok: true; motion: MotionDocument } | { ok: false; message: string } {
  const source = gpuPreviewPackageMotionData(pkg);
  if (!source) return { ok: false, message: "GPU scene3d animation preview package Motion authority changed after preflight." };
  const refreshed = compileGpuScene3DAnimationStaticPlan(source);
  if (!refreshed.ok || refreshed.plan.documentFingerprint !== staticPlan.documentFingerprint) {
    return { ok: false, message: "GPU scene3d animation preview package Motion authority is stale after an asynchronous boundary." };
  }
  const motion = gpuScene3DAnimationAdmittedMotion(refreshed.plan);
  return motion
    ? { ok: true, motion }
    : { ok: false, message: "GPU scene3d animation preview lost its re-admitted Core Motion authority." };
}

/** O6 publication freshness binds the original package manifest and a freshly admitted Motion tree. */
export function gpuO6PackageSnapshotFreshness(
  pkg: MotionPackage,
  snapshot: GpuPreviewPackageSnapshot | undefined,
  staticPlan: GpuScene3DAnimationStaticPlan,
): ReturnType<typeof gpuPreviewPackageSnapshotFreshness> {
  if (!snapshot) return { ok: false, message: "GPU preview package snapshot was not captured before freshness validation." };
  const refreshed = refreshGpuO6AdmittedMotion(pkg, staticPlan);
  return refreshed.ok
    ? gpuPreviewPackageSnapshotFreshness(pkg, snapshot, refreshed.motion)
    : { ok: false, message: refreshed.message };
}

/** Resource preparation receives a package façade that cannot route back to caller Motion data. */
export function packageWithGpuO6AdmittedMotion(pkg: MotionPackage, motion: MotionDocument): MotionPackage {
  return Object.freeze({ root: pkg.root, manifest: pkg.manifest, motion });
}
