/**
 * browser-redirect-downgrade.test.ts — regression coverage for the browser lane's
 * HTTPS->HTTP redirect-downgrade refusal and per-hop redirect revalidation.
 *
 * Previously observed failure mode, fixed before 0.1.0: browser redirect authorization did not track or
 * reject an HTTPS-to-HTTP scheme downgrade. Investigating the fix exposed the deeper mechanism:
 * Playwright only routes the FIRST request of a redirect chain — it auto-continues every
 * subsequent hop at the CDP layer — so the route handler's origin check never ran for redirect
 * hops at all, contradicting SECURITY.md's "redirects are revalidated, and HTTPS downgrade is
 * refused" invariant, which the core source-import and workbench-update fetch paths already
 * enforce unconditionally.
 *
 * The fix therefore has two layers, and so does this coverage:
 *
 * 1. PRIMARY — `authorizeBrowserRedirectHop`, called by the response-stage CDP guard when a 3xx
 *    is paused, before the follow-up request exists. Unit tests drive it directly, including the
 *    exact approved-HTTPS -> approved-HTTP transition from the finding (a real HTTPS hop cannot
 *    be staged against the plain-HTTP local servers a test suite can run).
 * 2. DEFENSE IN DEPTH — `authorizeBrowserRouteRequest`, the route handler's decision function,
 *    which walks `redirectedFrom()` chains so the policy also holds if a future Playwright ever
 *    starts routing redirect hops.
 * 3. WIRING — live-Chromium tests prove the guard is attached on the shipped render path: a
 *    redirect from an approved origin to an unapproved origin is refused PRE-EGRESS (the target
 *    server's hit counter stays at zero) and receipted, while an approved HTTP->HTTP redirect
 *    adds no network-policy warning (the downgrade rule does not false-positive on redirects
 *    that never left cleartext). Browser HTML typography retains its separate unverified warning.
 */
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadMotionPackage } from "@shellx-motion/core";
import { canonicalPathForBrowserSafety } from "./browser-package-safety";
import { htmlTypographyWarning } from "./typography-attestation";
import {
  authorizeBrowserRedirectHop,
  authorizeBrowserRouteRequest,
  createHostBoundBrowserFrameRenderer,
  createBrowserDocumentSchemeMemory,
  type BrowserFrameNetworkState,
  type BrowserRoutePolicy,
  type RoutedBrowserRequest
} from "./index";
import { TEST_APPROVED_AGENT_SCRIPT_AUTHORITY } from "./test-support/approved-agent-script-authority";

const tempDirs: string[] = [];
const hostBoundBrowserFrameRenderer = createHostBoundBrowserFrameRenderer({ agentScriptAuthority: TEST_APPROVED_AGENT_SCRIPT_AUTHORITY });

