import type { MotionPackage } from "./types";

/**
 * Closure-owned P2A execution bytes. This module is deliberately omitted from Core's barrel:
 * validating loaders may mint a snapshot, while renderers receive only this internal lookup.
 */
export interface AdmittedPackageExecutionSnapshot {
  readonly paths: readonly string[];
  readonly treeSha256: string;
  read(path: string): Readonly<{ bytes: Buffer; sha256: string; byteLength: number }> | undefined;
}

const snapshots = new WeakMap<MotionPackage, AdmittedPackageExecutionSnapshot>();

export function rememberAdmittedPackageExecutionSnapshot(pkg: MotionPackage, snapshot: AdmittedPackageExecutionSnapshot): void {
  snapshots.set(pkg, snapshot);
}

/** Exposed only by the explicit internal subpath; no caller-reachable registrar exists. */
export function admittedPackageExecutionSnapshot(pkg: MotionPackage): AdmittedPackageExecutionSnapshot | null {
  return snapshots.get(pkg) ?? null;
}
