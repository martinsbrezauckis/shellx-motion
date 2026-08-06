/**
 * Receipt folders a human granted through the Workbench's native folder chooser.
 *
 * Why this exists as a concept at all: the Debug API refuses a caller-named `receiptsRoot` that is
 * not inside a root the HOST nominated (see `receipts-root-policy.ts` in the debug-api package). That
 * fence closes a real disclosure hole, and it would also close the entirely legitimate human action
 * of pointing Motion at an existing receipt folder through the Workbench's Browse button.
 *
 * The resolution turns on a distinction that is easy to miss because both arrive over the same
 * authenticated transport: a path in a REQUEST BODY is chosen by the caller, while a path returned by
 * the native chooser is chosen by a person at the machine. A Debug API caller can ask for the dialog
 * to open. It cannot decide what comes back. So a completed chooser selection is host intent, and
 * granting it keeps "a caller cannot add a root" true without making Browse useless.
 *
 * Session-scoped deliberately. A grant lives in memory and dies with the server process it was made
 * to, so a folder opened once during one session does not stay readable to every later one.
 */

/** Opaque-by-convention grant set. Construct with {@link createOperatorReceiptGrants}. */
export type OperatorReceiptGrants = Set<string>;

export function createOperatorReceiptGrants(): OperatorReceiptGrants {
  return new Set<string>();
}

/**
 * Record a chooser selection when, and only when, it was a receipt-folder selection.
 *
 * @param grants Session grant set to add to.
 * @param purpose The chooser purpose as parsed from the request; anything other than the
 *   receipts-root purpose is ignored, so picking a render output or a package root never widens
 *   what receipts may be read.
 * @param selectedPath The path the chooser returned. Already realpath-resolved and confirmed to be a
 *   directory by `runWorkbenchPathPicker`, which is why no further validation happens here.
 */
export function grantOperatorReceiptRoot(
  grants: OperatorReceiptGrants,
  purpose: string | null,
  selectedPath: string
): void {
  if (purpose !== "receipts-root") return;
  grants.add(selectedPath);
}

/**
 * The dispatch context every transport shares, built in exactly one place.
 *
 * HTTP, MCP, and JSON-RPC all reach the same engine and must therefore agree on which directories
 * the HOST put in play -- the session's chooser grants and the operator's artifact roots. Three
 * hand-written context literals is three chances to disagree, and the failure would be silent and
 * asymmetric: one transport passing fewer roots looks like a permissions bug, and one transport
 * reading a root out of the request would be the disclosure hole the fence exists to close.
 *
 * Only `actor` is left to each caller, because that is the one field that genuinely differs -- it
 * records which wire the request arrived on.
 *
 * @param security Server session state: the base context, the grants, and the artifact roots.
 * @param tier The tier resolved for THIS request, which is never above the server's granted ceiling.
 */
export function dispatchContextBase<Context, Tier>(
  security: { context: Context; operatorReceiptRoots: OperatorReceiptGrants; artifactRoots: string[] },
  tier: Tier
): Context & { operatorReceiptRoots: string[]; artifactRoots: string[]; tier: Tier } {
  return {
    ...security.context,
    operatorReceiptRoots: [...security.operatorReceiptRoots],
    artifactRoots: security.artifactRoots,
    tier
  };
}
