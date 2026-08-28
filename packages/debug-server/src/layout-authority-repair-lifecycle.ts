/** Host-owned pre-listen repair lifecycle for interrupted layout authority-pair publication. */
import {
  createHostLayoutAuthorityPairRepair,
  type HostLayoutAuthorityPairRepair,
} from "@shellx-motion/debug-api/internal/layout-authority-repair";

/**
 * Host-only crash-repair lifecycle. It runs before the Debug Server creates or binds a transport.
 * The embedding host must establish operational quiescence for every authority writer sharing the
 * configured receipts root; a Debug request, CLI argument, MCP call, or package cannot invoke it.
 */
export type LayoutAuthorityRepairStartup = (
  repair: HostLayoutAuthorityPairRepair,
) => void | Promise<void>;

/**
 * Run an explicit host repair only before this process can admit a transport writer. The callback
 * advances `repairNextPage()` until it reports `complete`, subject to the embedding host's bounded
 * startup budget. Cross-process writer quiescence is an operator precondition, not evidence that
 * ordinary writers can infer.
 */
export async function runHostLayoutAuthorityRepairAtStartup(
  receiptsRoot: unknown,
  startup: LayoutAuthorityRepairStartup | undefined,
): Promise<void> {
  if (!startup) return;
  if (typeof receiptsRoot !== "string" || !receiptsRoot.trim()) {
    throw new Error("Layout authority repair startup requires a host-configured context.receiptsRoot.");
  }
  await startup(createHostLayoutAuthorityPairRepair(receiptsRoot));
}
