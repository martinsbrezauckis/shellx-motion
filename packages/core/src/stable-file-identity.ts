import type { Stats } from "node:fs";

/** Path-free identity facts for an opened, stable regular file. */
export interface StableFileIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly nlink: number;
  readonly byteLength: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

export function stableFileIdentity(stats: Stats): StableFileIdentity {
  return {
    dev: String(stats.dev),
    ino: String(stats.ino),
    nlink: stats.nlink,
    byteLength: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  };
}

/** Reject a changed reservation before the caller can allocate a byte buffer. */
export function assertExpectedStableFileIdentity(
  stats: Stats,
  expected: StableFileIdentity | undefined,
  label: string,
): void {
  if (!expected) return;
  const actual = stableFileIdentity(stats);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.nlink !== expected.nlink
    || actual.byteLength !== expected.byteLength || actual.mtimeMs !== expected.mtimeMs || actual.ctimeMs !== expected.ctimeMs) {
    throw new Error(`${label} changed after metadata preflight and before it was read`);
  }
}
