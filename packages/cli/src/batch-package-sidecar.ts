import type { MotionPackage } from "@shellx-motion/core";

/** Reads a package-local quality sidecar reference declared by Template metadata. */
export function batchTemplateQualityManifestRef(pkg: MotionPackage): string | null {
  const template = (pkg as { template?: unknown }).template;
  if (!template || typeof template !== "object") return null;
  const metadata = (template as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const qualityTargets = (metadata as { qualityTargets?: unknown }).qualityTargets;
  if (!qualityTargets || typeof qualityTargets !== "object") return null;
  const manifestRef = (qualityTargets as { manifest?: unknown }).manifest;
  return typeof manifestRef === "string" && manifestRef.length > 0 ? manifestRef : null;
}
