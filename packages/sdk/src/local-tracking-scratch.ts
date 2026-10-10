/** Per-request scratch belongs to the embedding host, independently of the output grant. */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OutputDirectoryReservation } from "@shellx-motion/core";
import { activeTrustedWorkspaceScratchRoot } from "@shellx-motion/core/internal/trusted-host-workspace";

export async function withLocalTrackingScratch<T>(hostScratchRoot: string | undefined, run: (scratchRoot: string) => Promise<T>): Promise<T> {
  const parent = hostScratchRoot === undefined ? await activeTrustedWorkspaceScratchRoot() ?? tmpdir() : resolve(hostScratchRoot);
  const scratchRoot = join(parent, `motion-sdk-tracking-${randomUUID()}`);
  const reservation = await OutputDirectoryReservation.acquire(scratchRoot, { requireAbsent: true, requirePrivate: true });
  try {
    return await run(scratchRoot);
  } finally {
    // A replaced directory or ancestor is never adopted for recursive cleanup.
    await reservation.assertCurrent();
    await rm(scratchRoot, { recursive: true, force: true });
  }
}
