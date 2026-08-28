import { createHash } from "node:crypto";
import {
  canonicalJson,
  loadedPackageInputHashes,
  type MotionDocument,
  type MotionPackage
} from "@shellx-motion/core";

/** Exact loaded-package evidence shared by GPU preview and streamed production. */
export function gpuLoadedPackageInputHashes(pkg: MotionPackage, admittedMotion?: MotionDocument): Readonly<Record<string, string>> {
  const loaded = loadedPackageInputHashes(pkg);
  return Object.freeze({
    "manifest.json": loaded?.["manifest.json"] ?? sha256Canonical(pkg.manifest),
    [pkg.manifest.motion]: admittedMotion ? sha256Canonical(admittedMotion) : loaded?.[pkg.manifest.motion] ?? sha256Canonical(pkg.motion)
  });
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
