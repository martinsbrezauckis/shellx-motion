import { requiredLoadedPackageDocumentHashes, type MotionPackage } from "@shellx-motion/core";

export class SupportBundleSourceChangedError extends Error {
  readonly code = "source_changed";

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, SupportBundleSourceChangedError.prototype);
  }
}

/** Return the two exact documents admitted by the package loader for support evidence. */
export function supportBundleDocumentHashes(pkg: MotionPackage): Record<string, string> {
  return requiredLoadedPackageDocumentHashes(pkg, "Support bundle");
}

/** Re-admit the same documents immediately before publishing a source-current support bundle. */
export async function assertSupportBundlePackageCurrent(
  pkg: MotionPackage,
  expected: Readonly<Record<string, string>>,
  packageLoader: (packageRoot: string) => Promise<MotionPackage>
): Promise<void> {
  const reopened = await packageLoader(pkg.root);
  const actual = supportBundleDocumentHashes(reopened);
  const expectedPaths = Object.keys(expected);
  if (expectedPaths.length !== Object.keys(actual).length || expectedPaths.some((path) => actual[path] !== expected[path])) {
    throw new SupportBundleSourceChangedError("Support bundle package documents changed before publication.");
  }
}
