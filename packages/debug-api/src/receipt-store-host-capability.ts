import { accessSync, constants as fsConstants } from "node:fs";

/**
 * True only when this host can retain and traverse a descriptor-relative no-follow receipt chain.
 * `platform` and `procSelfFdUsable` are host-only test seams; command data cannot select or
 * weaken this capability.
 */
export function hasStableReceiptStoreCapability(
  platform: NodeJS.Platform = process.platform,
  procSelfFdUsable: () => boolean = hasUsableProcSelfFd
): boolean {
  return platform === "linux"
    && typeof fsConstants.O_DIRECTORY === "number"
    && typeof fsConstants.O_NOFOLLOW === "number"
    && procSelfFdUsable();
}

function hasUsableProcSelfFd(): boolean {
  try {
    accessSync("/proc/self/fd", fsConstants.R_OK | fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
