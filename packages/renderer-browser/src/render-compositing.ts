import { compileMotionDocumentCompositing, type MotionPackage } from "@shellx-motion/core";

/** Lower a data-only compositing graph before any renderer capability or frame decision. */
export function prepareCompositingRenderPackage(pkg: MotionPackage): MotionPackage {
  if (!pkg.motion.compositing) return pkg;
  return { ...pkg, motion: compileMotionDocumentCompositing(pkg.motion) };
}
