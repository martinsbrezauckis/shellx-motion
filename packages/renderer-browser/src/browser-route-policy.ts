/**
 * browser-route-policy.ts — the decision function behind the browser lane's Playwright route
 * interception, plus the two pieces of per-frame state that decision needs.
 *
 * Role: everything the lane can refuse BEFORE a request leaves Chromium, judged from the request
 * itself: package-local `file:` containment, host-approved origins, popup/secondary-page
 * suppression, and the HTTPS->HTTP downgrade invariant in both of its shapes (a redirect chain and
 * a fresh document navigation). The sibling module `browser-redirect-guard.ts` owns the CDP
 * response-stage half, which is the only place a 3xx hop can be judged.
 *
 * Extracted from browser-redirect-guard.ts (itself extracted from index.ts) so both enforcement
 * modules stay inside the module-size ratchet in scripts/module-size-gate.mjs. Dependencies:
 * ./browser-network-state and the canonical-path helpers in ./browser-package-safety. Primary
 * caller: index.ts `acquireContext`, whose route handler maps the verdict onto
 * `route.continue()` / `route.abort("blockedbyclient")`.
 */
import { fileURLToPath } from "node:url";
import { remoteOrigin, type BrowserFrameNetworkState } from "./browser-network-state";
import { canonicalPathForBrowserSafety, isPathInsideOrEqual } from "./browser-package-safety";

/**
 * Minimal structural slice of Playwright's `Frame` that route authorization reads. `page()` is
 * typed `unknown` on purpose: the policy only ever compares it by identity against the page the
 * caller declared as the render page, and typing it as Playwright's `Page` would drag a
 * playwright-core type into a module the unit tests drive with synthetic objects.
 */
export interface RoutedBrowserFrame {
  url(): string;
  page(): unknown;
  /** Playwright supplies this for real frames; null identifies the one top-level capture frame. */
  parentFrame?(): RoutedBrowserFrame | null;
}

/**
 * Minimal structural slice of Playwright's `Request` that route authorization needs. Declared
 * locally instead of importing Playwright's `Request` type so the decision logic can be exercised
 * by tests with synthetic redirect chains; a real Playwright `Request` satisfies this shape.
 *
 * `isNavigationRequest` and `frame` are optional because the redirect-chain unit tests build bare
 * `{ url, redirectedFrom }` objects. Their ABSENCE means "this is not a real browser request", not
 * "the check passed" — see `requestOrigination` for how that distinction is kept fail-closed.
 */
export interface RoutedBrowserRequest {
  url(): string;
  /** The previous request in the redirect chain that produced this one, or null for the first hop. */
  redirectedFrom(): RoutedBrowserRequest | null;
  isNavigationRequest?(): boolean;
  frame?(): RoutedBrowserFrame | null;
  /** Playwright resource kind; optional so synthetic redirect tests remain minimal. */
  resourceType?(): string;
}

/**
 * Remembers, per frame, the most recent `https:` document origin that frame was allowed to load.
 *
 * Needed because a refused navigation leaves the frame showing `chrome-error://chromewebdata/`,
 * and Chromium may re-issue the navigation from there. At that point `frame.url()` no longer looks
 * secure, so a check that trusted only the live frame URL would let the retry through — measured:
 * the first attempt was refused and the second reached the cleartext server. The memory makes the
 * invariant a property of the frame's history instead of its current URL, which is what
 * "an HTTPS document may not become an HTTP document" actually means.
 */
export interface BrowserDocumentSchemeMemory {
  rememberSecureDocument(frame: object, origin: string): void;
  secureDocumentOrigin(frame: object): string | undefined;
}

/** Builds a {@link BrowserDocumentSchemeMemory}; frames are held weakly so closed frames are collected. */
export function createBrowserDocumentSchemeMemory(): BrowserDocumentSchemeMemory {
  const secureFrames = new WeakMap<object, string>();
  return {
    rememberSecureDocument: (frame, origin) => { secureFrames.set(frame, origin); },
    secureDocumentOrigin: (frame) => secureFrames.get(frame)
  };
}

