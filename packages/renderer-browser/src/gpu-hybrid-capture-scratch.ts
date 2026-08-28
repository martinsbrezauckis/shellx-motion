import { randomUUID } from "node:crypto";
import { rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { OutputDirectoryReservation, type RetainedDirectoryAuthority } from "@shellx-motion/core";

/**
 * A hybrid capture owns exactly one private leaf under the already-admitted
 * job scratch root.  It never adopts a pre-existing directory and it never
 * recursively deletes caller-owned scratch on close.
 */
export interface GpuHybridCaptureScratch {
  readonly authority: RetainedDirectoryAuthority;
  readonly root: string;
  readonly pngPath: string;
  release(): Promise<void>;
}

export async function acquireGpuHybridCaptureScratch(input: {
  readonly scratchRoot: string;
  readonly prefix: "gpu-hybrid" | "gpu-restricted-shader" | "gpu-segmented-hybrid";
  readonly rangeIndex?: number;
}): Promise<GpuHybridCaptureScratch> {
  const suffix = input.rangeIndex === undefined ? randomUUID() : `${input.rangeIndex}-${randomUUID()}`;
  const authority = await OutputDirectoryReservation.acquire(join(input.scratchRoot, `${input.prefix}-${suffix}`), {
    requireAbsent: true,
    requirePrivate: true
  });
  const root = authority.path;
  const pngPath = join(root, "capture.png");
  return Object.freeze({
    authority,
    root,
    pngPath,
    async release() {
      await releaseGpuHybridCaptureScratch(authority, [pngPath]);
    }
  });
}

/**
 * Remove only output leaves this capture named itself, then prove that the
 * retained directory is empty.  Foreign contents make `rmdir` fail closed.
 */
export async function releaseGpuHybridCaptureScratch(
  authority: RetainedDirectoryAuthority,
  knownLeaves: readonly string[]
): Promise<void> {
  await authority.assertCurrent();
  for (const leaf of knownLeaves) {
    try {
      await unlink(leaf);
    } catch (error: unknown) {
      if (!(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT")) throw error;
    }
  }
  await authority.assertCurrent();
  await rmdir(authority.path);
}
