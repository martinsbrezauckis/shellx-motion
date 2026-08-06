/**
 * browser-redirect-guard.ts — the CDP response-stage half of the browser lane's egress policy.
 *
 * Role: owns `attachBrowserRedirectGuard` + `authorizeBrowserRedirectHop`, which decide redirect
 * hops at the CDP response stage, pre-egress. This is the PRIMARY redirect enforcement, because
 * Playwright never routes redirect hops — see the function docs below for the mechanism. Its
 * sibling `browser-route-policy.ts` owns everything decidable from the request itself (origins,
 * package-local file reads, popup suppression, document downgrades), and
 * `browser-network-state.ts` holds the evidence sink both layers mutate so receipts can report
 * every refusal with its reason class.
 *
 * Together they honor SECURITY.md's "redirects are revalidated, and HTTPS downgrade is refused".
 *
 * Dependencies: playwright-core types and ./browser-network-state. Primary callers: index.ts
 * `acquireContext` (guard attach) and the render paths that surface the evidence sink into receipt
 * warnings. index.ts re-exports the public pieces, so the package API surface is unchanged.
 */
import type { BrowserContext, Page } from "playwright-core";
import { remoteOrigin, type BrowserFrameNetworkState } from "./browser-network-state";

/** HTTP statuses Chromium follows via the Location header; every other response passes untouched. */
const BROWSER_REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * Structural slice of the CDP `Fetch.requestPaused` payload the redirect guard consumes. Declared
 * locally because playwright-core does not expose its protocol type definitions through the
 * package `exports` map, and the guard only reads these four fields anyway.
 */
interface BrowserRedirectPausedEvent {
  requestId: string;
  request: { url: string };
  responseStatusCode?: number;
  responseHeaders?: Array<{ name: string; value: string }>;
}

/**
 * Attaches the browser lane's redirect guard: a dedicated CDP Fetch session that pauses every
 * response of `page` at the response-headers stage and refuses redirect responses whose target
 * violates the network policy — BEFORE Chromium issues the follow-up request.
 *
 * Why routing alone cannot enforce this: Playwright only runs route handlers for the FIRST request
 * of a redirect chain. When a continued request answers with a 3xx, Playwright auto-continues each
 * subsequent hop at the CDP layer without consulting routes (playwright-core 1.61 `_onRequest`
 * sends `Fetch.continueRequest` unconditionally for paused events carrying `redirectedFrom`). The
 * route handler therefore never sees redirect hops, so on its own it cannot honor SECURITY.md's
 * "redirects are revalidated, and HTTPS downgrade is refused" invariant for this lane — an
 * approved origin's server could redirect an in-flight request onto cleartext HTTP, or onto any
 * other resolvable destination, and the hop went out on the wire unchecked.
 *
 * Pausing at the Response stage closes that hole pre-egress: the 3xx and its Location header are
 * inspected while the follow-up request does not exist yet, so failing the paused response means
 * the refused hop is never sent at all. A second CDP session with its own Fetch interception
 * coexists with Playwright's request-stage interception — separate sessions intercept at separate
 * stages (verified empirically against the bundled Chromium; browser-redirect-downgrade.test.ts
 * carries the in-repo wiring proof, including a hit counter on the redirect target's server).
 *
 * SCOPE, stated precisely: this session guards exactly ONE target — `page`. It does not and cannot
 * cover a popup or any other secondary target, which is why popups are suppressed outright at the
 * route layer (`browser-route-policy.ts`, `requestOrigination`) rather than guarded here.
 *
 * Called inside the pooled-context setup try block, so an attach failure discards the context: the
 * pooled page never renders without the guard. A guard that dies LATER is a different failure, and
 * silence is the worst possible answer to it — so `Inspector.detached`, `Target.detachedFromTarget`
 * and page closure are all recorded on whichever frame state is leased at the time, which turns a
 * lost guard into a receipt warning instead of an unexplained `passed`.
 *
 * @param context Pooled context owning `page`; the CDP session is opened through it.
 * @param page The worker page whose responses are guarded.
 * @param allowedOrigins Host-approved origins; every redirect target is revalidated against them.
 * @param currentNetworkState Reads the worker's currently leased per-frame evidence sink. Between
 *   leases it returns undefined and redirects are refused without evidence — fail closed, matching
 *   the route handler's stateless abort.
 */
