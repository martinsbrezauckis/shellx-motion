import type { MotionPackage } from "@shellx-motion/core";

/** Reads only an own data descriptor so a public compatibility alias can fail before package work. */
export function gpuPreviewPackageMotionData(pkg: MotionPackage): MotionPackage["motion"] | undefined {
  let descriptor: PropertyDescriptor | undefined;
  try { descriptor = Object.getOwnPropertyDescriptor(pkg, "motion"); }
  catch { return undefined; }
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "object" || descriptor.value === null || Array.isArray(descriptor.value)) return undefined;
  return descriptor.value as MotionPackage["motion"];
}
