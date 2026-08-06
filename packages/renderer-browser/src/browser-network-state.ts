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
  /** Origins of remote requests refused because they were not host-approved. */
  blockedRequests: string[];
  /** Full URLs of WebSocket connection attempts (all WebSocket egress is refused). */
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
   * Reasons the response-stage redirect guard stopped being able to enforce anything mid-render
   * (its CDP session detached, or its page went away). Recorded so a render that lost its primary
   * redirect enforcement cannot still report `passed`.
   */
  redirectGuardFailures: string[];
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
