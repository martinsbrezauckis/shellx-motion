/**
 * Where a CALLER stops being the HOST, and what has to happen at that line.
 *
 * Role: the receipts-root containment check, plus the two facts a transport has to supply for it to
 * mean anything -- the subject to name in the refusal, and the caller-supplied `receiptsRoot` READ
 * FROM WHERE THAT TRANSPORT ACTUALLY CARRIES IT.
 *
 * That second fact is the whole reason this module exists as its own file. The check used to read
 * `args.receiptsRoot` itself, which silently assumed every transport shapes its request like
 * `POST /debug`. `POST /sdk` does not: it nests the operation input under `input`, so the extractor
 * found nothing, and a check that finds nothing refuses nothing. A boundary that guesses where the
 * value lives is a boundary that fails open on the first transport shaped differently, which is
 * exactly what happened. So the value is now a PARAMETER: each transport states where its own
 * requests carry it, and a new transport cannot inherit a wrong guess.
 *
 * WHO CROSSES THE LINE. Three kinds of call reach `dispatchDebugCommand`, and only two of them
 * cross a privilege boundary:
 *
 *   1. A transport request (`POST /debug`, `POST /sdk`, MCP `tools/call`, JSON-RPC). A bearer
 *      client on the other side of a loopback socket is NOT the host. Fenced -- via
 *      `dispatchGuarded` and the `/sdk` route in `@shellx-motion/debug-server`.
 *   2. Re-entry with CALLER-STEERED arguments. `motion.prompt.run` dispatches commands an agent
 *      proposed, with `args` passed through unvalidated, so the arguments have a caller's
 *      provenance even though the dispatch is internal. Fenced -- via
 *      `dispatchCallerSteeredCommand`.
 *   3. Re-entry with HOST-DERIVED paths, and in-process embedders. `motion.render.batch` dispatches
 *      `motion.render.final` per row with a `receiptsRoot` Motion computed from the batch output
 *      directory; the CLI and hosts embedding Motion call the dispatcher directly, and an operator
 *      typing `--receipts-root` at a shell IS the host. Not fenced -- there is no line here to
 *      defend, and fencing it refuses Motion's own orchestration.
 *
 * The distinguishing property is the PROVENANCE OF THE ARGUMENTS, never the command id. Two entry
 * points express it -- `dispatchDebugCommand` for (3), `dispatchCallerSteeredCommand` for (2) --
 * so adding a caller-steered re-entry that forgets the fence requires writing the shorter name
 * rather than merely omitting a line.
 *
 * STRICTNESS. This applies `callerReceiptsRootRefusal`, the form that refuses outright when the host
 * declared no root at all. The looser form the dispatcher once used ("a host that declares nothing
 * is one where caller and host are the same party") is true for case 3 and false for cases 1 and 2,
 * and this module is only ever reached from 1 and 2. A `startMotionDebugServer` embedder that passed
 * no context served a foreign receipts root at `read_motion` for exactly as long as the loose form
 * was applied here.
 *
 * Dependencies: `./domains/receipts-root-policy.js` for the policy itself. Path containment is
 * INJECTED rather than imported, so this module stays free of `index.ts` and there is no cycle.
 *
 * Primary callers: `index.ts` (which binds the path-containment implementation and re-exports),
 * `@shellx-motion/debug-server`.
 */
import { callerReceiptsRootRefusal, type ReceiptsRootPolicyServices } from "./domains/receipts-root-policy.js";
import type { MotionDebugResult } from "./command-registry.js";

/** The host-declared roots a dispatch context carries, as the policy needs to see them. */
export interface CallerBoundaryContext {
  receiptsRoot?: string;
  scratchRoot?: string;
  operatorReceiptRoots?: string[];
}

/**
 * The `receiptsRoot` a caller actually asked for on a TOP-LEVEL-ARGS transport, or undefined when it
 * asked for nothing.
 *
 * Deliberately NOT `args.receiptsRoot ?? context.receiptsRoot`: the containment policy must be able
 * to tell "the caller named a root" from "the caller named nothing and the host's own root will be
 * used". Collapsing the two would put the host's root through a containment check against itself.
 *
 * @param args the raw argument object as the transport received it.
 * @returns the caller's non-empty string value, or undefined.
 */
export function callerSuppliedReceiptsRoot(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const requested = (args as Record<string, unknown>).receiptsRoot;
  return typeof requested === "string" && requested.trim() !== "" ? requested : undefined;
}

/**
 * Refuse a caller-named `receiptsRoot` that falls outside the roots the host declared.
 *
 * @param subject what to name in the refusal -- a command id, or a transport-and-operation label
 *   such as `Motion SDK status`. It appears in the message the caller reads, so it must be the
 *   thing the caller actually invoked.
 * @param requestedReceiptsRoot the caller's value, already extracted from wherever this transport
 *   carries it. Undefined means the caller named nothing, which is always admitted.
 * @param context the host-declared roots for this dispatch.
 * @param isPathInsideTrustedRoot symlink-resolving containment test, injected by `index.ts`.
 * @returns the refusal to return to the caller, or null when the request may proceed.
 */
export async function refuseCallerReceiptsRoot(
  subject: string,
  requestedReceiptsRoot: string | undefined,
  context: CallerBoundaryContext,
  isPathInsideTrustedRoot: NonNullable<ReceiptsRootPolicyServices["isPathInsideTrustedRoot"]>
): Promise<MotionDebugResult | null> {
  return callerReceiptsRootRefusal(subject, requestedReceiptsRoot, {
    ...(context.receiptsRoot ? { receiptsRoot: context.receiptsRoot } : {}),
    ...(context.scratchRoot ? { scratchRoot: context.scratchRoot } : {}),
    ...(context.operatorReceiptRoots ? { operatorReceiptRoots: context.operatorReceiptRoots } : {}),
    isPathInsideTrustedRoot
  });
}
