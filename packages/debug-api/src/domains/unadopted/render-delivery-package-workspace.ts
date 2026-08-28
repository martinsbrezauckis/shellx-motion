/** Exact host-owned package workspace authority for private provider-delivery leaves. */

import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  assertTrustedWorkspaceAnchorPath,
  withTrustedWorkspaceAnchor,
  type TrustedWorkspaceAnchor,
} from "@shellx-motion/core/internal/trusted-host-workspace";
import { PackageEditTransactionError } from "../package-edit-transaction-error.js";

export interface RenderDeliveryPackageWorkspaceHost {
  /** Host-selected imported package. Its path is never returned as durable evidence. */
  readonly sourcePackageRoot: string;
  /** Exact host-selected workspace containing the imported package. */
  readonly packageWorkspaceRoot: string;
  /** Required on POSIX; factory-issued only for exactly packageWorkspaceRoot. */
  readonly packageWorkspaceAuthority?: TrustedWorkspaceAnchor;
}

/**
 * Scope a package-local operation to one exact, host-selected workspace. This is deliberately
 * independent of provider authority: C5B2 must be able to inspect an imported package after the
 * original provider process and its non-serializable capability have gone away.
 */
export async function withRenderDeliveryPackageWorkspaceAuthority<T>(
  host: RenderDeliveryPackageWorkspaceHost,
  operation: () => Promise<T>,
): Promise<T> {
  const workspace = resolve(host.packageWorkspaceRoot);
  if (!strictDescendant(workspace, resolve(host.sourcePackageRoot))) {
    throw new PackageEditTransactionError("unsafe_output", "Imported package must be a strict descendant of the host-selected workspace.");
  }
  if (!host.packageWorkspaceAuthority) {
    if (process.platform !== "win32") {
      throw new PackageEditTransactionError("unsafe_output", "POSIX provider delivery package inspection requires an exact host workspace authority.");
    }
    return await operation();
  }
  try {
    await assertTrustedWorkspaceAnchorPath(host.packageWorkspaceAuthority, workspace);
  } catch (error) {
    if (error instanceof PackageEditTransactionError) throw error;
    throw new PackageEditTransactionError("unsafe_output", "Host package workspace authority does not match the selected workspace.");
  }
  return await withTrustedWorkspaceAnchor(host.packageWorkspaceAuthority, operation);
}

function strictDescendant(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}
