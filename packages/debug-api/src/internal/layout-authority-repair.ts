/**
 * Installed host-only repair surface for interrupted layout authority-pair publication.
 *
 * This deliberately lives at an `internal/` package subpath rather than the Debug command API.
 * A trusted embedding host first chooses its receipts root and makes every writer sharing that
 * root operationally quiescent, then it may advance the returned self-discovering service. No
 * Debug request, CLI argument, MCP argument, package field, or caller can create this service's
 * opaque quiescence admission or select a pair descriptor.
 */
import {
  openLayoutAuthorityPairDiscovery,
  repairLayoutAuthorityPairDiscoveryPage,
  trustedAuthorityDirectory,
  type DiscoveredLayoutAuthorityPair,
  type RepairedLayoutAuthorityPair,
} from "../domains/timeline-layout-application-authority-store.js";
import {
  runHostQuiescentPairRecovery,
  runHostQuiescentPairRecoveryAfterCrash,
} from "../domains/timeline-layout-authority-pair-store.js";

export interface HostLayoutAuthorityPairRepair {
  /**
   * Bounded v2 intent inventory for this receipts root. It is safe during ordinary startup: it
   * never treats an O_EXCL writer lock as stale and never mutates a pair or package output.
   */
  inspectNextPage(): Promise<HostLayoutAuthorityPairInspectionPage>;
  /**
   * Explicit trusted-host repair. The host must have stopped every process that can author into
   * this receipts root; the on-disk repair gate then excludes cooperative writers until the whole
   * self-discovered repair batch has either completed or refused.
   */
  repairNextPage(): Promise<HostLayoutAuthorityPairRepairPage>;
  /** Explicit crash-restart mode after the embedding host proves all other repair processes stopped. */
  repairNextPageAfterHostCrash(): Promise<HostLayoutAuthorityPairRepairPage>;
}

export interface HostLayoutAuthorityPairInspectionPage {
  pairs: readonly DiscoveredLayoutAuthorityPair[];
  complete: boolean;
}

export interface HostLayoutAuthorityPairRepairPage {
  actions: readonly RepairedLayoutAuthorityPair[];
  complete: boolean;
}

/**
 * Bind repair to one host-selected receipts root. The private admission remains inside the
 * authority store, so importing this installed module cannot mint operator quiescence.
 */
export function createHostLayoutAuthorityPairRepair(
  receiptsRoot: string,
): HostLayoutAuthorityPairRepair {
  if (typeof receiptsRoot !== "string" || !receiptsRoot.trim()) {
    throw new Error("Layout authority repair requires a host-configured receiptsRoot.");
  }
  const configuredReceiptsRoot = receiptsRoot;
  interface DiscoveryCursor {
    pager?: Awaited<ReturnType<typeof openLayoutAuthorityPairDiscovery>>;
    directory?: Awaited<ReturnType<typeof trustedAuthorityDirectory>>;
    candidates: number;
    blocked: boolean;
  }
  const inspection: DiscoveryCursor = { candidates: 0, blocked: false };
  const repair: DiscoveryCursor = { candidates: 0, blocked: false };
  const nextPage = async (cursor: DiscoveryCursor) => {
    if (cursor.blocked) {
      throw new Error("Layout authority repair inventory exceeds its bounded interrupted-pair cap.");
    }
    const directory = await trustedAuthorityDirectory(configuredReceiptsRoot, false);
    if (!cursor.pager || !cursor.directory || cursor.directory.path !== directory.path
      || cursor.directory.root.dev !== directory.root.dev || cursor.directory.root.ino !== directory.root.ino) {
      await cursor.pager?.close().catch(() => {});
      cursor.pager = await openLayoutAuthorityPairDiscovery(directory);
      cursor.directory = directory;
      cursor.candidates = 0;
    }
    const page = await cursor.pager.next();
    cursor.candidates += page.pairs.length;
    if (cursor.candidates > 32) {
      cursor.blocked = true;
      await cursor.pager.close().catch(() => {});
      cursor.pager = undefined;
      cursor.directory = undefined;
      throw new Error("Layout authority repair inventory exceeds its bounded interrupted-pair cap.");
    }
    if (page.complete) {
      await cursor.pager.close();
      cursor.pager = undefined;
      cursor.directory = undefined;
      cursor.candidates = 0;
    }
    return { directory, page };
  };
  const repairPage = async (
    recover: typeof runHostQuiescentPairRecovery,
  ): Promise<HostLayoutAuthorityPairRepairPage> => {
    // Take the root gate before advancing the opaque cursor. A normal contender that sees a
    // live gate has no observable effect on the first repair's members or on its own retry page.
    const directory = await trustedAuthorityDirectory(configuredReceiptsRoot, false);
    return await recover(directory, async (admission) => {
      const next = await nextPage(repair);
      const actions = await repairLayoutAuthorityPairDiscoveryPage(next.directory, next.page, admission);
      return { actions, complete: next.page.complete };
    });
  };
  return Object.freeze({
    async inspectNextPage(): Promise<HostLayoutAuthorityPairInspectionPage> {
      try {
        const { page } = await nextPage(inspection);
        return { pairs: page.pairs, complete: page.complete };
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { pairs: [], complete: true };
        throw error;
      }
    },
    async repairNextPage(): Promise<HostLayoutAuthorityPairRepairPage> {
      return await repairPage(runHostQuiescentPairRecovery);
    },
    async repairNextPageAfterHostCrash(): Promise<HostLayoutAuthorityPairRepairPage> {
      return await repairPage(runHostQuiescentPairRecoveryAfterCrash);
    },
  });
}
