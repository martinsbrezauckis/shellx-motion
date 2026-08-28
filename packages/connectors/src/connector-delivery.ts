/**
 * Private whole-tree delivery for the connector routes that have been admitted to it.
 *
 * A connector may create packages, media, handles, plans, and receipts over many steps, but it
 * has only one public success boundary: the caller-selected delivery root.  This helper keeps
 * every one of those bytes in Core's private directory transaction until its exact, nested file
 * inventory is known.  It is deliberately not exported from the package barrel: other connector
 * routes retain their existing behaviour until they are separately adopted.
 */
import { join, relative, resolve, sep } from "node:path";
import {
  OutputDirectoryTransaction,
  type OutputDirectoryTransactionExpectedInventory
} from "@shellx-motion/core";

export interface PrivateConnectorDelivery {
  readonly publicRoot: string;
  readonly stagingRoot: string;
  /** Convert one known public delivery path to its private staging equivalent. */
  stagePath(publicPath: string): string;
  /** Publish exactly the staged nested file tree once, or retain Core's uncertainty evidence. */
  commit(expectedInventory: OutputDirectoryTransactionExpectedInventory): Promise<void>;
  /** Remove only the exact private stage on a known pre-publication failure. */
  abort(): Promise<void>;
}

export async function createPrivateConnectorDelivery(outDir: string): Promise<PrivateConnectorDelivery> {
  const publicRoot = resolve(outDir);
  const transaction = await OutputDirectoryTransaction.create(publicRoot, { requireClosedTree: true });
  const stagingRoot = transaction.stagingPath;

  function stagePath(publicPath: string): string {
    return translateWithinRoot(publicRoot, stagingRoot, publicPath, "public delivery path");
  }

  return {
    publicRoot,
    stagingRoot,
    stagePath,
    async commit(expectedInventory: OutputDirectoryTransactionExpectedInventory): Promise<void> {
      await transaction.commit(expectedInventory);
    },
    async abort(): Promise<void> {
      await transaction.abort();
    }
  };
}

function translateWithinRoot(fromRoot: string, toRoot: string, path: string, label: string): string {
  const resolved = resolve(path);
  const relation = relative(fromRoot, resolved);
  if (relation === "" || relation === ".." || relation.startsWith(`..${sep}`)) {
    throw new Error(`${label} must name a file beneath its delivery root`);
  }
  return join(toRoot, relation);
}
