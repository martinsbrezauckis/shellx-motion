/**
 * `POST /sdk` — the fourth transport, and for a while the one nobody counted.
 *
 * Role: parse a canonical SDK request, admit it against the server's tier grant, apply the SAME
 * caller-boundary fence the other three transports apply, then hand it to the SDK transport.
 *
 * WHY IT IS ITS OWN MODULE. `guarded-dispatch.ts` opens by naming three transports. There were four.
 * `/sdk` sat inline in `index.ts` reaching `security.sdkTransport.execute(...)` directly, and the
 * local transport underneath calls `dispatchDebugCommand` — so a `read_motion` bearer client that
 * `POST /debug` refused for a foreign `receiptsRoot` got the victim's job records back through
 * `POST /sdk {operation:"status", input:{receiptsRoot: victimRoot}}`. Inline route code is how a
 * transport gets added without anyone noticing it is a transport; a named module with the fence in
 * it is how the next one inherits the check.
 *
 * WHERE THIS TRANSPORT CARRIES THE FENCED VALUE. Under `input`, not at the top level. That single
 * fact is the second half of the same defect: the boundary check used to dig `args.receiptsRoot`
 * out of the request itself, found nothing in an SDK body, and refused nothing. `sdkRequestReceiptsRoot`
 * states the answer for this transport explicitly — see `caller-boundary.ts` in `@shellx-motion/debug-api`.
 *
 * The fence is applied to EVERY operation, not the subset whose documented input includes
 * `receiptsRoot`. `readSdkRequest` validates the cache key, not the field set, so `input.receiptsRoot`
 * rides on any operation a caller likes; fencing only the documented carriers would fence the
 * documentation rather than the door.
 *
 * Dependencies: `@shellx-motion/sdk` for the request envelope and cache key, `./transport-refusals.js`
 * for this transport's error shape, `./sdk-operation-policy.js` for the per-operation tier,
 * `./operator-receipt-grants.js` for the shared dispatch context.
 *
 * Primary caller: `./index.ts`.
 */
import {
  refuseUntrustedCallerReceiptsRoot,
  tierRefusal,
  type MotionDebugContext
} from "@shellx-motion/debug-api";
import {
  MOTION_SDK_SCHEMA,
  motionSdkCacheKey,
  type MotionSdkTransport,
  type MotionSdkTransportRequest
} from "@shellx-motion/sdk";
import { dispatchContextBase, type OperatorReceiptGrants } from "./operator-receipt-grants.js";
import { SDK_OPERATION_TIER, readSdkOperation } from "./sdk-operation-policy.js";
import { PERMISSION_TIER_RANK, debugServerError, sdkFailure } from "./transport-refusals.js";

type MotionPermissionTier = MotionDebugContext["tier"];

/** The slice of the server's session state this route needs. */
export interface SdkRouteSecurity {
  grantedTier: MotionPermissionTier;
  sdkTransport: MotionSdkTransport;
  context: Partial<Omit<MotionDebugContext, "tier">>;
  operatorReceiptRoots: OperatorReceiptGrants;
  artifactRoots: string[];
}

export interface SdkRouteAnswer { status: number; body: unknown }

/**
 * The caller-supplied `receiptsRoot` as THIS transport carries it: `input.receiptsRoot`.
 *
 * A one-line function with a name, rather than an inline property read, because the equivalent
 * inline read on the other transports is what made the omission here invisible. A transport that
 * carries the value somewhere else must add its own extractor and cannot inherit this one by
 * accident.
 */
export function sdkRequestReceiptsRoot(request: MotionSdkTransportRequest): string | undefined {
  const input = request.input as unknown as Record<string, unknown> | undefined;
  const requested = input?.receiptsRoot;
  return typeof requested === "string" && requested.trim() !== "" ? requested : undefined;
}

/**
 * Handle one `POST /sdk` body.
 *
 * @param payload the already-parsed JSON request body.
 * @param security the server's session state.
 * @returns the HTTP status and the body to write.
 */
export async function runSdkRequest(payload: unknown, security: SdkRouteSecurity): Promise<SdkRouteAnswer> {
  const parsed = await readSdkRequest(payload);
  if (!parsed.ok) return { status: 400, body: debugServerError("invalid_sdk_request", parsed.message) };
  const request = parsed.request;

  const requiredTier = SDK_OPERATION_TIER[request.operation];
  if (PERMISSION_TIER_RANK[requiredTier] > PERMISSION_TIER_RANK[security.grantedTier]) {
    // Same builder as the dispatch and requestedTier gates: the SDK caller is as unable to
    // elevate itself as the MCP one, so the answer names the host operator's change too.
    const refusal = tierRefusal({ subject: `Motion SDK ${request.operation}`, requiredTier, grantedTier: security.grantedTier });
    return { status: 403, body: sdkFailure(request, refusal.code, refusal.message, refusal) };
  }

  // `dispatchContextBase` and not a literal: the roots this route fences against must be the same
  // set POST /debug, MCP and JSON-RPC fence against, and three hand-written context objects is three
  // chances for one transport to be quietly more permissive than the rest.
  const context = dispatchContextBase(security, requiredTier) as MotionDebugContext;
  const refusal = await refuseUntrustedCallerReceiptsRoot(
    `Motion SDK ${request.operation}`,
    sdkRequestReceiptsRoot(request),
    context
  );
  if (refusal && !refusal.ok) {
    return {
      status: refusal.error.code === "invalid_args" ? 400 : 403,
      body: sdkFailure(request, refusal.error.code, refusal.error.message, refusal.error)
    };
  }

  return { status: 200, body: await security.sdkTransport.execute(request) };
}

/**
 * Validate a canonical SDK request body.
 *
 * The cache key is recomputed from the input and must match, and the request id must be derived from
 * it, so a body cannot claim one identity while carrying another. Note what this does NOT do: it
 * does not restrict `input` to the operation's declared fields. That is why the fence above runs for
 * every operation.
 */
async function readSdkRequest(value: unknown): Promise<{ ok: true; request: MotionSdkTransportRequest } | { ok: false; message: string }> {
  const body = objectRecord(value);
  if (!body || body.schema !== MOTION_SDK_SCHEMA) return { ok: false, message: `Motion SDK requests require schema ${MOTION_SDK_SCHEMA}.` };
  const operation = readSdkOperation(body.operation);
  if (!operation) return { ok: false, message: "Motion SDK request operation is invalid." };
  if (typeof body.requestId !== "string" || body.requestId.length > 128) return { ok: false, message: "Motion SDK requestId is invalid." };
  if (typeof body.cacheKey !== "string" || !/^[a-f0-9]{64}$/.test(body.cacheKey)) return { ok: false, message: "Motion SDK cacheKey must be SHA-256." };
  const input = objectRecord(body.input);
  if (!input) return { ok: false, message: "Motion SDK request input must be an object." };
  let expected: string;
  try { expected = await motionSdkCacheKey(operation, input); }
  catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
  if (expected !== body.cacheKey) return { ok: false, message: "Motion SDK cacheKey does not match the canonical request input." };
  if (body.requestId !== `sdk-${operation}-${expected.slice(0, 20)}`) return { ok: false, message: "Motion SDK requestId does not match the canonical cache key." };
  return { ok: true, request: { schema: MOTION_SDK_SCHEMA, operation, requestId: body.requestId, cacheKey: body.cacheKey, input } as unknown as MotionSdkTransportRequest };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}