export async function attachBrowserRedirectGuard(
  context: BrowserContext,
  page: Page,
  allowedOrigins: ReadonlySet<string>,
  currentNetworkState: () => BrowserFrameNetworkState | undefined
): Promise<void> {
  const cdp = await context.newCDPSession(page);
  // Both send helpers swallow failures: a paused request can die with its page or context mid-
  // teardown, and a rejected send inside a CDP event listener would otherwise surface as an
  // unhandled rejection. Once the target is gone there is nothing left to enforce.
  const continueResponse = async (requestId: string) => {
    try {
      await cdp.send("Fetch.continueResponse", { requestId });
    } catch { /* request or page already gone */ }
  };
  const failRequest = async (requestId: string) => {
    try {
      await cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
    } catch { /* request or page already gone */ }
  };
  // Failsafe. Between leases `currentNetworkState()` is undefined, so ordinary teardown (and
  // `lease.discard()`, which clears the lease before closing the context) records nothing; only a
  // guard that dies while a frame is actually rendering leaves evidence.
  let guardLost = false;
  const recordGuardLoss = (reason: string) => {
    if (guardLost) return;
    guardLost = true;
    currentNetworkState()?.redirectGuardFailures.push(reason);
  };
  cdp.on("Inspector.detached", () => recordGuardLoss("redirect guard CDP session detached"));
  cdp.on("Target.detachedFromTarget", () => recordGuardLoss("redirect guard CDP target detached"));
  page.once("close", () => recordGuardLoss("guarded page closed"));
  page.once("crash", () => recordGuardLoss("guarded page crashed"));
  cdp.on("Fetch.requestPaused", (event: BrowserRedirectPausedEvent) => {
    void (async () => {
      const status = event.responseStatusCode;
      const location = event.responseHeaders?.find((header) => header.name.toLowerCase() === "location")?.value;
      if (status === undefined || !BROWSER_REDIRECT_STATUS_CODES.has(status) || location === undefined) {
        await continueResponse(event.requestId);
        return;
      }
      const state = currentNetworkState();
      const verdict = state === undefined
        ? "abort"
        : authorizeBrowserRedirectHop(event.request.url, location, allowedOrigins, state);
      if (verdict === "continue") {
        await continueResponse(event.requestId);
      } else {
        await failRequest(event.requestId);
      }
    })();
  });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Response" }] });
}

/**
 * Authorizes one redirect hop at the moment its 3xx response is paused, before Chromium issues the
 * follow-up request. This is the PRIMARY enforcement point for the browser lane's redirect policy:
 *
 * - An HTTPS->HTTP scheme downgrade is refused even when the cleartext destination origin is
 *   itself host-approved. Approving `https://a` and `http://b` as direct targets must not let the
 *   remote server at `a` silently move an in-flight request onto cleartext: SECURITY.md promises
 *   "redirects are revalidated, and HTTPS downgrade is refused" for deliberate network access, and
 *   the core source-import and workbench-update fetch paths refuse the same transition
 *   unconditionally — the browser lane holds the same line, with no override input. The non-3xx
 *   shapes of the same transition (`Refresh:` header, `<meta http-equiv=refresh>`, scripted
 *   `location` writes) never reach this function; `browser-route-policy.ts` refuses those.
 * - Every redirect target must be a host-approved origin. Non-redirect requests are already
 *   origin-checked by the route handler, and approved origins are DNS-resolved and address-pinned
 *   at preflight (--host-resolver-rules), so requiring membership here preserves the destination-
 *   origin, DNS, and pinned-address validation for every hop.
 *
 * No chain memory is needed for the downgrade rule: every followed hop's redirect response passes
 * through this guard, so if any HTTPS ancestor had redirected toward cleartext, that transition
 * was already refused at its own response — by induction, a hop whose current URL is `http:` can
 * only exist in a chain that never left cleartext, and the current hop's scheme is sufficient
 * state.
 *
 * Refusals are recorded on `state` with their reason class preserved — downgrades under
 * `blockedDowngradeRedirects`, unapproved targets under `blockedRequests` — so receipt warnings
 * state exactly why a hop was refused.
 *
 * @param currentUrl Absolute URL of the request whose 3xx response is paused.
 * @param locationHeader Raw Location header value; resolved against `currentUrl` like Chromium
 *   would, so relative redirects are judged by their absolute target.
 * @param allowedOrigins Host-approved origins from the prepared network policy.
 * @param state Per-frame evidence sink mutated with the reason for any refusal.
 * @returns "continue" to let Chromium follow the redirect, "abort" to refuse it pre-egress.
 */
export function authorizeBrowserRedirectHop(
  currentUrl: string,
  locationHeader: string,
  allowedOrigins: ReadonlySet<string>,
  state: BrowserFrameNetworkState
): "continue" | "abort" {
  const currentOrigin = remoteOrigin(currentUrl);
  let target: URL;
  try {
    target = new URL(locationHeader, currentUrl);
  } catch {
    // Chromium would fail an unresolvable Location on its own, but refusing it here keeps the
    // guard total and puts the stopped redirect on the receipt instead of a silent network error.
    state.blockedRequests.push(`${currentOrigin ?? currentUrl} (unparseable redirect location)`);
    return "abort";
  }
  const targetOrigin = `${target.protocol}//${target.host}`;
  if (target.protocol === "http:" && currentOrigin !== null && currentOrigin.startsWith("https://")) {
    // Checked before the approved-origin membership test on purpose: the downgrade refusal must
    // win even when the cleartext destination origin is individually approved — an approved
    // destination is exactly the case the invariant exists for.
    state.blockedDowngradeRedirects.push(`${currentOrigin} -> ${targetOrigin}`);
    return "abort";
  }
  if (allowedOrigins.has(targetOrigin)) return "continue";
  // Covers unapproved http(s) targets and non-http(s) schemes alike (a data:/blob:/ftp: target can
  // never be an approved origin): the hop is an undeclared request that must not egress.
  state.blockedRequests.push(targetOrigin);
  return "abort";
}
