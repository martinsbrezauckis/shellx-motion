/**
 * How this server words a refusal, on every transport it speaks.
 *
 * Role: the debug server answers over four shapes — POST /debug, POST /sdk, JSON-RPC, and MCP
 * `tools/call` — and each has its own error envelope. Left inline in `index.ts` those envelopes
 * drifted: the same permission refusal carried guidance on one path, a bare sentence on another,
 * and on JSON-RPC a numeric code with nothing attached. This module is the one place each envelope
 * is built, so a refusal that is actionable on one transport is actionable on all of them.
 *
 * Extracted from `index.ts` rather than added to it: that file carries a declared non-growth
 * baseline in `scripts/module-size-gate.mjs`, and error wording is a coherent unit of its own.
 *
 * Dependencies: the tier vocabulary and refusal text from `@shellx-motion/debug-api` (which
 * re-exports it from `@shellx-motion/actions`); the SDK response envelope from
 * `@shellx-motion/sdk`.
 *
 * Primary caller: `./index.ts`.
 */
import { requestedTierRefusal, type MotionDebugContext } from "@shellx-motion/debug-api";
import { MOTION_SDK_SCHEMA, type MotionSdkTransportRequest, type MotionSdkTransportResponse } from "@shellx-motion/sdk";

type MotionPermissionTier = MotionDebugContext["tier"];

export type JsonRpcId = string | number | null;

export type JsonRpcResponseBody = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    /** JSON-RPC's structured slot; where an MCP client looks for anything beyond the message. */
    data?: unknown;
  };
};

export const PERMISSION_TIERS = new Set<MotionPermissionTier>([
  "read_motion",
  "draft_motion",
  "render_motion",
  "edit_motion",
  "write_local",
  "push_remote"
]);

export const PERMISSION_TIER_RANK: Record<MotionPermissionTier, number> = {
  read_motion: 0,
  draft_motion: 1,
  render_motion: 2,
  edit_motion: 3,
  write_local: 4,
  push_remote: 5
};

export function readPermissionTier(value: unknown): MotionPermissionTier | null {
  return typeof value === "string" && PERMISSION_TIERS.has(value as MotionPermissionTier)
    ? value as MotionPermissionTier
    : null;
}

/** The optional, actionable half of an error: omitted entirely when there is no honest next step. */
export interface RefusalGuidance {
  suggestedAction?: string;
  detail?: unknown;
}

export type ResolvedRequestedTier =
  | { ok: true; tier: MotionPermissionTier }
  | ({ ok: false; message: string } & RefusalGuidance);

/**
 * Resolve the tier a call runs at, refusing anything above the process grant.
 *
 * @param value - the caller's `requestedTier` (or its `tier` synonym); absent means "use the grant".
 * @param grantedTier - the tier this server process was started with. Fixed for its lifetime.
 *
 * The refusal is built by `requestedTierRefusal` so the wire answer carries the same three facts
 * every other Motion tier refusal carries: the grant is fixed, the caller cannot change it, and the
 * host operator's change is named. The old message stated only the first, which left an agent that
 * hit -32001 retrying the same escalation. The leading sentence is unchanged so hosts matching on
 * it keep working.
 */
export function resolveRequestedTier(value: unknown, grantedTier: MotionPermissionTier): ResolvedRequestedTier {
  if (value === undefined || value === null) return { ok: true, tier: grantedTier };
  const requestedTier = readPermissionTier(value);
  if (!requestedTier) {
    return {
      ok: false,
      message: "Requested Motion permission tier is invalid.",
      suggestedAction: `Send requestedTier as one of ${[...PERMISSION_TIERS].join(", ")}, or omit it to run at this server's grant (${grantedTier}).`
    };
  }
  if (PERMISSION_TIER_RANK[requestedTier] > PERMISSION_TIER_RANK[grantedTier]) {
    const refusal = requestedTierRefusal({ requestedTier, grantedTier });
    return { ok: false, message: refusal.message, suggestedAction: refusal.suggestedAction, detail: refusal.detail };
  }
  return { ok: true, tier: requestedTier };
}

/** The POST /debug envelope. */
export function debugServerError(code: string, message: string, guidance?: RefusalGuidance): Record<string, unknown> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(guidance?.suggestedAction ? { suggestedAction: guidance.suggestedAction } : {}),
      ...(guidance?.detail !== undefined ? { detail: guidance.detail } : {})
    },
    warnings: []
  };
}

/**
 * The JSON-RPC / MCP envelope.
 *
 * @param guidance - carried in `error.data`, which is where MCP clients look for structured detail.
 *   A tier refusal puts its `suggestedAction` here so an agent that hits -32001 learns it cannot
 *   self-elevate instead of retrying the same escalation.
 */
export function jsonRpcError(id: JsonRpcId, code: number, message: string, guidance?: RefusalGuidance): JsonRpcResponseBody {
  const data = {
    ...(guidance?.suggestedAction ? { suggestedAction: guidance.suggestedAction } : {}),
    ...(guidance?.detail !== undefined ? { detail: guidance.detail } : {})
  };
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(Object.keys(data).length > 0 ? { data } : {}) }
  };
}

/**
 * The POST /sdk envelope.
 *
 * @param guidance - carried in `error.detail`, the SDK error's only open field. A tier refusal's
 *   suggestedAction rides there rather than being dropped: `retryable: false` tells the caller not
 *   to repeat the call but not what would make it succeed.
 */
export function sdkFailure(
  request: MotionSdkTransportRequest,
  code: string,
  message: string,
  guidance?: RefusalGuidance
): MotionSdkTransportResponse {
  const detail = guidance
    ? {
        ...(guidance.suggestedAction ? { suggestedAction: guidance.suggestedAction } : {}),
        ...(typeof guidance.detail === "object" && guidance.detail !== null ? guidance.detail : {})
      }
    : undefined;
  return {
    schema: MOTION_SDK_SCHEMA,
    operation: request.operation,
    requestId: request.requestId,
    cacheKey: request.cacheKey,
    ok: false,
    error: { code, message, retryable: false, ...(detail && Object.keys(detail).length > 0 ? { detail } : {}) },
    warnings: []
  };
}
