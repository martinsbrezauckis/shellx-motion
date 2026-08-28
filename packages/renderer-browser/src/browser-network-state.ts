/**
 * browser-network-state.ts — the browser render lane's per-frame egress evidence sink, and the one
 * origin-normalization primitive every policy check in the lane compares against.
 *
 * Role: a tiny leaf module shared by the two enforcement layers so neither has to import the other
 * (`browser-route-policy.ts` decides Playwright route interceptions,
 * `browser-redirect-guard.ts` decides CDP response-stage redirect hops). Extracted from
 * browser-redirect-guard.ts when the guard grew popup suppression and document-downgrade rules —
 * keeping the shared types here is what lets both enforcement modules stay inside the module-size
 * ratchet in scripts/module-size-gate.mjs without raising a cap.
 *
 * Dependencies: none. Primary callers: browser-route-policy.ts, browser-redirect-guard.ts, and
 * index.ts (which constructs one state per frame and turns it into receipt warnings).
 */

/**
 * Per-frame evidence sink for the Playwright route/WebSocket interceptors, the popup suppression
 * rule, and the redirect guard. Every refusal the network policy makes while a frame renders is
 * recorded here and surfaced as receipt warnings, so a `passed` receipt genuinely means "nothing
 * was silently blocked" — and, just as importantly, so a render whose enforcement could not be
 * guaranteed never reports `passed` at all.
 *
 * Exported so the authorization logic can be regression-tested without a live Chromium — an
 * HTTPS redirect hop cannot be staged against a plain local HTTP test server.
 */
export interface BrowserFrameNetworkState {
  /** Host-derived, attested entry URL; present only for approved-agent-entry execution. */
  approvedAgentEntryUrl?: string;
  /** The one initial document navigation the pinned entry is allowed to make. */
  approvedAgentEntryInitialNavigationPending?: boolean;
  /** Origins of remote requests refused because they were not host-approved. */
  blockedRequests: string[];
  /** Normalized `ws(s)://authority` values for refused WebSocket connection attempts. */
  blockedWebSocketRequests: string[];
  /** True when a file: request tried to read outside the package root. */
  blockedExternalFileRequest: boolean;
  /**
   * Origin-level `https://... -> http://...` transitions refused by the redirect-downgrade check.
   * Kept separate from `blockedRequests`: the destination origin of a downgrade may itself be
   * host-approved, so reporting it as "undeclared" would misstate why the request was refused.
   */
  blockedDowngradeRedirects: string[];
  /**
   * Pages that appeared in the render context besides the one page being captured — popups and
   * new windows. A frame render screenshots exactly one page, so a second page can contribute no
   * pixels to the output while still being able to egress; every one of them is recorded, and the
   * page is closed. Values are origins (or `about:blank`), never full URLs: a popup URL is
   * attacker-chosen and may carry a query string (threat model TM-007).
   */
  blockedSecondaryPages: string[];
  /**
   * Origins of requests refused because they were issued by a page other than the render page.
   * Separate from `blockedRequests` because the origin may well be host-approved — what makes the
   * request inadmissible is where it came from, and the receipt has to say so.
   */
  blockedForeignPageRequests: string[];
  /**
   * Resource kinds refused for an approved-agent-entry document after its single attested inline
   * entry began. It never contains URLs: a script's URL may contain caller-controlled data.
   */
  blockedSecondaryCodeRequests?: Array<"script" | "worker" | "document">;
  /** Replacement attempts of the one approved main document; no attacker URL enters receipts. */
  blockedApprovedEntryNavigations?: Array<"top_level_document">;
  /**
   * Reasons the response-stage redirect guard stopped being able to enforce anything mid-render
   * (its CDP session detached, or its page went away). Recorded so a render that lost its primary
   * redirect enforcement cannot still report `passed`.
   */
  redirectGuardFailures: string[];
  /** Fixed, receipt-safe reasons a host-approved response was refused by byte/type/concurrency policy. */
  blockedResponsePolicies?: Array<"content_type" | "declared_bytes" | "streamed_bytes" | "aggregate_bytes" | "concurrency" | "body_stream">;
  /** Total decoded response bytes admitted for this frame. */
  admittedResponseBytes?: number;
  /** Responses currently crossing the bounded broker for this frame. */
  activeResponseCount?: number;
}

export interface BrowserNetworkEvidence {
  policy: "host-approved-origins";
  allowPrivateNetwork: boolean;
  resolutionTimeoutMs: number;
  approvedOrigins: string[];
  pins: Array<{ hostname: string; address: string; family: 4 | 6 }>;
  responsePolicy: {
    maxResponseBytes: number;
    maxAggregateBytes: number;
    maxConcurrentResponses: number;
    contentTypes: "bounded-render-media";
  };
}

export function assertBrowserRemoteResponsePolicy(state: BrowserFrameNetworkState): void {
  const failures = [...new Set(state.blockedResponsePolicies ?? [])];
  if (failures.length > 0) throw new Error(`Browser remote response policy refused the frame: ${failures.join(", ")}.`);
  if ((state.activeResponseCount ?? 0) !== 0) throw new Error("Browser remote response policy still had in-flight responses at capture time.");
}

/**
 * Normalizes a URL string to its `protocol//host` origin, or null when it is not a parseable URL.
 * This is the origin primitive every policy check in the lane compares against; index.ts imports
 * it back for preflight HTML origin scanning so there is exactly one normalization.
 */
export function remoteOrigin(source: string): string | null {
  try {
    const url = new URL(source);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/**
 * Returns only the scheme and authority for a refused WebSocket connection. The URL is page
 * controlled, so userinfo, path, query, and fragment must never enter receipt evidence.
 */
export function blockedWebSocketAuthority(source: string): string {
  return remoteOrigin(source) ?? "unparseable";
}
