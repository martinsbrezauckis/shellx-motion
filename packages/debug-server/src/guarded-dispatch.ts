/**
 * Every external debug request goes through here, so the boundary checks cannot be forgotten.
 *
 * The loopback server exposes Motion across a real privilege line: a bearer client on the other side
 * is not the host. FOUR transports reach the same engine — HTTP `POST /debug`, MCP `tools/call`,
 * JSON-RPC dispatch, and `POST /sdk` — and a check applied to three of them is a check that does not
 * hold.
 *
 * That sentence used to say three, and the fourth was the one it was wrong about. `POST /sdk` routed
 * into the SDK transport, whose local implementation calls `dispatchDebugCommand` itself, so a
 * `read_motion` client refused a foreign `receiptsRoot` on `/debug` was served the victim's job
 * records on `/sdk`. Counting transports in a comment is not a mechanism; the mechanism is that
 * `/sdk` now goes through `runSdkRequest` in `sdk-route.ts`, which applies the same check this
 * wrapper does, and that a live-server test drives every route.
 *
 * `dispatchDebugCommand` itself deliberately does NOT carry these checks, because Motion re-enters it
 * internally -- `motion.render.batch` dispatches `motion.render.final` per row with paths Motion
 * derived -- and the CLI and in-process embedders reach it without crossing any boundary at all.
 * Re-entry with CALLER-STEERED arguments is a different act and is fenced by
 * `dispatchCallerSteeredCommand`. See `caller-boundary.ts` in the debug-api package for the full
 * reasoning.
 *
 * So: this wrapper is the boundary, and the way it is used matters. Call sites say `dispatchGuarded`
 * instead of `dispatchDebugCommand`, which means adding a transport that forgets the guard requires
 * writing a different function name rather than merely omitting a line.
 */
import { callerSuppliedReceiptsRoot, dispatchDebugCommand, refuseUntrustedCallerReceiptsRoot } from "@shellx-motion/debug-api";

type DispatchArgs = Parameters<typeof dispatchDebugCommand>;

/**
 * Apply the external-request boundary checks, then dispatch.
 *
 * @param command Debug command id, already resolved and tier-checked by the transport.
 * @param args Raw caller arguments, already schema-validated by the transport. These transports
 *   carry `receiptsRoot` at the TOP LEVEL of the argument object, which is why
 *   `callerSuppliedReceiptsRoot` is the right extractor here and `/sdk` needs its own.
 * @param context Dispatch context built by the host, carrying the roots the host declared.
 * @returns The command result, or a refusal produced by a boundary check without dispatching.
 */
export async function dispatchGuarded(
  command: DispatchArgs[0],
  args: DispatchArgs[1],
  context: DispatchArgs[2]
): ReturnType<typeof dispatchDebugCommand> {
  const receiptsRootRefusal = await refuseUntrustedCallerReceiptsRoot(
    command,
    callerSuppliedReceiptsRoot(args),
    context
  );
  if (receiptsRootRefusal) return receiptsRootRefusal;
  return dispatchDebugCommand(command, args, context);
}
