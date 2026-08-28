import { describe, expect, it } from "vitest";
import { authorizeBrowserRouteRequest, createBrowserDocumentSchemeMemory, type BrowserRoutePolicy, type RoutedBrowserRequest } from "./browser-route-policy";
import type { BrowserFrameNetworkState } from "./browser-network-state";

const RENDER_PAGE = { id: "render" };

function state(): BrowserFrameNetworkState {
  return { blockedRequests: [], blockedWebSocketRequests: [], blockedExternalFileRequest: false, blockedDowngradeRedirects: [], blockedSecondaryPages: [], blockedForeignPageRequests: [], redirectGuardFailures: [] };
}

function policy(approvedAgentEntryUrl?: string): BrowserRoutePolicy {
  return { allowedOrigins: new Set(), packageRootPath: "/nonexistent", renderPage: RENDER_PAGE, documentScheme: createBrowserDocumentSchemeMemory(), ...(approvedAgentEntryUrl ? { approvedAgentEntryUrl } : {}) };
}

function documentRequest(url: string): RoutedBrowserRequest {
  const frame = { url: () => "about:blank", page: () => RENDER_PAGE, parentFrame: () => null };
  return { url: () => url, redirectedFrom: () => null, isNavigationRequest: () => true, frame: () => frame };
}

describe("approved-agent-entry main-document pinning", () => {
  it("allows only the initial canonical entry and records every top-level replacement mechanism", async () => {
    const entry = "data:text/html,approved-entry";
    for (const mechanism of ["location assignment", "meta refresh", "form submit", "history replace", "window.open/opener interaction"]) {
      const evidence = { ...state(), approvedAgentEntryInitialNavigationPending: true };
      await expect(authorizeBrowserRouteRequest(documentRequest(entry), policy(entry), evidence)).resolves.toBe("continue");
      await expect(authorizeBrowserRouteRequest(documentRequest(`data:text/html,${encodeURIComponent(mechanism)}`), policy(entry), evidence)).resolves.toBe("abort");
      expect(evidence.blockedApprovedEntryNavigations).toEqual(["top_level_document"]);
    }
  });

  it("leaves data-only document navigation on the existing route policy", async () => {
    await expect(authorizeBrowserRouteRequest(documentRequest("data:text/html,data-only-navigation"), policy(), state())).resolves.toBe("continue");
  });
});