function renderBrowserFrame(pkg: Parameters<typeof hostBoundBrowserFrameRenderer>[0], options: Parameters<typeof hostBoundBrowserFrameRenderer>[1]) {
  return hostBoundBrowserFrameRenderer(pkg, options);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Builds a synthetic redirect chain: the last URL is the current request, earlier URLs its prior hops. */
function redirectChain(...urls: string[]): RoutedBrowserRequest {
  let request: RoutedBrowserRequest | null = null;
  for (const url of urls) {
    const priorHop: RoutedBrowserRequest | null = request;
    request = { url: () => url, redirectedFrom: () => priorHop };
  }
  if (!request) throw new Error("redirectChain needs at least one URL.");
  return request;
}

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

/** The render page identity these cases are judged against; see `renderPagePolicy` for the pair. */
const RENDER_PAGE = { id: "render-page" };

function remotePolicy(...allowedOrigins: string[]): BrowserRoutePolicy {
  // packageRootPath is only consulted for file: URLs, which these remote-request cases never send.
  return {
    allowedOrigins: new Set(allowedOrigins),
    packageRootPath: "/nonexistent-package-root",
    renderPage: RENDER_PAGE,
    documentScheme: createBrowserDocumentSchemeMemory()
  };
}

/**
 * Builds a request that reports a real originating frame, which is what a live Playwright request
 * always does. `redirectChain` deliberately omits `frame()` so the pure redirect-chain cases stay
 * synthetic; these helpers are for the rules that read the frame (popup suppression and the
 * document-downgrade invariant).
 */
function framedRequest(url: string, frame: { url(): string; page(): unknown }, navigation = true): RoutedBrowserRequest {
  return { url: () => url, redirectedFrom: () => null, isNavigationRequest: () => navigation, frame: () => frame };
}

/** A frame currently showing `documentUrl` and belonging to `page` (defaults to the render page). */
function frameOn(documentUrl: string, page: unknown = RENDER_PAGE): { url(): string; page(): unknown } {
  return { url: () => documentUrl, page: () => page };
}

describe("redirect hop authorization (primary, response-stage)", () => {
  it("refuses an approved HTTPS origin redirecting to a separately approved HTTP origin", () => {
    // The finding's exact attack path: BOTH origins are host-approved, so an origin-membership
    // check alone would continue the cleartext hop. The downgrade refusal must win anyway.
    const state = freshNetworkState();

    const verdict = authorizeBrowserRedirectHop(
      "https://secure.example/asset.css",
      "http://cleartext.example/asset.css",
      new Set(["https://secure.example", "http://cleartext.example"]),
      state
    );

    expect(verdict).toBe("abort");
    expect(state.blockedDowngradeRedirects).toEqual(["https://secure.example -> http://cleartext.example"]);
    expect(state.blockedRequests).toEqual([]);
  });

  it("records a downgrade onto an unapproved cleartext origin as a downgrade, not as undeclared", () => {
    // Refusal-class precision: the receipt must state WHY the hop was refused, and the downgrade
    // is the more specific violation.
    const state = freshNetworkState();

    const verdict = authorizeBrowserRedirectHop(
      "https://secure.example/a",
      "http://unapproved.example/b",
      new Set(["https://secure.example"]),
      state
    );

    expect(verdict).toBe("abort");
    expect(state.blockedDowngradeRedirects).toEqual(["https://secure.example -> http://unapproved.example"]);
    expect(state.blockedRequests).toEqual([]);
  });

  it("refuses a redirect to an unapproved origin and records it as undeclared", () => {
    // The per-hop origin revalidation SECURITY.md promises: without it, an approved origin's
    // server could bounce the request to any resolvable destination.
    const state = freshNetworkState();

    const verdict = authorizeBrowserRedirectHop(
      "http://cleartext.example/a",
      "http://unapproved.example/b",
      new Set(["http://cleartext.example"]),
      state
    );

    expect(verdict).toBe("abort");
    expect(state.blockedRequests).toEqual(["http://unapproved.example"]);
    expect(state.blockedDowngradeRedirects).toEqual([]);
  });

  it("resolves relative Location headers against the redirecting URL", () => {
    // Chromium resolves Location relative to the current URL; the guard must judge the same
    // absolute target Chromium would follow, and a same-origin relative redirect stays approved.
    const state = freshNetworkState();

    const verdict = authorizeBrowserRedirectHop(
      "https://secure.example/nested/asset.css",
      "/moved/asset.css",
      new Set(["https://secure.example"]),
      state
    );

    expect(verdict).toBe("continue");
    expect(state).toEqual(freshNetworkState());
  });

  it("keeps approved HTTPS->HTTPS redirects working", () => {
    const state = freshNetworkState();

    const verdict = authorizeBrowserRedirectHop(
      "https://secure.example/a",
      "https://other-secure.example/b",
      new Set(["https://secure.example", "https://other-secure.example"]),
      state
    );

    expect(verdict).toBe("continue");
    expect(state).toEqual(freshNetworkState());
  });

  it("keeps approved HTTP->HTTP redirects working", () => {
    // A chain that never left cleartext is not a downgrade; both ends stay the host's explicit,
    // deliberate approval.
    const state = freshNetworkState();

    const verdict = authorizeBrowserRedirectHop(
      "http://cleartext.example/a",
      "http://other-cleartext.example/b",
      new Set(["http://cleartext.example", "http://other-cleartext.example"]),
      state
    );

    expect(verdict).toBe("continue");
    expect(state).toEqual(freshNetworkState());
  });

  it("keeps HTTP->HTTPS upgrade redirects to approved origins working", () => {
    const state = freshNetworkState();

    const verdict = authorizeBrowserRedirectHop(
      "http://cleartext.example/a",
      "https://secure.example/b",
      new Set(["http://cleartext.example", "https://secure.example"]),
      state
    );

    expect(verdict).toBe("continue");
    expect(state).toEqual(freshNetworkState());
  });

  it("refuses a non-http(s) redirect target", () => {
    // A data:/blob:/ftp: target can never be an approved origin; the membership rule fails it
    // closed rather than trusting Chromium's own handling of exotic Location targets.
    const state = freshNetworkState();

    const verdict = authorizeBrowserRedirectHop(
      "https://secure.example/a",
      "data:text/html,<script>1</script>",
      new Set(["https://secure.example"]),
      state
    );

    expect(verdict).toBe("abort");
    expect(state.blockedRequests).toEqual(["data://"]);
    expect(state.blockedDowngradeRedirects).toEqual([]);
  });

  it("refuses an unparseable Location header and receipts the refusal", () => {
    const state = freshNetworkState();

    const verdict = authorizeBrowserRedirectHop(
      "https://secure.example/a",
      "https://",
      new Set(["https://secure.example"]),
      state
    );

    expect(verdict).toBe("abort");
    expect(state.blockedRequests).toEqual(["https://secure.example (unparseable redirect location)"]);
  });
});

describe("browser route redirect-downgrade refusal (defense in depth)", () => {
  it("refuses an approved HTTPS origin redirecting to a separately approved HTTP origin", async () => {
    // The finding's exact attack path: BOTH origins are host-approved, so the pre-fix
    // per-origin check continued the cleartext hop. The downgrade refusal must win anyway.
    const state = freshNetworkState();

    const verdict = await authorizeBrowserRouteRequest(
      redirectChain("https://secure.example/asset.css", "http://cleartext.example/asset.css"),
      remotePolicy("https://secure.example", "http://cleartext.example"),
      state
    );

    expect(verdict).toBe("abort");
    expect(state.blockedDowngradeRedirects).toEqual(["https://secure.example -> http://cleartext.example"]);
    expect(state.blockedRequests).toEqual([]);
  });

  it("refuses a downgrade laundered through an intermediate cleartext hop", async () => {
    // Defense in depth for the chain walk: the HTTPS hop need not be the immediate predecessor.
    const state = freshNetworkState();

    const verdict = await authorizeBrowserRouteRequest(
      redirectChain("https://secure.example/a", "http://relay.example/b", "http://cleartext.example/c"),
      remotePolicy("https://secure.example", "http://relay.example", "http://cleartext.example"),
      state
    );

    expect(verdict).toBe("abort");
    expect(state.blockedDowngradeRedirects).toEqual(["https://secure.example -> http://cleartext.example"]);
  });

  it("records a downgrade onto an unapproved cleartext origin as a downgrade, not as undeclared", async () => {
    // Refusal-class precision: the receipt must state WHY a request was refused. A downgrade is
    // reported as a downgrade even when the destination would also have failed the origin check.
    const state = freshNetworkState();

    const verdict = await authorizeBrowserRouteRequest(
      redirectChain("https://secure.example/a", "http://unapproved.example/b"),
      remotePolicy("https://secure.example"),
      state
    );

    expect(verdict).toBe("abort");
    expect(state.blockedDowngradeRedirects).toEqual(["https://secure.example -> http://unapproved.example"]);
    expect(state.blockedRequests).toEqual([]);
  });

  it("keeps approved HTTPS->HTTPS redirects working", async () => {
    const state = freshNetworkState();

    const verdict = await authorizeBrowserRouteRequest(
      redirectChain("https://secure.example/a", "https://other-secure.example/b"),
      remotePolicy("https://secure.example", "https://other-secure.example"),
      state
    );

    expect(verdict).toBe("continue");
    expect(state).toEqual(freshNetworkState());
  });

  it("keeps HTTP->HTTPS upgrade redirects to approved origins working", async () => {
    const state = freshNetworkState();

    const verdict = await authorizeBrowserRouteRequest(
      redirectChain("http://cleartext.example/a", "https://secure.example/b"),
      remotePolicy("http://cleartext.example", "https://secure.example"),
      state
    );

    expect(verdict).toBe("continue");
    expect(state).toEqual(freshNetworkState());
  });

  it("keeps a direct request to an explicitly approved cleartext origin working", async () => {
    // Approving an http origin as a DIRECT target stays the host's deliberate, explicit choice.
    // The invariant refuses only the silent in-flight transition off HTTPS.
    const state = freshNetworkState();

    const verdict = await authorizeBrowserRouteRequest(
      redirectChain("http://cleartext.example/pixel.svg"),
      remotePolicy("http://cleartext.example"),
      state
    );

    expect(verdict).toBe("continue");
    expect(state).toEqual(freshNetworkState());
  });

  it("still refuses an unapproved origin and records it as undeclared", async () => {
    // Extraction equivalence: moving the decision out of the inline route handler must not have
    // changed the pre-existing origin rule or its evidence class.
    const state = freshNetworkState();

    const verdict = await authorizeBrowserRouteRequest(
      redirectChain("http://unapproved.example/x"),
      remotePolicy("https://secure.example"),
      state
    );

    expect(verdict).toBe("abort");
    expect(state.blockedRequests).toEqual(["http://unapproved.example"]);
    expect(state.blockedDowngradeRedirects).toEqual([]);
  });

  it("still continues data: URLs without recording anything", async () => {
    const state = freshNetworkState();

    const verdict = await authorizeBrowserRouteRequest(
      redirectChain("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>"),
      remotePolicy(),
      state
    );

    expect(verdict).toBe("continue");
    expect(state).toEqual(freshNetworkState());
  });

  it("still confines file: requests to the package root", async () => {
    // Extraction equivalence for the file: branch, with real canonicalized paths.
    const packageRoot = await mkdtemp(join(tmpdir(), "shellx-motion-downgrade-pkg-"));
    const externalRoot = await mkdtemp(join(tmpdir(), "shellx-motion-downgrade-ext-"));
    tempDirs.push(packageRoot, externalRoot);
    await writeFile(join(packageRoot, "inside.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>", "utf8");
    await writeFile(join(externalRoot, "outside.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>", "utf8");
    const canonicalRoot = await canonicalPathForBrowserSafety(packageRoot);
    const policy: BrowserRoutePolicy = {
      allowedOrigins: new Set<string>(),
      packageRootPath: canonicalRoot,
      renderPage: RENDER_PAGE,
      documentScheme: createBrowserDocumentSchemeMemory()
    };

    const insideState = freshNetworkState();
    const insideVerdict = await authorizeBrowserRouteRequest(
      redirectChain(pathToFileURL(join(packageRoot, "inside.svg")).href),
      policy,
      insideState
    );
    const outsideState = freshNetworkState();
    const outsideVerdict = await authorizeBrowserRouteRequest(
      redirectChain(pathToFileURL(join(externalRoot, "outside.svg")).href),
      policy,
      outsideState
    );

    expect(insideVerdict).toBe("continue");
    expect(insideState).toEqual(freshNetworkState());
    expect(outsideVerdict).toBe("abort");
    expect(outsideState.blockedExternalFileRequest).toBe(true);
  });

  it("remembers an approved HTTPS document before refusing its later cleartext navigation", async () => {
    // A failed navigation leaves Chromium on chrome-error://, so frame.url() no longer proves that
    // it was secure. The per-frame memory must retain the prior approved document origin rather
    // than allowing a retry to reach an otherwise approved cleartext destination.
    const state = freshNetworkState();
    const frame = frameOn("chrome-error://chromewebdata/");
    const policy = remotePolicy("https://secure.example", "http://cleartext.example");

    await expect(authorizeBrowserRouteRequest(
      framedRequest("https://secure.example/first-document", frame),
      policy,
      state
    )).resolves.toBe("continue");

    await expect(authorizeBrowserRouteRequest(
      framedRequest("http://cleartext.example/retry", frame),
      policy,
      state
    )).resolves.toBe("abort");
    expect(state.blockedDowngradeRedirects).toEqual(["https://secure.example -> http://cleartext.example"]);
  });
});

describe("browser redirect revalidation wiring (live Chromium)", () => {
  it("refuses a redirect to an unapproved origin pre-egress and receipts it", async () => {
    // Load-bearing wiring proof: the response-stage guard must be attached on the shipped render
    // path and must refuse the hop BEFORE it egresses. Playwright's route handler cannot provide
    // this (it never sees redirect hops), so without the guard this redirect would load silently:
    // exactly what happened before the fix. The hit counter is the pre-egress evidence — a
    // post-hoc detector would still record a warning, but the target server would have been hit.
    let redirectTargetHits = 0;
    const redirectTarget = createServer((_req, res) => {
      redirectTargetHits += 1;
      res.writeHead(200, { "content-type": "image/svg+xml" });
      res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#ef4444"/></svg>`);
    });
    const unapprovedOrigin = await listen(redirectTarget);
    const redirector = createServer((_req, res) => {
      res.writeHead(302, { location: `${unapprovedOrigin}/pixel.svg` });
      res.end();
    });
    const approvedOrigin = await listen(redirector);
    const root = await writeRedirectingBrowserPackage(approvedOrigin, [approvedOrigin]);
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-browser-redirect-block-"));
    tempDirs.push(root, outDir);

    try {
      const result = await renderBrowserFrame(pkg, {
        atMs: 0,
        outDir,
        networkAccess: { approvedOrigins: [approvedOrigin], allowPrivateNetwork: true }
      });

      expect(result.receipt.status).toBe("warning");
      expect(result.receipt.warnings).toContain(`Blocked undeclared browser request: ${unapprovedOrigin}`);
      expect(redirectTargetHits).toBe(0);
    } finally {
      await closeServer(redirector);
      await closeServer(redirectTarget);
    }
  }, 45_000);

  it("follows an approved cross-origin HTTP redirect without network warnings", async () => {
    // False-positive check on the real path: an approved HTTP->HTTP redirect never left
    // cleartext, so the response-stage guard must continue it and the frame must render clean —
    // both hops origin-approved, no downgrade, no warnings.
    const redirectTarget = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/svg+xml" });
      res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#22c55e"/></svg>`);
    });
    const targetOrigin = await listen(redirectTarget);
    const redirector = createServer((_req, res) => {
      res.writeHead(302, { location: `${targetOrigin}/pixel.svg` });
      res.end();
    });
    const sourceOrigin = await listen(redirector);
    const root = await writeRedirectingBrowserPackage(sourceOrigin, [sourceOrigin, targetOrigin]);
    const pkg = await loadMotionPackage(root);
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-browser-redirect-allow-"));
    tempDirs.push(root, outDir);

    try {
      const result = await renderBrowserFrame(pkg, {
        atMs: 0,
        outDir,
        networkAccess: { approvedOrigins: [sourceOrigin, targetOrigin], allowPrivateNetwork: true }
      });

      expect(result.receipt.status).toBe("warning");
      expect(result.receipt.warnings).toEqual([htmlTypographyWarning()]);
    } finally {
      await closeServer(redirector);
      await closeServer(redirectTarget);
    }
  }, 45_000);
});

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
 * Writes a minimal browser package whose HTML requests `${requestOrigin}/redirect.svg` — an
 * endpoint the caller's local server answers with a 302 — so the render exercises a real
 * cross-origin redirect chain through the shipped route handler.
 */
async function writeRedirectingBrowserPackage(requestOrigin: string, declaredOrigins: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-browser-redirect-package-"));
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_browser_redirect",
      name: "Browser Redirect",
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
      id: "motion_browser_redirect",
      name: "Browser Redirect",
      durationMs: 1000,
      fps: 30,
      width: 320,
      height: 180,
      background: "#ffffff",
      layers: [
        { id: "web-card", type: "web", source: "card.html", startMs: 0, durationMs: 1000, allowedOrigins: declaredOrigins }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "card.html"),
    `<!doctype html><html><body data-composition-id="browser-redirect" data-start="0" data-duration="1000"><main data-layer-id="title" data-start="0" data-duration="1000" style="font: 32px sans-serif">Redirect chain</main><img src="${requestOrigin}/redirect.svg" width="8" height="8"></body></html>\n`
  );
  return root;
}
