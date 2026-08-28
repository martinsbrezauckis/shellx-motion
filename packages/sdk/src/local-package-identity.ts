import { loadedPackageInputHashes, type MotionPackage } from "@shellx-motion/core";

/** Identity for the exact parsed package snapshot; never reopen source pathnames here. */
export async function localPackageIdentity(pkg: MotionPackage) {
  const loaded = loadedPackageInputHashes(pkg);
  const manifestSha256 = loaded?.["manifest.json"];
  const motionSha256 = loaded?.[pkg.manifest.motion];
  if (!manifestSha256 || !motionSha256) {
    throw new Error("SDK package identity requires loader-owned manifest and Motion hashes.");
  }
  return {
    packageId: pkg.manifest.id, motionId: pkg.motion.id, durationMs: pkg.motion.durationMs, fps: pkg.motion.fps,
    width: pkg.motion.width, height: pkg.motion.height, manifestSha256, motionSha256
  };
}