/** Inputs the route decision is made against; all of them are per-render-session, not per-request. */
export interface BrowserRoutePolicy {
  allowedOrigins: ReadonlySet<string>;
  /** Canonical package root; `file:` reads may not escape it. */
  packageRootPath: string;
  /**
   * Optional renderer-owned fulfillment admission.  When supplied the caller
   * serves a verified byte snapshot for every admitted file request instead of
   * allowing Chromium to reopen the pathname after this policy returns.
   */
  packageFileUrlPermitted?: (url: string) => boolean;
  /**
   * The one page whose pixels become the frame. Requests from any other page are refused — see
   * `requestOrigination`. Required rather than optional so a caller cannot wire the route handler
   * and silently leave popup suppression off.
   */
  renderPage: unknown;
  documentScheme: BrowserDocumentSchemeMemory;
  /** An attested entry may run inline, but may never load a second executable resource. */
  denySecondaryExecutableRequests?: boolean;
  /** Host-derived canonical URL for the one approved main document, when active. */
  approvedAgentEntryUrl?: string;
}

/**
 * Per-request authorization for the browser lane's Playwright route interception:
 *
 * - Requests from any page other than `policy.renderPage` are refused outright (popups, new
 *   windows). See `requestOrigination` for why this, and not guard attachment, is the fix.
 * - `file:` requests may only read package-local assets (canonical-path containment).
 * - `data:`/`blob:` URLs carry no network egress and always continue.
 * - A document navigation that would move a frame from HTTPS to cleartext HTTP is refused even
 *   when the destination origin is host-approved, and even when nothing about the request says
 *   "redirect" — `Refresh:` headers, `<meta http-equiv=refresh>` and scripted `location` writes
 *   all produce a fresh first request with `redirectedFrom() === null`.
 * - A request whose redirect chain downgraded from HTTPS to cleartext HTTP is refused the same way.
 * - Remaining remote requests must target a host-approved origin (also DNS-pinned via
 *   --host-resolver-rules).
 * - A URL that cannot be parsed into an origin at all is refused: there is nothing left to check
 *   it against, and this function has no override input.
 *
 * Layering note: on current Playwright this handler only ever sees the FIRST request of a redirect
 * chain — subsequent hops are auto-continued at the CDP layer without consulting routes — so the
 * redirect-chain walk here cannot be the enforcement point for the no-downgrade invariant. That
 * enforcement lives in `attachBrowserRedirectGuard`/`authorizeBrowserRedirectHop`, which refuses a
 * violating hop at the 3xx response, before it egresses. The chain walk here is deliberate defense
 * in depth: if a future Playwright starts routing redirect hops (each carrying `redirectedFrom()`),
 * the same policy holds at this layer too instead of silently regressing to origin-only checks.
 *
 * Refusals are recorded on `state` (with the reason class preserved) so the render receipt reports
 * what was blocked; the caller maps "abort" onto `route.abort("blockedbyclient")`, so a refused
 * request never leaves Chromium. Fails closed: there is no override input.
 *
 * @param request Current, possibly redirected, request being authorized.
 * @param policy Session-wide inputs: approved origins, package root, render page, scheme memory.
 * @param state Per-frame evidence sink mutated with the reason for any refusal.
 * @returns "continue" to let this request proceed, "abort" to refuse it.
 */
export async function authorizeBrowserRouteRequest(
  request: RoutedBrowserRequest,
  policy: BrowserRoutePolicy,
  state: BrowserFrameNetworkState
): Promise<"continue" | "abort"> {
  const url = request.url();
  const frame = requestOrigination(request, policy.renderPage);
  if (frame === "foreign") {
    state.blockedForeignPageRequests.push(remoteOrigin(url) ?? url);
    return "abort";
  }
  if (policy.approvedAgentEntryUrl && approvedEntryReplacement(request, frame, policy.approvedAgentEntryUrl, state)) {
    (state.blockedApprovedEntryNavigations ??= []).push("top_level_document");
    return "abort";
  }
  const executableKind = policy.denySecondaryExecutableRequests ? secondaryExecutableKind(request) : undefined;
  if (executableKind) {
    (state.blockedSecondaryCodeRequests ??= []).push(executableKind);
    return "abort";
  }
  if (url.startsWith("file:")) {
    const permitted = policy.packageFileUrlPermitted
      ? policy.packageFileUrlPermitted(url)
      : await isPackageLocalFileUrl(url, policy.packageRootPath);
    if (permitted) return "continue";
    state.blockedExternalFileRequest = true;
    return "abort";
  }
  // Both downgrade checks run before the approved-origin membership test on purpose: the downgrade
  // refusal must win even when the cleartext destination origin is individually approved — an
  // approved destination is exactly the case the invariant exists for.
  const documentDowngrade = frame === "not-applicable" ? null : httpsDocumentDowngrade(request, frame, policy.documentScheme);
  const downgrade = documentDowngrade ?? httpsToHttpRedirectDowngrade(request);
  if (downgrade) {
    state.blockedDowngradeRedirects.push(downgrade);
    return "abort";
  }
  const origin = remoteOrigin(url);
  if (url.startsWith("data:") || url.startsWith("blob:")) return "continue";
  if (!origin) {
    // Fails closed, matching the redirect guard's unparseable-Location arm: an unparseable URL
    // cannot be checked against anything, so it cannot be shown to be admissible.
    state.blockedRequests.push(`${url} (unparseable request URL)`);
    return "abort";
  }
  if (!policy.allowedOrigins.has(origin)) {
    state.blockedRequests.push(origin);
    return "abort";
  }
  if (frame !== "not-applicable" && origin.startsWith("https://") && isDocumentNavigation(request)) {
    policy.documentScheme.rememberSecureDocument(frame, origin);
  }
  return "continue";
}

function secondaryExecutableKind(request: RoutedBrowserRequest): "script" | "worker" | "document" | undefined {
  if (typeof request.resourceType !== "function") return undefined;
  try {
    const kind = request.resourceType();
    if (kind === "script" || kind === "worker") return kind;
    if (kind !== "document" || !isDocumentNavigation(request) || typeof request.frame !== "function") return undefined;
    const frame = request.frame();
    // A real main-frame navigation has a null parent. A secondary document can execute inline
    // script from a package file without issuing a script request, so it must not become a side
    // door around the one attested entry. If the frame shape cannot prove top-level status, refuse.
    if (!frame || typeof frame.parentFrame !== "function") return "document";
    return frame.parentFrame() === null ? undefined : "document";
  } catch {
    // An unreadable resource kind is not permission to treat it as executable.
    return "script";
  }
}

/** Allows exactly the host-initiated entry load; every later main-document replacement is refused. */
function approvedEntryReplacement(
  request: RoutedBrowserRequest,
  frame: RoutedBrowserFrame | "not-applicable",
  approvedEntryUrl: string,
  state: BrowserFrameNetworkState
): boolean {
  if (frame === "not-applicable" || !isDocumentNavigation(request)) return false;
  try {
    if (typeof frame.parentFrame !== "function") return true;
    if (frame.parentFrame() !== null) return false;
    if (state.approvedAgentEntryInitialNavigationPending === true && new URL(request.url()).href === approvedEntryUrl) {
      state.approvedAgentEntryInitialNavigationPending = false;
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

/**
 * Decides whether a request may be attributed to the render page.
 *
 * Why this is the popup fix. The response-stage redirect guard is a CDP session bound to ONE
 * target; a popup is a different target, so redirect hops inside a popup were enforced by nobody
 * and produced no evidence — measured: a `window.open()` onto an approved redirector reached a
 * never-approved origin with attacker-chosen data while the receipt stayed `passed` with zero
 * warnings. Attaching a guard from `context.on("page")` does not close it: the attach is async and
 * the popup's first request is already in flight by the time the session exists (measured: the
 * egress still landed). Playwright's route handler, by contrast, DOES see a popup's very first
 * request — the popup target is paused until interception is installed — so refusing here is
 * race-free.
 *
 * Suppression rather than guarding is also the honest product answer: a frame render screenshots
 * exactly one page, so a popup can never contribute a pixel to the output. It is pure attack
 * surface, and an unwanted capability is best removed rather than policed.
 *
 * @returns The originating frame when the request belongs to the render page; `"foreign"` when it
 *   belongs to another page, has no frame, or the frame cannot be read (all fail closed); and
 *   `"not-applicable"` when `request` exposes no `frame()` at all, which only happens for the
 *   synthetic request objects the redirect-chain unit tests build — a real Playwright request
 *   always has one.
 */
function requestOrigination(request: RoutedBrowserRequest, renderPage: unknown): RoutedBrowserFrame | "foreign" | "not-applicable" {
  if (typeof request.frame !== "function") return "not-applicable";
  try {
    const frame = request.frame();
    if (!frame) return "foreign";
    return frame.page() === renderPage ? frame : "foreign";
  } catch {
    return "foreign";
  }
}

/** True when the request is a document navigation (Playwright's own predicate), false otherwise. */
function isDocumentNavigation(request: RoutedBrowserRequest): boolean {
  if (typeof request.isNavigationRequest !== "function") return false;
  try {
    return request.isNavigationRequest();
  } catch {
    return false;
  }
}

/**
 * Detects an HTTPS document turning into an HTTP document, with no redirect involved.
 *
 * `authorizeBrowserRedirectHop` covers 3xx responses and the chain walk below covers requests that
 * carry a `redirectedFrom()`. Neither sees the other ways a page moves itself: a `Refresh:`
 * response header, `<meta http-equiv=refresh>`, or a scripted `location` write each produce a
 * FRESH first request whose `redirectedFrom()` is null, so the request was judged on origin
 * membership alone and a cleartext hop went out unremarked — measured against real TLS, for both
 * the header and the meta tag, with both origins approved. This closes that gap by asking the
 * question the invariant actually asks: is the frame that is navigating currently (or was it
 * previously) an HTTPS document?
 *
 * Subresources are deliberately out of scope: mixed content is Chromium's own boundary and it
 * blocks those before they reach the network. The invariant here is about documents.
 *
 * @returns `"https://from-origin -> http://to-origin"` for the receipt, or null.
 */
function httpsDocumentDowngrade(
  request: RoutedBrowserRequest,
  frame: RoutedBrowserFrame,
  memory: BrowserDocumentSchemeMemory
): string | null {
  if (!isDocumentNavigation(request)) return null;
  const destination = remoteOrigin(request.url());
  if (!destination || !destination.startsWith("http://")) return null;
  const currentOrigin = remoteOrigin(frame.url());
  if (currentOrigin !== null && currentOrigin.startsWith("https://")) return `${currentOrigin} -> ${destination}`;
  const priorSecureOrigin = memory.secureDocumentOrigin(frame);
  return priorSecureOrigin === undefined ? null : `${priorSecureOrigin} -> ${destination}`;
}

/**
 * Detects an HTTPS->HTTP scheme downgrade anywhere in the redirect chain that produced `request`
 * (the defense-in-depth arm of the invariant — see the layering note on
 * `authorizeBrowserRouteRequest`; the pre-egress arm is `authorizeBrowserRedirectHop`).
 *
 * The walk inspects the whole chain, not just the immediate predecessor, so a downgrade laundered
 * through intermediate cleartext hops (https -> http -> http) is still caught. Origins are parsed
 * through `remoteOrigin` rather than matched with raw string prefixes so scheme casing and
 * lookalike schemes (`httpx:`) cannot slip past, and the returned transition is origin-level —
 * redirect locations can carry sensitive query strings, and receipts must never embed them
 * (threat model TM-007: redirect-chain logging with sensitive query redaction).
 *
 * @returns `"https://from-origin -> http://to-origin"` for the receipt, or null when the chain
 *   never left HTTPS (or the current hop is not cleartext HTTP at all).
 */
function httpsToHttpRedirectDowngrade(request: RoutedBrowserRequest): string | null {
  const destination = remoteOrigin(request.url());
  if (!destination || !destination.startsWith("http://")) return null;
  // Chromium enforces its own redirect ceiling (20 hops); the explicit bound only guarantees
  // termination if a synthetic or hostile chain ever reports a cycle.
  let prior = request.redirectedFrom();
  for (let hop = 0; prior !== null && hop < 64; hop += 1, prior = prior.redirectedFrom()) {
    const priorOrigin = remoteOrigin(prior.url());
    if (priorOrigin !== null && priorOrigin.startsWith("https://")) {
      return `${priorOrigin} -> ${destination}`;
    }
  }
  return null;
}

/**
 * True when `url` is a file: URL whose canonical path stays inside the package root. Any parse or
 * canonicalization failure answers false — the caller treats that as a refusal.
 */
async function isPackageLocalFileUrl(url: string, packageRootPath: string): Promise<boolean> {
  try {
    const filePath = fileURLToPath(url);
    const targetPath = await canonicalPathForBrowserSafety(filePath);
    return isPathInsideOrEqual(packageRootPath, targetPath);
  } catch {
    return false;
  }
}
